import * as Http from "@effect/platform/HttpClient";
import { Effect, pipe, Duration, Schedule, Array, Console, Random, type Scope} from "effect";
import * as S from "@effect/schema"
import { NodeRuntime } from "@effect/platform-node";

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

function makeRateLimiter(rahs: RetryAfterHeadersSchema, retryPolicy: RetryPolicy) {
  return pipe(
    Effect.makeSemaphore(1),
    Effect.map((sem) => (req: Http.request.ClientRequest) => Effect.gen(function*($){

      // to enter the "critical section" we must scquire the sole permit and promptly
      // release it to allow other requests to proceed;
      // the semaphore acts as an implicit queue for the requests that are waiting
      // to be handled after a 429 has been detected
      yield* sem.withPermits(1)(Effect.void)

      return yield* $(
        req,
        Effect.catchTag("ResponseError", err => Effect.gen(function* ($) {
          const headers = yield* $(
            err.response,
            Http.response.schemaHeaders(rahs),
            Effect.catchAll(_ => err) // ignore parse error, just return the original error
          )

          const retryAfter = headers.retryAfter

          if(err.response.status === 429 && retryAfter) {
            const now = new Date().getTime()

            yield* sem.withPermits(1)(Effect.gen(function* () {
              // block the semaphore for the amount of time specified in the header
              const elapsedTime = new Date().getTime() - now

              // close together requests might have got a 429,
              // but we want to wait only once, or the minimum time possible
              if(elapsedTime < retryAfter) {
                const timeToWait = retryAfter - elapsedTime
                yield* Console.log(`waiting ${timeToWait}ms`)
                yield* Effect.sleep(Duration.millis(timeToWait))
              }
            }))
          }

          // return the original error
          return yield* err
        })),
        retryPolicy
      )
    }))
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

const req = Http.request.get("http://localhost:3000")

const main = Effect.gen(function* ($) {
  const rateLimiter = yield* makeRateLimiter(RetryAfterHeadersSchema, RetryPolicy)

  const reqEffect = $(
    req,
    rateLimiter,
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
})

NodeRuntime.runMain(main.pipe(
  // obs: fetchOk must be used so that non 2xx responses are considered errors
  Effect.provideService(Http.client.Client, Http.client.fetchOk)
))