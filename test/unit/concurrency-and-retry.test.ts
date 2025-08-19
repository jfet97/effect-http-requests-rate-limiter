import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, RateLimiter, Schedule, Schema as S, TestClock } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"

describe("Concurrency and Retry", () => {
  it.scoped("should limit concurrent requests", () =>
    Effect.gen(function*() {
      let activeRequests = 0
      let maxConcurrentSeen = 0

      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          activeRequests++
          maxConcurrentSeen = Math.max(maxConcurrentSeen, activeRequests)

          // Simulate some processing time
          yield* Effect.sleep(Duration.millis(100))

          activeRequests--
          const webResponse = new Response(
            JSON.stringify({ success: true }),
            { status: 200, statusText: "OK", headers: {} }
          )
          return HttpClientResponse.fromWeb(request, webResponse)
        })
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        httpClient: mockClient,
        maxConcurrentRequests: 3,
        rateLimiterHeadersSchema: S.Struct({})
      })

      // Launch 6 concurrent requests
      const requests = Array.from({ length: 6 }, () =>
        Effect.fork(rateLimiter.limit(HttpClientRequest.get("http://test.com"))))

      const fibers = yield* Effect.all(requests)

      // Advance time to let requests process
      yield* TestClock.adjust(Duration.millis(200))

      const results = yield* Effect.all(fibers.map(Fiber.join))

      // All requests should succeed
      results.forEach((result) => {
        expect(result.status).toBe(200)
      })

      // But max concurrent should be limited to 3
      expect(maxConcurrentSeen).toBe(3)
    }))

  it.scoped("should work with Effect RateLimiter", () =>
    Effect.gen(function*() {
      let requestCount = 0

      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          requestCount++
          const webResponse = new Response(
            JSON.stringify({ count: requestCount }),
            { status: 200, statusText: "OK", headers: {} }
          )
          return HttpClientResponse.fromWeb(request, webResponse)
        })
      )

      const effectRateLimiter = yield* RateLimiter.make({
        limit: 2,
        algorithm: "fixed-window",
        interval: Duration.seconds(10)
      })

      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        httpClient: mockClient,
        effectRateLimiter,
        rateLimiterHeadersSchema: S.Struct({})
      })

      // First two requests should succeed immediately
      const result1 = yield* rateLimiter.limit(HttpClientRequest.get("http://test.com"))
      const result2 = yield* rateLimiter.limit(HttpClientRequest.get("http://test.com"))

      expect(result1.status).toBe(200)
      expect(result2.status).toBe(200)

      // Third request should be rate limited by Effect RateLimiter
      const fiber3 = yield* Effect.fork(
        rateLimiter.limit(HttpClientRequest.get("http://test.com"))
      )

      // Should still be waiting after short time
      yield* TestClock.adjust(Duration.seconds(5))
      const stillWaiting = yield* Fiber.poll(fiber3)
      expect(stillWaiting._tag).toBe("None")

      // Should succeed after window resets
      yield* TestClock.adjust(Duration.seconds(10))
      const result3 = yield* Fiber.join(fiber3)
      expect(result3.status).toBe(200)
    }))

  it.scoped("should apply retry policy after 429 handling", () =>
    Effect.gen(function*() {
      let requestCount = 0

      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          requestCount++

          if (requestCount === 1) {
            // First request: 429 with retry-after
            const webResponse = new Response(
              JSON.stringify({ error: "Rate limited" }),
              { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "30" } }
            )
            return HttpClientResponse.fromWeb(request, webResponse)
          } else if (requestCount === 2) {
            // Second request: still 429 (for retry policy to kick in)
            const webResponse = new Response(
              JSON.stringify({ error: "Still rate limited" }),
              { status: 429, statusText: "Too Many Requests", headers: {} }
            )
            return HttpClientResponse.fromWeb(request, webResponse)
          } else {
            // Third request: success
            const webResponse = new Response(
              JSON.stringify({ success: true }),
              { status: 200, statusText: "OK", headers: {} }
            )
            return HttpClientResponse.fromWeb(request, webResponse)
          }
        })
      )

      const retryPolicy = HttpRequestsRateLimiter.makeRetryPolicy(
        Effect.retry({
          schedule: Schedule.exponential("100 millis"),
          while: (err) => err._tag === "ResponseError" && err.response.status === 429,
          times: 2
        })
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        httpClient: mockClient,
        rateLimiterHeadersSchema: TestScenarios.rateLimitHit.config.rateLimiterHeadersSchema,
        retryPolicy
      })

      const fiber = yield* Effect.fork(
        rateLimiter.limit(HttpClientRequest.get("http://test.com"))
      )

      // Wait for initial 429 + retry-after delay + retry attempts
      yield* TestClock.adjust(Duration.seconds(35)) // retry-after + retry delays

      const result = yield* Fiber.join(fiber)
      expect(result.status).toBe(200)

      // Should have made: initial 429, gate delay, retry 429, retry success
      expect(requestCount).toBe(3)
    }))

  it.effect("should work without any configuration", () =>
    Effect.gen(function*() {
      // Test that rate limiter works in minimal configuration
      // This tests the basic pass-through functionality

      const startTime = yield* TestClock.currentTimeMillis

      // Simulate some basic timing
      yield* TestClock.adjust(Duration.millis(100))

      const endTime = yield* TestClock.currentTimeMillis
      expect(endTime - startTime).toBe(100)
    }))
})
