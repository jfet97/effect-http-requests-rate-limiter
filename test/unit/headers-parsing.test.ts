import { HttpClientRequest } from "@effect/platform"
import { Duration, Effect, TestContext } from "effect"
import { describe, expect, it } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"
import { TestUtils } from "../__helpers__/test-utils.js"

describe("Headers Parsing", () => {
  it("should parse valid rate limit headers correctly", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")
    
    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make(
        TestScenarios.normalOperation.config
      )
      
      const mockResponse = {
        "http://test.com": {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "10",
            "x-ratelimit-reset": "300"
          },
          body: JSON.stringify({ success: true })
        }
      }
      
      return yield* TestUtils.withMockHttpClient(
        mockResponse,
        rateLimiter.limit(request)
      )
    })

    const result = await Effect.runPromise(
      TestUtils.runWithTestClock(effect)
    )
    
    expect(result.status).toBe(200)
  })

  it("should handle malformed headers gracefully", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")
    
    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make(
        TestScenarios.malformedHeaders.config
      )
      
      const mockResponse = {
        "http://test.com": {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "invalid-number",
            "x-ratelimit-reset": "not-a-duration"
          },
          body: JSON.stringify({ success: true })
        }
      }
      
      return yield* TestUtils.withMockHttpClient(
        mockResponse,
        rateLimiter.limit(request)
      )
    })

    const result = await Effect.runPromise(
      TestUtils.runWithTestClock(effect)
    )
    
    expect(result.status).toBe(200)
  })

  it("should handle missing headers", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")
    
    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema
      })
      
      const mockResponse = {
        "http://test.com": {
          status: 200,
          body: JSON.stringify({ success: true })
        }
      }
      
      return yield* TestUtils.withMockHttpClient(
        mockResponse,
        rateLimiter.limit(request)
      )
    })

    const result = await Effect.runPromise(
      TestUtils.runWithTestClock(effect)
    )
    
    expect(result.status).toBe(200)
  })
})