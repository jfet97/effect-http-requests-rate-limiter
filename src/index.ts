import * as Http from "@effect/platform/HttpClient"
import type * as S from "@effect/schema"
import { Console, Duration, Effect, identity, pipe, PubSub, Queue, type RateLimiter } from "effect"
import { LogMessages } from "./logs.js"

export interface RateLimitHeadersSchema extends
  S.Schema.Schema<
    {
      /** milliseconds to wait before retrying */
      readonly "retryAfterMillis"?: number | undefined
      /** remaining requests quota in the current window */
      readonly "remainingRequestsQuota"?: number | undefined
      /** the milliseconds remaining in the current window */
      readonly "resetAfterMillis"?: number | undefined
    },
    Readonly<Record<string, string | undefined>>
  >
{}

export interface RateLimitHeadersSchemaType extends S.Schema.Schema.Type<RateLimitHeadersSchema> {}

export type RetryPolicy = <A, R>(
  _: Effect.Effect<A, Http.error.RequestError | Http.error.ResponseError, R>
) => Effect.Effect<A, Http.error.RequestError | Http.error.ResponseError, R>

export interface RequestsRateLimiterConfig {
  /** schema to parse the headers of the response to extract the retry-after header */
  readonly rateLimitHeadersSchema?: RateLimitHeadersSchema
  /** retry policy to apply when a 429 is detected */
  readonly retryPolicy?: RetryPolicy
  /** rate limiter to only allow n starting requests */
  readonly rateLimiter?: RateLimiter.RateLimiter
  /** max number of concurrent requests */
  readonly maxConcurrentRequests?: number
}

export function makeRequestsRateLimiter(config: RequestsRateLimiterConfig) {
  const parseHeaders = (res: Http.response.ClientResponse) => {
    return pipe(
      config.rateLimitHeadersSchema,
      Effect.fromNullable,
      Effect.andThen((schema) => Http.response.schemaHeaders(schema)(res)),
      Effect.catchTag("NoSuchElementException", (_) => Effect.succeed({})),
      Effect.map((_) => _ satisfies RateLimitHeadersSchemaType as RateLimitHeadersSchemaType)
    )
  }

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

    return (req: Http.request.ClientRequest) =>
      pipe(
        // to enter the "critical section" we must scquire the sole permit and promptly
        // release it to allow other requests to proceed;
        // the semaphore acts as an implicit queue (gate) for the requests that are waiting
        // to be handled after a 429 has been detected (or after quota = 0 has been detected)
        Effect.zipRight(gate.withPermits(1)(Effect.void), req),
        concurrencyLimiter?.withPermits(1) ?? identity,
        config.rateLimiter ?? identity,
        Effect.andThen((res) =>
          Effect.gen(function*($) {
            const headers = yield* parseHeaders(res)
              // ignore parse error, just return an empty object
              .pipe(
                Effect.orElseSucceed(
                  () => ({} satisfies RateLimitHeadersSchemaType as RateLimitHeadersSchemaType)
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
        config.retryPolicy ?? identity
      )
  })
}
