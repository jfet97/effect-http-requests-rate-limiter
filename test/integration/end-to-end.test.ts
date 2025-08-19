import { Duration, Effect, RateLimiter, Schedule, TestContext } from "effect"
import { describe, expect, it } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"
import { TestUtils } from "../__helpers__/test-utils.js"

describe("End-to-End Integration", () => {
  it("should handle complete rate limiting workflow", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")
    
    const effect = Effect.gen(function*() {
      const effectRateLimiter = yield* RateLimiter.make({
        limit: 2,
        algorithm: "fixed-window",
        interval: Duration.seconds(60)
      })
      
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema,
        retryPolicy: HttpRequestsRateLimiter.makeRetryPolicy(
          Effect.retry({
            schedule: Schedule.exponential("100 millis"),
            while: (err) => err._tag === "ResponseError" && err.response.status === 429,
            times: 2
          })
        ),
        effectRateLimiter,
        maxConcurrentRequests: 3
      })
      
      const mockResponse = {
        "http://test.com": {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "5",
            "x-ratelimit-reset": "3600"
          },
          body: JSON.stringify({ message: "Success" })
        }
      }
      
      const result = yield* TestUtils.withMockHttpClient(
        mockResponse,
        rateLimiter.limit(request)
      )
      
      expect(result.status).toBe(200)
      
      const body = yield* result.json
      expect(body).toEqual({ message: "Success" })
      
      return result
    })

    await Effect.runPromise(TestUtils.runWithTestClock(effect))
  })

  it("should work with Effect rate limiter only", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")
    
    const effect = Effect.gen(function*() {
      const effectRateLimiter = yield* RateLimiter.make({
        limit: 1,
        algorithm: "fixed-window", 
        interval: Duration.seconds(10)
      })
      
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        effectRateLimiter
      })
      
      const mockResponse = {
        "http://test.com": {
          status: 200,
          body: JSON.stringify({ success: true })
        }
      }
      
      const result1 = yield* TestUtils.withMockHttpClient(
        mockResponse,
        rateLimiter.limit(request)
      )
      expect(result1.status).toBe(200)
      
      const fiber = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )
      
      yield* TestUtils.advanceTime(Duration.seconds(5))
      const polledResult = yield* Effect.poll(fiber)
      expect(polledResult._tag).toBe("None")
      
      yield* TestUtils.advanceTime(Duration.seconds(8))
      const result2 = yield* Effect.join(fiber)
      expect(result2.status).toBe(200)
      
      return { result1, result2 }
    })

    await Effect.runPromise(TestUtils.runWithTestClock(effect))
  })
})