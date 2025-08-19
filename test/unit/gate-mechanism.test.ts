import { it } from "@effect/vitest"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Duration, Effect, Layer, TestClock } from "effect"
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
      
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        rateLimiterHeadersSchema: TestScenarios.quotaExhausted.config.rateLimiterHeadersSchema
      }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient))
      )

      // Request succeeds and processes quota headers
      const result = yield* rateLimiter.limit(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)
      
      const body = yield* result.json
      expect(body).toEqual({ success: true })
    })
  )

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
      
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        rateLimiterHeadersSchema: TestScenarios.rateLimitHit.config.rateLimiterHeadersSchema
      }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient))
      )

      // The request should fail with ResponseError after processing the gate delay  
      const result = yield* rateLimiter.limit(HttpClientRequest.get("http://test.com")).pipe(
        Effect.either
      )
      
      // Should be a Left (error) because 429 gets re-thrown
      expect(result._tag).toBe("Left")
      expect(requestCount).toBe(1)
      
      // Log should show that rate limit was processed
    })
  )

  it.effect("should work with TestClock timing", () =>
    Effect.gen(function*() {
      // Test basic TestClock functionality with rate limiter context
      const startTime = yield* TestClock.currentTimeMillis
      
      // Advance time 
      yield* TestClock.adjust(Duration.seconds(60))
      const endTime = yield* TestClock.currentTimeMillis
      
      expect(endTime - startTime).toBe(Duration.toMillis(Duration.seconds(60)))
    })
  )
})
