import { DevTools } from "@effect/experimental"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeRuntime } from "@effect/platform-node"

import { Array, Console, Duration, Effect, Random, RateLimiter, Schedule, Schema as S } from "effect"
import { buildRequestsRateLimiter, type RetryPolicy } from "../src/index.js"

// helper

export const logTime = Effect
  .sync(() => new Date().toISOString())
  .pipe(Effect.andThen(Console.log))

// test

const RateLimitHeadersSchema = S.Struct({
  "retryAfterMillis": S.transform(
    S.NumberFromString,
    S.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.optional(),
    S.fromKey("retry-after")
  ),
  "remainingRequestsQuota": S.NumberFromString.pipe(
    S.optional(),
    S.fromKey("x-ratelimit-remaining")
  ),
  "resetAfterMillis": S.transform(
    S.NumberFromString,
    S.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.optional(),
    S.fromKey("x-ratelimit-reset")
  )
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

  const requestsRateLimiter = yield* buildRequestsRateLimiter({
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: MyRetryPolicy,
    effectRateLimiter: rateLimiter,
    maxConcurrentRequests: 4
  })


  const reqEffect = $(
    requestsRateLimiter.limit(req),
    HttpClientResponse.json,
    Effect.andThen((_) => Console.log(_)),
    Effect.andThen(logTime),
    Effect.catchAll((_) => Console.error(_.error))
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
  // obs: fetchOk must be used so that non 2xx responses are considered errors
  Effect.provideService(HttpClient.HttpClient, HttpClient.fetchOk),
  Effect.provide(DevTools.layer())
))
