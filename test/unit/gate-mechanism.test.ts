import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, TestClock } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"

describe("Gate Mechanism", () => {
  it.scoped("should handle quota exhaustion headers", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              statusText: "OK",
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "30"
              }
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.quotaExhausted.config.rateLimiterHeadersSchema
      })

      // Request succeeds and processes quota headers
      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)

      const body = yield* result.json
      expect(body).toEqual({ success: true })
    }))

  it.scoped("should process 429 errors and schedule gate delay", () =>
    Effect.gen(function*() {
      let requestCount = 0

      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          requestCount++
          // Always return 429 to test that gate delay is processed
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ error: "Rate limited" }), {
              status: 429,
              statusText: "Too Many Requests",
              headers: { "retry-after": "60" }
            })
          )
        })
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.rateLimitHit.config.rateLimiterHeadersSchema
      })

      // The request should fail with ResponseError after processing the gate delay
      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com")).pipe(
        Effect.either
      )

      // Should be a Left (error) because 429 gets re-thrown
      expect(result._tag).toBe("Left")
      expect(requestCount).toBe(1)

      // Log should show that rate limit was processed
    }))

  it.effect("should work with TestClock timing", () =>
    Effect.gen(function*() {
      // Test basic TestClock functionality with rate limiter context
      const startTime = yield* TestClock.currentTimeMillis

      // Advance time
      yield* TestClock.adjust(Duration.seconds(60))
      const endTime = yield* TestClock.currentTimeMillis

      expect(endTime - startTime).toBe(Duration.toMillis(Duration.seconds(60)))
    }))

  it.scoped("should block subsequent requests until quotaResetsAfter elapses", () =>
    Effect.gen(function*() {
      let call = 0
      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          call++
          if (call === 1) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ first: true }), {
                status: 200,
                statusText: "OK",
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "30"
                }
              })
            )
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ second: true }), {
              status: 200,
              statusText: "OK",
              headers: {
                "x-ratelimit-remaining": "10",
                "x-ratelimit-reset": "300"
              }
            })
          )
        })
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.quotaExhausted.config.rateLimiterHeadersSchema
      })

      const res1 = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com/one"))
      expect(res1.status).toBe(200)

      const start = yield* TestClock.currentTimeMillis
      const fiber2 = yield* Effect.fork(rateLimiter.execute(HttpClientRequest.get("http://test.com/two")))
      // Advance full window then join
      yield* TestClock.adjust(Duration.seconds(30))
      const res2 = yield* Fiber.join(fiber2)
      const end = yield* TestClock.currentTimeMillis
      expect(end - start).toBeGreaterThanOrEqual(30_000)
      expect(res2.status).toBe(200)
      expect(call).toBe(2)
    }))

  it.scoped("should unblock after retry-after for subsequent request after a 429", () =>
    Effect.gen(function*() {
      let call = 0
      const mockClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          call++
          if (call <= 1) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ error: true, n: call }), {
                status: 429,
                statusText: "Too Many Requests",
                headers: { "retry-after": "30" }
              })
            )
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true, n: call }), {
              status: 200,
              statusText: "OK",
              headers: {}
            })
          )
        })
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.rateLimitHit.config.rateLimiterHeadersSchema
      })

      const first = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com/a")).pipe(Effect.either)
      expect(first._tag).toBe("Left")

      const fiber2 = yield* Effect.fork(rateLimiter.execute(HttpClientRequest.get("http://test.com/c")))
      yield* TestClock.adjust(Duration.seconds(29))
      const poll = yield* Fiber.poll(fiber2)
      expect(poll._tag).toBe("None")
      yield* TestClock.adjust(Duration.seconds(1))
      const success = yield* Fiber.join(fiber2)
      expect(success.status).toBe(200)
      expect(call).toBe(2)
    }))
})
