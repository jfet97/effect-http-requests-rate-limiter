import { DevTools } from "@effect/experimental"
import { HttpClientRequest } from "@effect/platform"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"

import { Array, Console, Duration, Effect, Random, RateLimiter, Schedule, Schema as S } from "effect"
import { makeRequestsRateLimiter, type RetryPolicy } from "../src/index.js"

// helper

export const logTime = Effect
  .sync(() => new Date().toISOString())
  .pipe(Effect.andThen(Console.log))

// test

const DurationFromSecondsString = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

export const RateLimitHeadersSchema = S.Struct({
  retryAfter: S.optional(DurationFromSecondsString).pipe(S.fromKey("retry-after")),
  remainingRequestsQuota: S.optional(S.compose(S.NumberFromString, S.NonNegative)).pipe(
    S.fromKey("x-ratelimit-remaining")
  ),
  resetAfter: S.optional(DurationFromSecondsString).pipe(S.fromKey("x-ratelimit-reset"))
})

const MyRetryPolicy = Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5
}) satisfies RetryPolicy

const MyRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(3)
})

const req = HttpClientRequest.get("http://localhost:3000")

const main = Effect.gen(function*($) {
  const rateLimiter = yield* MyRateLimiter

  const requestsRateLimiter = yield* makeRequestsRateLimiter({
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: MyRetryPolicy,
    effectRateLimiter: rateLimiter,
    maxConcurrentRequests: 4
  })

  const reqEffect = $(
    requestsRateLimiter.limit(req),
    Effect.andThen((_) => Console.log("Response received")),
    Effect.andThen(logTime),
    Effect.catchAll((err) => Console.error(err))
  )

  yield* Effect.repeat(
    Effect.gen(function*($) {
      // launch 12 requests every 2 seconds with random starting point
      const randomReq = $(
        Random.nextRange(0, 1000),
        Effect.andThen(Duration.millis),
        Effect.andThen(Effect.sleep),
        Effect.andThen(reqEffect)
      )

      yield* Effect.all(Array.makeBy(12, () => randomReq), { concurrency: "unbounded" })
      yield* Effect.sleep(Duration.seconds(2))
    }),
    Schedule.forever
  )
}).pipe(Effect.scoped)

NodeRuntime.runMain(main.pipe(
  Effect.provide(NodeHttpClient.layer),
  Effect.provide(DevTools.layer())
))
