import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, RateLimiter, TestClock } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"

describe("Combined Limits (effectRateLimiter + maxConcurrentRequests)", () => {
  it.scoped("should respect both concurrency and rate window tokens", () =>
    Effect.gen(function*() {
      let active = 0
      let maxActive = 0
      let calls = 0
      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          active++
          maxActive = Math.max(maxActive, active)
          calls++
          // Simulate tiny processing delay
          yield* Effect.sleep(Duration.millis(10))
          active--
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ok: true, n: calls }), {
              status: 200,
              statusText: "OK",
              headers: {}
            })
          )
        })
      )

      const effectRateLimiter = yield* RateLimiter.make({
        limit: 2,
        algorithm: "fixed-window",
        interval: Duration.seconds(10)
      })

      const limiter = yield* HttpRequestsRateLimiter.make({
        httpClient: mockClient,
        effectRateLimiter,
        maxConcurrentRequests: 1
      })

      const req = () => limiter.limit(HttpClientRequest.get("http://test.com"))

      const f1 = yield* Effect.fork(req())
      const f2 = yield* Effect.fork(req())
      const f3 = yield* Effect.fork(req())

      // Advance a bit so first completes and second runs consuming 2nd token
      yield* TestClock.adjust(Duration.millis(50))
      const r1 = yield* Fiber.join(f1)
      const r2 = yield* Fiber.join(f2)
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)

      // Third should still be waiting for new window
      const poll3 = yield* Fiber.poll(f3)
      expect(poll3._tag).toBe("None")

      // Advance remainder of window
      yield* TestClock.adjust(Duration.seconds(10))
      const r3 = yield* Fiber.join(f3)
      expect(r3.status).toBe(200)

      expect(calls).toBe(3)
      expect(maxActive).toBeLessThanOrEqual(1)
    }))
})
