import { type HttpClientError, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Console, Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter, type Schema as S } from "effect"
import { LogMessages } from "./logs.js"

export interface RateLimiterHeadersSchema extends
  S.Schema<
    {
      /** retry delay in milliseconds */
      readonly "retryAfterMillis"?: number | undefined
      /** remaining request quota in the current window */
      readonly "remainingRequestsQuota"?: number | undefined
      /** milliseconds until the rate limit window resets */
      readonly "resetAfterMillis"?: number | undefined
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
  /** rate limiter to control the number of concurrent outgoing requests */
  readonly effectRateLimiter?: RateLimiter.RateLimiter
  /** maximum number of concurrent requests allowed */
  readonly maxConcurrentRequests?: number
}

export function makeRequestsRateLimiter(config: RequestsRateLimiterConfig) {
  const parseHeaders = (res: HttpClientResponse.HttpClientResponse) =>
    pipe(
      config.rateLimiterHeadersSchema,
      Effect.fromNullable,
      Effect.andThen((schema) => HttpClientResponse.schemaHeaders(schema)(res)),
      Effect.catchAll((_) => Effect.succeed({})),
      Effect.map((_) => _ satisfies RateLimiterHeadersSchemaType)
    )

  return Effect.gen(function*($) {
    const { gate, concurrencyLimiter, pubsub } = yield* Effect.all({
      gate: Effect.makeSemaphore(1),
      concurrencyLimiter: pipe(
        config.maxConcurrentRequests,
        Effect.fromNullable,
        Effect.andThen(Effect.makeSemaphore),
        Effect.orElseSucceed(() => void 0)
      ),
      pubsub: PubSub.unbounded<{ toWait: number; now: Date }>()
    }, { concurrency: 3 })

    // close the gate after a 429 has been detected, or after a quota = 0 has been detected
    yield* $(
      pubsub,
      PubSub.subscribe,
      Effect.andThen((subscription) =>
        pipe(
          subscription,
          Queue.take,
          Effect.andThen(({ now, toWait }) => {
            // close together requests might have got a 429,
            // but we want to wait only once, or the minimum time possible:
            // 1. older requests won't produce a delay because the elapsed time will be big enough;
            // 2. a small number of nearby requests will result in only a single delay, or perhaps a bit more, and this is good;
            // 3. many close requests will result in only a single delay too, that means that retrying after the delay will result in other 429s;
            //
            // even after a quota 0 we want to wait for the minimum time possible
            const actualNow = new Date()
            const elapsedTime = actualNow.getTime() - now.getTime()
            return elapsedTime < toWait
              ? pipe(
                Console.info(LogMessages.closingGate(toWait - elapsedTime, actualNow)),
                Effect.andThen(Effect.sleep(Duration.millis(toWait - elapsedTime))),
                gate.withPermits(1),
                Effect.andThen(Effect.suspend(() => Console.info(LogMessages.gateIsOpen())))
              )
              : Effect.suspend(() => Console.info(LogMessages.ignoredSuggestedWait(toWait, now)))
          }),
          Effect.forever
        )
      ),
      Effect.forkScoped,
      Effect.interruptible
    )

    return (req: HttpClientRequest.HttpClientRequest) =>
      pipe(
        // to enter the "critical section" we must scquire the sole permit and promptly
        // release it to allow other requests to proceed;
        // the semaphore acts as an implicit queue (gate) for the requests that are waiting
        // to be handled after a 429 has been detected (or after quota = 0 has been detected)
        Effect.zipRight(gate.withPermits(1)(Effect.void), req),
        concurrencyLimiter?.withPermits(1) ?? identity,
        config.effectRateLimiter ?? identity,
        Effect.andThen((res) =>
          Effect.gen(function*($) {
            const headers = yield* parseHeaders(res)
              // ignore parse error, just return an empty object
              .pipe(
                Effect.orElseSucceed(
                  () => ({} satisfies RateLimitHeadersSchemaType)
                )
              )

            const { resetAfterMillis, remainingRequestsQuota } = headers

            if (
              typeof resetAfterMillis === "number" &&
              typeof remainingRequestsQuota === "number" &&
              remainingRequestsQuota === 0
            ) {
              // close the gate for the amount of time specified in the header
              const now = new Date()

              yield* $(
                PubSub.publish(pubsub, { toWait: resetAfterMillis, now }),
                Effect.andThen(Console.info(LogMessages.suggestWait(resetAfterMillis, now, "eoq")))
              )
            }

            return res
          })
        ),
        Effect.catchTag("ResponseError", (err) =>
          Effect.gen(function*($) {
            const headers = yield* parseHeaders(err.response)
              // ignore parse error, just return the original error
              .pipe(Effect.catchAll((_) => err))

            const { retryAfterMillis } = headers

            if (
              err.response.status === 429 &&
              typeof retryAfterMillis === "number"
            ) {
              // close the gate for the amount of time specified in the header
              const now = new Date()

              yield* $(
                PubSub.publish(pubsub, { toWait: retryAfterMillis, now }),
                Effect.andThen(Console.info(LogMessages.suggestWait(retryAfterMillis, now, "429")))
              )
            }

            // return the original error, so that the retry policy can be applied
            return yield* err
          })),
        config.retryPolicy ?? identity,
        (w) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          Object.setPrototypeOf(w, Object.getPrototypeOf(req))
          ;(w as any).method = req.method
          ;(w as any).url = req.url
          ;(w as any).urlParams = req.urlParams
          ;(w as any).hash = req.hash
          ;(w as any).headers = req.headers
          ;(w as any).body = req.body
          return w as HttpClientRequest.HttpClientRequest
        }
      )
  })
}
