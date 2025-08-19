import { NodeHttpClient } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Duration, Effect, TestClock } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"
import { TestScenarios } from "../__helpers__/scenarios.js"

describe("Effect Vitest Integration", () => {
  it.scoped("should create rate limiter correctly", () =>
    Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make({})

      expect(rateLimiter).toBeDefined()
      expect(typeof rateLimiter.limit).toBe("function")
    }).pipe(Effect.provide(NodeHttpClient.layerUndici)))

  it.effect("should handle TestClock correctly", () =>
    Effect.gen(function*() {
      const startTime = yield* TestClock.currentTimeMillis

      yield* TestClock.adjust(Duration.seconds(60))

      const endTime = yield* TestClock.currentTimeMillis

      expect(endTime - startTime).toBe(60_000)
    }))

  it.scoped("should create rate limiter with configuration", () =>
    Effect.gen(function*() {
      const rateLimiter = yield* HttpRequestsRateLimiter.make({
        rateLimiterHeadersSchema: TestScenarios.normalOperation.config.rateLimiterHeadersSchema,
        maxConcurrentRequests: 5
      })

      expect(rateLimiter).toBeDefined()
      expect(typeof rateLimiter.limit).toBe("function")
    }).pipe(Effect.provide(NodeHttpClient.layerUndici)))

  it.effect("should handle Effect.sleep with TestClock", () =>
    Effect.gen(function*() {
      const start = Date.now()

      const fiber = yield* Effect.fork(Effect.sleep(Duration.seconds(30)))

      yield* TestClock.adjust(Duration.seconds(30))

      yield* fiber

      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(1000)
    }))
})
