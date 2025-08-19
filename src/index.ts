import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter, Schema as S } from "effect"
import { LogMessages } from "./logs.js"

/**
 * Schema for HTTP headers related to rate limiting.
 *
 * @remarks
 * This schema describes the structure and types of headers used to communicate
 * rate limiting information, such as retry delays, remaining quota, and quota reset times.
 *
 * @property retryAfter - Optional duration to wait before retrying after receiving a 429 response.
 * @property quotaRemainingRequests - Optional number of requests remaining in the current quota window.
 *   When this reaches 0 and `quotaResetsAfter` is present, the gate will proactively close for that duration.
 * @property quotaResetsAfter - Optional duration until the quota window resets.
 */
export interface HeadersSchema extends
  S.Schema<
    {
      /**
       * Retry delay after a 429 (relative duration to wait before retrying).
       */
      readonly retryAfter?: Duration.Duration
      /**
       * Remaining request quota in the current window. When it reaches 0 and
       * `quotaResetsAfter` is present the gate will proactively close for that duration.
       */
      readonly quotaRemainingRequests?: S.Schema.Type<S.NonNegative>
      /**
       * Time until the quota window resets (relative duration).
       */
      readonly quotaResetsAfter?: Duration.Duration
    },
    Readonly<Record<string, string | undefined>>
  >
{}

export type HeaderFieldDescriptor<A> = {
  /** HTTP response header name (e.g. "retry-after") */
  readonly fromKey: string
  /** Schema decoding a single header value (string) to the target type */
  readonly schema: S.Schema<A, string>
}

/**
 * Utility to build the rate‑limit headers schema from header descriptors.
 *
 * Provide exactly one of these combinations:
 *  1. { retryAfter }
 *  2. { quotaRemainingRequests, quotaResetsAfter }
 *  3. { retryAfter, quotaRemainingRequests, quotaResetsAfter }
 *
 * Each descriptor supplies:
 *  - fromKey: actual HTTP header name
 *  - schema: Schema decoding the header string into the target domain type (Duration or NonNegative number)
 *
 * Returns a Schema that properly decodes a headers record.
 */
export function makeHeadersSchema(
  fields: {
    retryAfter: HeaderFieldDescriptor<Duration.Duration>
    quotaRemainingRequests?: never
    quotaResetsAfter?: never
  } | {
    retryAfter?: never
    quotaRemainingRequests: HeaderFieldDescriptor<S.Schema.Type<S.NonNegative>>
    quotaResetsAfter: HeaderFieldDescriptor<Duration.Duration>
  } | {
    retryAfter: HeaderFieldDescriptor<Duration.Duration>
    quotaRemainingRequests: HeaderFieldDescriptor<S.Schema.Type<S.NonNegative>>
    quotaResetsAfter: HeaderFieldDescriptor<Duration.Duration>
  }
): HeadersSchema {
  let schemaFields = {}
  if ("retryAfter" in fields) {
    schemaFields = {
      ...schemaFields,
      retryAfter: S.optional(fields.retryAfter.schema).pipe(S.fromKey(fields.retryAfter.fromKey))
    }
  }
  if ("quotaRemainingRequests" in fields) {
    schemaFields = {
      ...schemaFields,
      quotaRemainingRequests: S.optional(fields.quotaRemainingRequests.schema).pipe(
        S.fromKey(fields.quotaRemainingRequests.fromKey)
      )
    }
  }
  if ("quotaResetsAfter" in fields) {
    schemaFields = {
      ...schemaFields,
      quotaResetsAfter: S.optional(fields.quotaResetsAfter.schema).pipe(
        S.fromKey(fields.quotaResetsAfter.fromKey)
      )
    }
  }

  return S.Struct(schemaFields) as HeadersSchema
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
  /** HTTP client to use for making requests */
  httpClient: HttpClient.HttpClient
  /** Schema for parsing rate limit headers from HTTP responses */
  readonly rateLimiterHeadersSchema: HeadersSchema
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
    const httpClient = pipe(
      config.httpClient,
      HttpClient.filterStatusOk
    )

    const parseHeaders = (res: HttpClientResponse.HttpClientResponse) =>
      pipe(
        res,
        HttpClientResponse.schemaHeaders(config.rateLimiterHeadersSchema),
        Effect.tapErrorTag(
          "ParseError",
          (error) => Effect.logError(`Failed to parse rate limit headers: ${error.message}`)
        ),
        /*
          Header parsing is best-effort: if headers are missing or invalid we fall back to
          an empty object. We already log the parse error above for observability. This
          guarantees rate-limit hints never cause the underlying request to fail; only the
          retry policy / concurrency mechanisms continue to apply.
        */
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
      Effect.interruptible,
      Effect.forkScoped,
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
              const { quotaResetsAfter, quotaRemainingRequests } = headers
              if (
                quotaResetsAfter != null &&
                typeof quotaRemainingRequests === "number" &&
                quotaRemainingRequests === 0
              ) {
                // Suggest to close the gate for the amount of time specified in the header
                const startedAt = Duration.millis(Date.now())
                yield* Effect.all([
                  PubSub.publish(pubsub, { toWait: quotaResetsAfter, startedAt }),
                  Effect.logInfo(
                    LogMessages.suggestWait(
                      quotaResetsAfter,
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
