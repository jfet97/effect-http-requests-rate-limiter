import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Console, Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter, type Schema as S } from "effect"
import { LogMessages } from "./logs.js"

export interface RateLimiterHeadersSchema extends
  S.Schema<
    {
      /** retry delay */
      readonly "retryAfter"?: Duration.DurationInput | undefined
      /** remaining request quota in the current window */
      readonly "remainingRequestsQuota"?: typeof S.NonNegative | undefined
      /** time until the rate limit window resets */
      readonly "resetAfter"?: Duration.DurationInput | undefined
    },
    Readonly<Record<string, string | undefined>>
  >
{}

export interface RateLimiterHeadersSchemaType extends S.Schema.Type<RateLimiterHeadersSchema> {}

export interface RetryPolicy {
  <A, R>(_: Effect.Effect<A, HttpClientError.HttpClientError, R>): Effect.Effect<A, HttpClientError.HttpClientError, R>
}

export interface RequestsRateLimiterConfig {
  /** schema for parsing rate limit headers from HTTP responses */
  readonly rateLimiterHeadersSchema?: RateLimiterHeadersSchema
  /** retry policy to use when rate limit is exceeded (429 status) */
  readonly retryPolicy?: RetryPolicy
  /** effect rate limiter to control the number of concurrent outgoing requests */
  readonly effectRateLimiter?: RateLimiter.RateLimiter
  /** maximum number of concurrent requests allowed */
  readonly maxConcurrentRequests?: number
}

export const makeRequestsRateLimiter = Effect.fn(
  "makeRequestsRateLimiter"
)(
  function*(config: RequestsRateLimiterConfig) {
    const httpClient = yield* HttpClient.HttpClient

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
        Effect.map((_) => _ satisfies RateLimiterHeadersSchemaType as RateLimiterHeadersSchemaType)
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
                )
              )
              : Effect.suspend(() =>
                Console.info(
                  LogMessages.ignoredSuggestedWait(toWait, new Date(Duration.toMillis(startedAt)))
                )
              )
          }),
          Effect.forever
        )
      ),
      Effect.forkScoped,
      Effect.interruptible
    )

    return {
      limit: (req: HttpClientRequest.HttpClientRequest) =>
        pipe(
          req,
          httpClient.execute,
          concurrencyLimiter?.withPermits(1) ?? identity,
          config.effectRateLimiter ?? identity,
          Effect.andThen(Effect.fnUntraced(function*(res) {
            const headers = yield* parseHeaders(res)

            const { resetAfter, remainingRequestsQuota } = headers

            if (
              resetAfter != null &&
              typeof remainingRequestsQuota === "number" &&
              remainingRequestsQuota === 0
            ) {
              // Suggest to close the gate for the amount of time specified in the header
              const startedAt = Duration.millis(Date.now())
              const resetDuration = Duration.decode(resetAfter)

              yield* Effect.all([
                PubSub.publish(pubsub, { toWait: resetDuration, startedAt }),
                Effect.logInfo(
                  LogMessages.suggestWait(
                    resetDuration,
                    new Date(Duration.toMillis(startedAt)),
                    "end_of_quota"
                  )
                )
              ], { concurrency: 2 })
            }

            return res
          })),
          // Wait for gate to be open before executing the request
          gate.whenOpen,
          Effect.catchTag(
            "ResponseError",
            Effect.fnUntraced(function*(err) {
              const headers = yield* parseHeaders(err.response)

              const { retryAfter } = headers

              if (
                err.response.status === 429 &&
                retryAfter != null
              ) {
                // Suggest to close the gate for the amount of time specified in the header
                const startedAt = Duration.millis(Date.now())
                const retryDuration = Duration.decode(retryAfter)

                yield* Effect.all([
                  PubSub.publish(pubsub, { toWait: retryDuration, startedAt }),
                  Console.info(
                    LogMessages.suggestWait(
                      retryDuration,
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
          config.retryPolicy ?? identity
        )
    }
  }
)
