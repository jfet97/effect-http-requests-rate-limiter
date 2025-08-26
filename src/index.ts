import { HttpClient, type HttpClientError, HttpClientResponse } from "@effect/platform"
import { Context, Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter, Schema as S } from "effect"
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

/**
 * Events that can be shared across rate limiter instances through persistency layer.
 */
export interface RateLimitEvent {
  /** Type of rate limit event */
  readonly type: "gate_close" | "gate_open" | "quota_exhausted" | "rate_limit_429"
  /** Duration to wait (for gate_close and quota_exhausted events) */
  readonly duration?: Duration.Duration
  /** Timestamp when the event occurred */
  readonly timestamp: Duration.Duration
  /** Optional context about the event (e.g., which API endpoint) */
  readonly context?: string
}

/**
 * Abstract interface for sharing rate limit state across multiple instances.
 *
 * @remarks
 * This interface allows rate limiter instances to communicate with each other
 * across different environments (demo vs prod) or processes. Implementations
 * can use Redis, databases, or other persistence mechanisms.
 */
export interface PersistencyLayer {
  /**
   * Publish a rate limit event to be shared with other instances.
   */
  readonly publishEvent: (event: RateLimitEvent) => Effect.Effect<void>

  /**
   * Subscribe to rate limit events from other instances.
   * Returns an Effect that yields events as they arrive.
   */
  readonly subscribeToEvents: Effect.Effect<Queue.Queue<RateLimitEvent>>

  /**
   * Get the current shared quota state for a specific context.
   * Returns remaining requests and reset time if available.
   */
  readonly getSharedQuota: (context?: string) => Effect.Effect<{
    readonly remaining?: number
    readonly resetsAt?: Duration.Duration
  }>

  /**
   * Update the shared quota state for a specific context.
   */
  readonly updateSharedQuota: (
    remaining: number,
    resetsAt: Duration.Duration,
    context?: string
  ) => Effect.Effect<void>
}

/**
 * Tag for PersistencyLayer service in Effect Context.
 */
export const PersistencyLayer = Context.GenericTag<PersistencyLayer>(
  "@effect-http-requests-rate-limiter/PersistencyLayer"
)

export interface Config {
  /** Schema for parsing rate limit headers from HTTP responses */
  readonly rateLimiterHeadersSchema: HeadersSchema
  /** Effect rate limiter to control the number of concurrent outgoing requests */
  readonly effectRateLimiter?: RateLimiter.RateLimiter
  /** Maximum number of concurrent requests allowed */
  readonly maxConcurrentRequests?: number
  /**
   * Optional persistency layer for sharing rate limit state across instances.
   * When provided, allows communication between different rate limiter instances
   * (e.g., demo vs prod environments) through the configured persistence mechanism.
   */
  readonly persistency?: PersistencyLayer
}

/**
 * Creates an HTTP client with rate limiting detection capabilities.
 *
 * @remarks
 * For automatic HTTP client resolution from context, use `makeWithContext` instead.
 *
 * @param config Configuration object specifying rate limiter behavior.
 * @param httpClient The underlying HTTP client to enhance.
 * @returns An enhanced HTTP client with rate limiting.
 */
