import { Duration, Effect, TestContext, TestClock } from "effect"
import { describe, expect, it } from "vitest"

describe("Basic TestClock functionality", () => {
  it("should advance time correctly", async () => {
    const effect = Effect.gen(function*() {
      const startTime = yield* TestClock.currentTimeMillis
      
      yield* TestClock.adjust(Duration.seconds(60))
      
      const endTime = yield* TestClock.currentTimeMillis
      
      expect(endTime - startTime).toBe(60_000)
    })

    await Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)))
  })

  it("should handle Effect.sleep with TestClock", async () => {
    const effect = Effect.gen(function*() {
      const start = Date.now()
      
      const fiber = yield* Effect.fork(Effect.sleep(Duration.seconds(30)))
      
      // Advance test clock by 30 seconds
      yield* TestClock.adjust(Duration.seconds(30))
      
      // Sleep should complete now
      yield* fiber
      
      const elapsed = Date.now() - start
      
      // Should complete quickly in real time, not wait 30 seconds
      expect(elapsed).toBeLessThan(1000)
    })

    await Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)))
  })

  it("should verify Duration utilities work", () => {
    const duration = Duration.seconds(30)
    expect(Duration.toMillis(duration)).toBe(30_000)
    expect(Duration.toSeconds(duration)).toBe(30)
    
    const duration2 = Duration.minutes(2)
    expect(Duration.toMillis(duration2)).toBe(120_000)
  })
})