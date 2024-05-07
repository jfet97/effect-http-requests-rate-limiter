import * as Http from "@effect/platform/HttpClient";
import { Effect, Duration, Schedule, Array, Console, Random, RateLimiter } from "effect";
import * as S from "@effect/schema"
import { NodeRuntime } from "@effect/platform-node";
import { DevTools } from "@effect/experimental"
import { makeRequestsRateLimiter, type RetryPolicy } from "../src/index.js";

// helper

export const logTime = Effect
  .sync(() => `${new Date().toISOString()}`)
  .pipe(Effect.andThen(Console.log))

// test

const RateLimitHeadersSchema = S.Schema.Struct({
  "retryAfterMillis": S.Schema.transform(
    S.Schema.NumberFromString,
    S.Schema.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.Schema.optional(),
    S.Schema.fromKey("retry-after"),
  ),
  "remainingRequestsQuota": S.Schema.NumberFromString.pipe(
    S.Schema.optional(),
    S.Schema.fromKey("x-ratelimit-remaining"),
  ),
  "resetAfterMillis": S.Schema.transform(
    S.Schema.NumberFromString,
    S.Schema.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.Schema.optional(),
    S.Schema.fromKey("x-ratelimit-reset"),
  ),
})

const RetryPolicy = Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5,
}) satisfies RetryPolicy

const RateLimiterCustom = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(5)
})

const req = Http.request.get("http://localhost:3000")

const main = Effect.gen(function* ($) {

  const rateLimiter = yield* RateLimiterCustom

  const requestRateLimiter = yield* makeRequestsRateLimiter({
    rateLimitHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: RetryPolicy,
    rateLimiter,
    maxConcurrentRequests: 3
  })

  const reqEffect = $(
    req,
    requestRateLimiter,
    Http.response.json,
    Effect.andThen(_ => Console.log(_)),
    Effect.andThen(logTime),
    Effect.catchAll(_ => Console.error(_.error))
  )

  yield* Effect.repeat(Effect.gen(function*($){
    // launch 10 requests every 4 seconds with random starting point
    const randomReq = $(
      Random.nextRange(0, 2000),
      Effect.andThen(Duration.millis),
      Effect.andThen(Effect.sleep),
      Effect.andThen(reqEffect)
    )

    yield* Effect.all(Array.makeBy(10, () => randomReq), { concurrency: "unbounded" })
    yield* Effect.sleep(Duration.seconds(4))
  }), Schedule.forever)
}).pipe(Effect.scoped)

NodeRuntime.runMain(main.pipe(
  // obs: fetchOk must be used so that non 2xx responses are considered errors
  Effect.provideService(Http.client.Client, Http.client.fetchOk),
  Effect.provide(DevTools.layer())
))