import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Array, Duration, Effect, Layer, RateLimiter } from "effect"
import { bench, describe } from "vitest"
import * as HttpRequestsRateLimiter from "../../src/index.js"

// Micro-benchmark harness (indicativo). Usa Vitest bench per confrontare configurazioni.
// Esecuzione: pnpm vitest run test/performance/throughput.bench.ts --reporter=verbose

const baseClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.sync(() =>
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" })
        )
      )
    )
  )
)

const buildLimiter = (options: { maxConcurrentRequests?: number; effectRateLimiter?: RateLimiter.RateLimiter }) => {
  const cfg: any = {}
  if (options.maxConcurrentRequests !== undefined) cfg.maxConcurrentRequests = options.maxConcurrentRequests
  if (options.effectRateLimiter) cfg.effectRateLimiter = options.effectRateLimiter
  return HttpRequestsRateLimiter.make(cfg).pipe(Effect.provide(baseClientLayer))
}

const runBatch = (
  limiter: { limit: (r: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any, any> },
  count: number,
  url: string
) =>
  Effect.forEach(Array.makeBy(count, (i) => i), () => limiter.limit(HttpClientRequest.get(url)), {
    concurrency: "unbounded"
  })

describe("Throughput Benchmarks", () => {
  bench("baseline - no limits", async () => {
    await Effect.runPromise(Effect.scoped(
      buildLimiter({}).pipe(Effect.flatMap((limiter) => runBatch(limiter, 300, "http://bench/baseline")))
    ))
  })

  bench("semaphore only maxConcurrent=5", async () => {
    await Effect.runPromise(Effect.scoped(
      buildLimiter({ maxConcurrentRequests: 5 }).pipe(
        Effect.flatMap((limiter) => runBatch(limiter, 300, "http://bench/semaphore"))
      )
    ))
  })

  bench("rate tokens=40/s", async () => {
    await Effect.runPromise(Effect.scoped(
      RateLimiter.make({ limit: 40, algorithm: "fixed-window", interval: Duration.seconds(1) }).pipe(
        Effect.flatMap((rl) => buildLimiter({ effectRateLimiter: rl })),
        Effect.flatMap((limiter) => runBatch(limiter, 150, "http://bench/rate"))
      )
    ))
  })

  bench("combined tokens=40/s + maxConcurrent=5", async () => {
    await Effect.runPromise(Effect.scoped(
      RateLimiter.make({ limit: 40, algorithm: "fixed-window", interval: Duration.seconds(1) }).pipe(
        Effect.flatMap((rl) => buildLimiter({ effectRateLimiter: rl, maxConcurrentRequests: 5 })),
        Effect.flatMap((limiter) => runBatch(limiter, 150, "http://bench/combined"))
      )
    ))
  })
})
