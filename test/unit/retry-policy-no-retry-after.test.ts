import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Duration, Effect, Schedule, Schema as S, TestClock } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"

describe("Retry Policy (no retry-after header)", () => {
  it.scoped("should succeed after retries when 429 responses lack retry-after", () =>
    Effect.gen(function*() {
      let count = 0
      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          count++
          // First two calls: 429 without retry-after header
          if (count < 3) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ error: true, n: count }), {
                status: 429,
                statusText: "Too Many Requests",
                headers: {}
              })
            )
          }
          // Third call succeeds
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ok: true, n: count }), {
              status: 200,
              statusText: "OK",
              headers: {}
            })
          )
        })
      )

      const retryPolicy = HttpRequestsRateLimiter.makeRetryPolicy(
        Effect.retry({
          schedule: Schedule.exponential("50 millis"),
          while: (err) => err._tag === "ResponseError" && err.response.status === 429,
          times: 2
        })
      )

      const limiter = yield* HttpRequestsRateLimiter.make({
        httpClient: mockClient,
        retryPolicy,
        rateLimiterHeadersSchema: S.Struct({})
      })

      const fiber = yield* Effect.fork(limiter.limit(HttpClientRequest.get("http://test.com")))
      // Advance enough simulated time for both retry delays (approx 50 + 100)
      yield* TestClock.adjust(Duration.millis(500))
      const res = yield* fiber
      expect(res.status).toBe(200)
      expect(count).toBe(3)
    }))
})
