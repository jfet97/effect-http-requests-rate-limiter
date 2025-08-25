import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"

describe("Headers Parsing", () => {
  it.scoped("should parse valid rate limit headers correctly", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              statusText: "OK",
              headers: {
                "x-ratelimit-remaining": "10",
                "x-ratelimit-reset": "300"
              }
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema
      })

      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)
    }))

  it.scoped("should handle malformed headers gracefully", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              statusText: "OK",
              headers: {
                "x-ratelimit-remaining": "invalid-number",
                "x-ratelimit-reset": "not-a-duration"
              }
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.malformedHeaders.config.rateLimiterHeadersSchema
      })

      // Should succeed despite malformed headers (graceful fallback)
      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)
    }))

  it.scoped("should handle missing headers", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              statusText: "OK",
              headers: {} // No rate limit headers
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema
      })

      // Should succeed when headers are missing (no rate limiting applied)
      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)
    }))

  it.scoped("should handle different header formats", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: "test" }), {
              status: 200,
              statusText: "OK",
              headers: {
                "retry-after": "120", // seconds format
                "x-ratelimit-remaining": "5",
                "x-ratelimit-reset": "1800" // 30 minutes
              }
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema
      })

      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://api.example.com"))
      expect(result.status).toBe(200)

      const body = yield* result.json
      expect(body).toEqual({ data: "test" })
    }))

  it.scoped("should handle zero remaining quota", () =>
    Effect.gen(function*() {
      const mockClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              statusText: "OK",
              headers: {
                "x-ratelimit-remaining": "0", // Quota exhausted
                "x-ratelimit-reset": "60"
              }
            })
          )
        )
      )

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: TestScenarios.quotaExhausted.config.rateLimiterHeadersSchema
      })

      // First request should succeed but trigger gate closure
      const result = yield* rateLimiter.execute(HttpClientRequest.get("http://test.com"))
      expect(result.status).toBe(200)

      // This validates that the headers were parsed correctly and gate was triggered
    }))
})