export const make = Effect.fn(
  "makeHttpRequestsRateLimiter"
)(
  function*(httpClient: HttpClient.HttpClient, config: Config) {
    const handleResponseError = Effect.fn("HttpRequestsRateLimiter.handleResponseError")(
      function*(err: HttpClientError.ResponseError) {
        const headers = yield* parseHeaders(err.response)
        const { retryAfter } = headers
        if (
          err.response.status === 429 &&
          retryAfter != null
        ) {
          const startedAt = Duration.millis(Date.now())

          // Suggest to close the gate for the amount of time specified in the header
          yield* Effect.all([
            publishRateLimitEvent(
              { toWait: retryAfter, startedAt },
              {
                type: "rate_limit_429",
                duration: retryAfter,
                timestamp: startedAt
              }
            ),
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
      }
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
      // Using 1-permit semaphore instead of a latch:
      // 1. FIFO fairness
      // 2. avoids releasing all fibers at once causing contention/trashing
      gate: Effect.makeSemaphore(1),
      concurrencyLimiter: pipe(
        config.maxConcurrentRequests,
        Effect.fromNullable,
        Effect.andThen(Effect.makeSemaphore),
        Effect.orElseSucceed(() => void 0)
      ),
      pubsub: PubSub.unbounded<{ toWait: Duration.Duration; startedAt: Duration.Duration }>()
    }, { concurrency: 3 })

    // Helper function to publish events both locally and to persistency layer
    const publishRateLimitEvent = Effect.fn("HttpRequestsRateLimiter.publishRateLimitEvent")(
      function*(
        localEvent: { toWait: Duration.Duration; startedAt: Duration.Duration },
        persistentEvent: RateLimitEvent
      ) {
        // Publish locally
        yield* PubSub.publish(pubsub, localEvent)

        // Publish to persistency layer if configured
        if (config.persistency) {
          yield* config.persistency.publishEvent(persistentEvent)
        }
      }
    )

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
              ? Effect.logInfo(
                LogMessages.closingGate(
                  Duration.subtract(toWait, elapsedTime),
                  new Date(Duration.toMillis(now))
                )
              ).pipe(
                Effect.andThen(Effect.sleep(Duration.subtract(toWait, elapsedTime))),
                gate.withPermits(1),
                Effect.andThen(Effect.logInfo(LogMessages.gateIsOpen()))
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

    // If persistency is configured, also start a fiber to listen to external events
    if (config.persistency) {
      yield* pipe(
        config.persistency.subscribeToEvents,
        Effect.andThen((eventQueue) =>
          pipe(
            eventQueue,
            Queue.take,
            Effect.andThen((persistentEvent) => {
              if (
                persistentEvent.type === "gate_close" ||
                persistentEvent.type === "quota_exhausted" ||
                persistentEvent.type === "rate_limit_429"
              ) {
                const duration = persistentEvent.duration ?? Duration.zero
                if (Duration.greaterThan(duration, Duration.zero)) {
                  const localEvent = {
                    toWait: duration,
                    startedAt: persistentEvent.timestamp
                  }
                  return PubSub.publish(pubsub, localEvent).pipe(
                    Effect.andThen(Effect.logInfo(
                      `🌐 Received rate limit event from persistency layer: ${persistentEvent.type}`
                    ))
                  )
                }
              }
              return Effect.void
            }),
            Effect.forever
          )
        ),
        Effect.interruptible,
        Effect.forkScoped,
        Effect.withSpan("HttpRequestsRateLimiter.persistentEventListener")
      )
    }

    const enhancedHttpClient = httpClient.pipe(
      HttpClient.filterStatusOk,
      HttpClient.mapRequestInputEffect(
        Effect.fn("HttpRequestsRateLimiter.gateKeeping")(function*(req) {
          // Check shared quota state before proceeding if persistency is configured
          if (config.persistency) {
            const sharedQuota = yield* config.persistency.getSharedQuota().pipe(
              Effect.catchAll(() => Effect.succeed({ remaining: undefined, resetsAt: undefined }))
            )

            if (
              typeof sharedQuota.remaining === "number" &&
              sharedQuota.remaining === 0 &&
              sharedQuota.resetsAt != null
            ) {
              const now = Duration.millis(Date.now())
              if (Duration.lessThan(now, sharedQuota.resetsAt)) {
                // Quota is still exhausted, close gate until reset time
                const waitTime = Duration.subtract(sharedQuota.resetsAt, now)
                yield* publishRateLimitEvent(
                  { toWait: waitTime, startedAt: now },
                  {
                    type: "quota_exhausted",
                    duration: waitTime,
                    timestamp: now
                  }
                )
              }
            }
          }

          return yield* Effect.zipRight(
            gate.withPermits(1)(Effect.void),
            Effect.succeed(req)
          )
        })
      ),
      HttpClient.transformResponse((resEffect) =>
        resEffect.pipe(
          concurrencyLimiter?.withPermits(1) ?? identity,
          config.effectRateLimiter ?? identity,
          Effect.andThen(
            Effect.fn("HttpRequestsRateLimiter.checkQuota")(function*(res) {
              const headers = yield* parseHeaders(res)
              const { quotaResetsAfter, quotaRemainingRequests } = headers

              // Update shared quota state if persistency is configured and we have quota info
              if (
                config.persistency &&
                quotaResetsAfter != null &&
                typeof quotaRemainingRequests === "number"
              ) {
                const resetsAt = Duration.sum(Duration.millis(Date.now()), quotaResetsAfter)
                yield* config.persistency.updateSharedQuota(
                  quotaRemainingRequests,
                  resetsAt
                ).pipe(
                  Effect.catchAll((error) => Effect.logWarning(`Failed to update shared quota: ${String(error)}`))
                )
              }

              // Check if quota is exhausted and close gate if needed
              if (
                quotaResetsAfter != null &&
                typeof quotaRemainingRequests === "number" &&
                quotaRemainingRequests === 0
              ) {
                // Suggest to close the gate for the amount of time specified in the header
                const startedAt = Duration.millis(Date.now())
                yield* Effect.all([
                  publishRateLimitEvent(
                    { toWait: quotaResetsAfter, startedAt },
                    {
                      type: "quota_exhausted",
                      duration: quotaResetsAfter,
                      timestamp: startedAt
                    }
                  ),
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
          )
        )
      ),
      HttpClient.catchTag(
        "ResponseError",
        (x) => handleResponseError(x)
      )
    )

    return enhancedHttpClient
  }
)

/**
 * Creates a new instance using the provided configuration and an HTTP client from the context.
 *
 * @remarks
 * To provide an HTTP client manually instead of using context, use `make` instead.
 *
 * @param config - The configuration object to initialize the instance.
 * @returns An effect that yields the constructed instance with the given configuration and HTTP client.
 */
export const makeWithContext = (config: Config) =>
  HttpClient.HttpClient.pipe(Effect.andThen((httpClient) => make(httpClient, config)))
