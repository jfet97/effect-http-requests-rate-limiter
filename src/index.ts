import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter, type Schema as S } from "effect"
import { LogMessages } from "./logs.js"

export interface HeadersSchema extends
  S.Schema<
    {
      /** Retry delay */
      readonly "retryAfter"?: Duration.Duration | undefined
      /** Remaining request quota in the current window */
      readonly "remainingRequestsQuota"?: S.Schema.Type<S.NonNegative> | undefined
      /** Time until the rate limit window resets */
      readonly "resetAfter"?: Duration.Duration | undefined
    },
    Readonly<Record<string, string | undefined>>
  >
{}

export function makeHeadersSchema(s: HeadersSchema): HeadersSchema {
  return s
}

/**
 * Policy for retrying HTTP requests when they fail.
 * Applied after rate limiting errors (429) are handled by the gate mechanism.
 * Can implement exponential backoff, circuit breakers, or custom retry logic.
 */
export interface RetryPolicy {
  <A, R>(_: Effect.Effect<A, HttpClientError.HttpClientError, R>): Effect.Effect<A, HttpClientError.HttpClientError, R>
}

export function makeRetryPolicy(policy: RetryPolicy): RetryPolicy {
  return policy
}

export interface Config {
  /** Schema for parsing rate limit headers from HTTP responses */
  readonly rateLimiterHeadersSchema?: HeadersSchema
  /** Retry policy to use when rate limit is exceeded (429 status) */
  readonly retryPolicy?: RetryPolicy
  /** Effect rate limiter to control the number of concurrent outgoing requests */
  readonly effectRateLimiter?: RateLimiter.RateLimiter
  /** Maximum number of concurrent requests allowed */
  readonly maxConcurrentRequests?: number
}

export const make = Effect.fn(
  "makeHttpRequestsRateLimiter"
)(
  function*(config: Config) {
    const httpClient = yield* pipe(
      HttpClient.HttpClient,
      Effect.map(HttpClient.filterStatusOk)
    )

    const parseHeaders = (res: HttpClientResponse.HttpClientResponse) =>
      pipe(
        config.rateLimiterHeadersSchema,
        Effect.fromNullable,
        Effect.andThen((schema) => HttpClientResponse.schemaHeaders(schema)(res)),
        Effect.tapErrorTag(
          "ParseError",
          (error) => Effect.logError(`Failed to parse rate limit headers: ${error.message}`)
        ),
        // Swallow errors and return an empty object if headers are not present
        // to not block requests with additional details
        Effect.orElseSucceed(() => ({})),
        Effect.map((_) =>
          _ satisfies S.Schema.Type<HeadersSchema> as S.Schema.Type<
            HeadersSchema
          >
        ),
        Effect.withSpan("HttpRequestsRateLimiter.parseHeaders")
      )

    const { gate, concurrencyLimiter, pubsub } = yield* Effect.all({
      gate: Effect.makeLatch(true),
      concurrencyLimiter: pipe(
        config.maxConcurrentRequests,
        Effect.fromNullable,
        Effect.andThen(Effect.makeSemaphore),
        Effect.orElseSucceed(() => void 0)
      ),
      pubsub: PubSub.unbounded<{ toWait: Duration.Duration; startedAt: Duration.Duration }>()
    }, { concurrency: 3 })

    // Gate controller: closes the gate when rate limits are hit (429 status) or quota exhausted (remaining = 0)
    yield* pipe(
      pubsub,
      PubSub.subscribe,
      Effect.andThen((subscription) =>
        pipe(
          subscription,
          Queue.take,
          Effect.andThen(({ startedAt, toWait }) => {
            // Smart delay optimization for concurrent requests hitting rate limits.
            // Wait only the minimum necessary time to avoid cascading delays:
            //   1. Older requests skip delay if enough time has already elapsed
            //   2. Recent requests batch into a single delay period
            //   3. Multiple concurrent requests avoid redundant waiting
            //
            // This optimization applies to both 429 errors and quota exhaustion
            const now = Duration.millis(Date.now())
            const elapsedTime = Duration.subtract(now, startedAt)
            return Duration.lessThan(elapsedTime, toWait)
              ? pipe(
                Effect.all([
                  gate.close,
                  Effect.logInfo(
                    LogMessages.closingGate(
                      Duration.subtract(toWait, elapsedTime),
                      new Date(Duration.toMillis(now))
                    )
                  )
                ], { concurrency: 2 }),
                Effect.andThen(Effect.sleep(Duration.subtract(toWait, elapsedTime))),
                Effect.andThen(
                  Effect.all([
                    gate.open,
                    Effect.logInfo(LogMessages.gateIsOpen())
                  ], { concurrency: 2 })
                ),
                Effect.withSpan("HttpRequestsRateLimiter.gate.wait")
              )
              : pipe(
                Effect.logInfo(
                  LogMessages.ignoredSuggestedWait(toWait, new Date(Duration.toMillis(startedAt)))
                ),
                Effect.withSpan("HttpRequestsRateLimiter.gate.skipWait")
              )
          }),
          Effect.forever
        )
      ),
      Effect.forkScoped,
      Effect.interruptible,
      Effect.withSpan("HttpRequestsRateLimiter.gate.controllerFiber")
    )

    return {
      limit: (req: HttpClientRequest.HttpClientRequest) =>
        pipe(
          req,
          httpClient.execute,
          concurrencyLimiter?.withPermits(1) ?? identity,
          config.effectRateLimiter ?? identity,
          Effect.andThen(
            Effect.fn("HttpRequestsRateLimiter.limit.checkQuota")(function*(res) {
              const headers = yield* parseHeaders(res)
              const { resetAfter, remainingRequestsQuota } = headers
              if (
                resetAfter != null &&
                typeof remainingRequestsQuota === "number" &&
                remainingRequestsQuota === 0
              ) {
                // Suggest to close the gate for the amount of time specified in the header
                const startedAt = Duration.millis(Date.now())
                yield* Effect.all([
                  PubSub.publish(pubsub, { toWait: resetAfter, startedAt }),
                  Effect.logInfo(
                    LogMessages.suggestWait(
                      resetAfter,
                      new Date(Duration.toMillis(startedAt)),
                      "end_of_quota"
                    )
                  )
                ], { concurrency: 2 })
              }
              return res
            })
          ),
          // Wait for gate to be open before executing the request
          gate.whenOpen,
          Effect.catchTag(
            "ResponseError",
            Effect.fn("HttpRequestsRateLimiter.limit.handleResponseError")(function*(err) {
              const headers = yield* parseHeaders(err.response)
              const { retryAfter } = headers
              if (
                err.response.status === 429 &&
                retryAfter != null
              ) {
                const startedAt = Duration.millis(Date.now())

                // Suggest to close the gate for the amount of time specified in the header
                yield* Effect.all([
                  PubSub.publish(pubsub, { toWait: retryAfter, startedAt }),
                  Effect.logInfo(
                    LogMessages.suggestWait(
                      retryAfter,
                      new Date(Duration.toMillis(startedAt)),
                      "429"
                    )
                  )
                ], { concurrency: 2 })
              }
              // Yield the original error, so that the retry policy can be applied
              return yield* err
            })
          ),
          config.retryPolicy ?? identity,
          Effect.withSpan("HttpRequestsRateLimiter.limit")
        )
    }
  }
)
