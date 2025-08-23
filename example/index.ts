import { DevTools } from "@effect/experimental"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"

import { Array, Duration, Effect, Layer, pipe, Random, RateLimiter, Schedule, Schema as S } from "effect"
import * as HttpRequestsRateLimiter from "../src/index.js"

// helper

export const logTime = Effect
  .sync(() => new Date().toISOString())
  .pipe(Effect.andThen(Effect.log))

// test

const DurationFromSecondsString = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

const NonNegativeFromString = S.compose(S.NumberFromString, S.NonNegative)

const RateLimitHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema({
  retryAfter: { fromKey: "retry-after", schema: DurationFromSecondsString },
  quotaRemainingRequests: { fromKey: "x-ratelimit-remaining", schema: NonNegativeFromString },
  quotaResetsAfter: { fromKey: "x-ratelimit-reset", schema: DurationFromSecondsString }
})

const myRetryPolicy = HttpRequestsRateLimiter.makeRetryPolicy(Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5
}))

const EffectRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(10)
})

const req = HttpClientRequest.get("http://localhost:5678")

const main = Effect.gen(function*() {
  const rateLimiter = yield* EffectRateLimiter
  const httpClient = yield* HttpClient.HttpClient

  const requestsRateLimiter = yield* HttpRequestsRateLimiter.make({
    httpClient,
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: myRetryPolicy,
    effectRateLimiter: rateLimiter
    // maxConcurrentRequests: 4
  })

  const reqEffect = pipe(
    requestsRateLimiter.limit(req),
    Effect.andThen((_) => Effect.logInfo("Response received")),
    Effect.andThen(logTime),
    Effect.catchAll((err) => Effect.logError(err))
  )

  yield* Effect.repeat(
    Effect.gen(function*() {
      // launch 12 requests every 2 seconds with random starting point
      const randomReq = pipe(
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
  Effect.provide(Layer.merge(
    NodeHttpClient.layer,
    DevTools.layer()
  ))
))
