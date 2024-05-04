import * as Http from "@effect/platform/HttpClient";
import { Effect, pipe, Duration, Schedule, Array, Console, Random, identity, RateLimiter } from "effect";
import * as S from "@effect/schema"
import { NodeRuntime } from "@effect/platform-node";
import { DevTools } from "@effect/experimental"

interface RetryAfterHeadersSchema extends S.Schema.Schema<
  {
    /** milliseconds to wait before retrying */
    readonly "retryAfter"?: number | undefined;
  },
  Readonly<Record<string, string | undefined>>
>{}

interface RetryPolicy {
  <A, R>(_: Effect.Effect<A, Http.error.RequestError | Http.error.ResponseError, R>):
    Effect.Effect<A, Http.error.RequestError | Http.error.ResponseError, R>
}

interface RequestsRateLimiterConfig {
  /** schema to parse the headers of the response to extract the retry-after header */
  readonly retryAfterHeadersSchema?: RetryAfterHeadersSchema;
  /** retry policy to apply when a 429 is detected */
  readonly retryPolicy?: RetryPolicy;
  /** rate limiter to only allow n starting requests */
  readonly rateLimiter?: RateLimiter.RateLimiter;
  /** max number of concurrent requests */
  readonly maxConcurrentRequests?: number;
}

// TODO: shoud it be scoped like the default one because I'm creating and using some semaphores?
function makeRequestsRateLimiter(config: RequestsRateLimiterConfig) {
  return pipe(
    Effect.all({
      gate: Effect.makeSemaphore(1),
      concurrencyLimiter: Effect.fromNullable(config.maxConcurrentRequests)
        .pipe(Effect.flatMap(Effect.makeSemaphore), Effect.catchAll(_ => Effect.succeed(void 0)))
    }),
    Effect.map(({ gate, concurrencyLimiter }) => (req: Http.request.ClientRequest) => pipe(
        // to enter the "critical section" we must scquire the sole permit and promptly
        // release it to allow other requests to proceed;
        // the semaphore acts as an implicit queue (gate) for the requests that are waiting
        // to be handled after a 429 has been detected
        gate.withPermits(1)(Effect.void),
        Effect.zipRight(concurrencyLimiter ? concurrencyLimiter.withPermits(1)(req) : req),
        req => config.rateLimiter?.(req) ?? req,
        Effect.catchTag("ResponseError", err => Effect.gen(function* ($) {
          const headers = config.retryAfterHeadersSchema ? yield* $(
            err.response,
            Http.response.schemaHeaders(config.retryAfterHeadersSchema),
            Effect.catchAll(_ => err) // ignore parse error, just return the original error
          ) : {}

          const { retryAfter } = headers

          if(err.response.status === 429 && retryAfter) {
            const now = new Date().getTime()

            // close the gate for the amount of time specified in the header
            yield* gate.withPermits(1)(Effect.gen(function* () {
              const elapsedTime = new Date().getTime() - now

              // close together requests might have got a 429,
              // but we want to wait only once, or the minimum time possible
              //
              // older requests won't produce a delay because the elapsed time will be big enough;
              // a small number of nearby requests will result in only a single delay, or perhaps a bit more, and this is good;
              // many close requests will result in only a single delay too, that means that retrying after the delay will result in other 429s;
              if(elapsedTime < retryAfter) {
                const timeToWait = retryAfter - elapsedTime
                yield* Effect.sleep(Duration.millis(timeToWait))
              }
            }))
          }

          // return the original error, so that the retry policy can be applied
          return yield* err
        })),
        config.retryPolicy ?? identity
    ))
  )
}

// helper

export const logTime = Effect
  .sync(() => `${new Date().toISOString()}`)
  .pipe(Effect.andThen(Console.log))

// test

const RetryAfterHeadersSchema = S.Schema.Struct({
  "retryAfter": S.Schema.transform(
    S.Schema.NumberFromString,
    S.Schema.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.Schema.optional(),
    S.Schema.fromKey("retry-after"),
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
    retryAfterHeadersSchema: RetryAfterHeadersSchema,
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