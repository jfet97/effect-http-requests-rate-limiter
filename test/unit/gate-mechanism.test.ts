import { Duration, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"
import { TestUtils } from "../__helpers__/test-utils.js"

describe("Gate Mechanism", () => {
  it("should close gate when quota is exhausted", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")

    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make(
        TestScenarios.quotaExhausted.config
      )

      const mockResponse = {
        "http://test.com": {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "30"
          },
          body: JSON.stringify({ success: true })
        }
      }

      const fiber1 = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )

      const result1 = yield* Fiber.join(fiber1)
      expect(result1.status).toBe(200)

      const fiber2 = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )

      yield* TestUtils.advanceTime(Duration.seconds(15))

      const isCompleted = yield* Fiber.poll(fiber2)
      expect(isCompleted._tag).toBe("None")

      yield* TestUtils.advanceTime(Duration.seconds(20))

      const result2 = yield* Fiber.join(fiber2)
      expect(result2.status).toBe(200)

      return { result1, result2 }
    })

    await Effect.runPromise(TestUtils.runWithTestClock(effect))
  })

  it("should close gate for 429 errors with retry-after", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")

    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make(
        TestScenarios.rateLimitHit.config
      )

      let callCount = 0
      const mockResponse = {
        "http://test.com": (() => {
          callCount++
          if (callCount === 1) {
            return {
              status: 429,
              headers: { "retry-after": "60" }
            }
          }
          return {
            status: 200,
            body: JSON.stringify({ success: true })
          }
        })()
      }

      const fiber = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )

      yield* TestUtils.advanceTime(Duration.seconds(30))
      const result = yield* Fiber.poll(fiber)
      expect(result._tag).toBe("None")

      yield* TestUtils.advanceTime(Duration.seconds(35))

      const finalResult = yield* Fiber.join(fiber)
      expect(finalResult.status).toBe(200)

      return finalResult
    })

    await Effect.runPromise(TestUtils.runWithTestClock(effect))
  })

  it("should handle smart delay optimization for concurrent requests", async () => {
    const request = TestUtils.makeTestRequest("http://test.com")

    const effect = Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make(
        TestScenarios.quotaExhausted.config
      )

      const mockResponse = {
        "http://test.com": {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "60"
          },
          body: JSON.stringify({ success: true })
        }
      }

      const startTime = Date.now()

      const fiber1 = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )

      yield* TestUtils.advanceTime(Duration.seconds(30))

      const fiber2 = yield* Effect.fork(
        TestUtils.withMockHttpClient(mockResponse, rateLimiter.limit(request))
      )

      const result1 = yield* Fiber.join(fiber1)
      const result2 = yield* Fiber.join(fiber2)

      expect(result1.status).toBe(200)
      expect(result2.status).toBe(200)

      return { result1, result2 }
    })

    await Effect.runPromise(TestUtils.runWithTestClock(effect))
  })
})
