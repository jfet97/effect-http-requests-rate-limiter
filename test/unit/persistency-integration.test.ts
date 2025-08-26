import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { Duration, Effect, Queue, Ref, Schema as S } from "effect"
import { describe, expect } from "vitest"

import * as HttpRequestsRateLimiter from "../../src/index.js"

// Mock implementation of PersistencyLayer for testing
const createMockPersistencyLayer = Effect.gen(function*() {
  const eventsQueue = yield* Queue.bounded<HttpRequestsRateLimiter.RateLimitEvent>(100)
  const quotaState = yield* Ref.make<{
    remaining?: number
    resetsAt?: Duration.Duration
  }>({})

  const persistencyLayer: HttpRequestsRateLimiter.PersistencyLayer = {
    publishEvent: (event) => Queue.offer(eventsQueue, event).pipe(Effect.asVoid),
    subscribeToEvents: Effect.succeed(eventsQueue),
    getSharedQuota: () => Ref.get(quotaState),
    updateSharedQuota: (remaining, resetsAt) => Ref.set(quotaState, { remaining, resetsAt })
  }

  return { persistencyLayer, eventsQueue, quotaState }
})

// Simple mock HTTP client that returns specific responses
const createMockHttpClient = (
  responses: Array<{
    status: number
    headers: Record<string, string>
    body?: string
  }>
) => {
  let callCount = 0
  return HttpClient.make((request) => {
    const response = responses[callCount % responses.length]
    callCount++

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(response.body ?? "", {
          status: response.status,
          headers: response.headers
        })
      )
    )
  })
}

describe("Persistency Integration", () => {
  const DurationFromSecondsString = S.transform(
    S.NumberFromString,
    S.DurationFromMillis,
    {
      decode: (s) => s * 1000,
      encode: (ms) => ms / 1000
    }
  )

  const NonNegativeFromString = S.compose(S.NumberFromString, S.NonNegative)

  const RateLimitHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema({
    retryAfter: { fromKey: "retry-after", schema: DurationFromSecondsString },
    quotaRemainingRequests: { fromKey: "x-ratelimit-remaining", schema: NonNegativeFromString },
    quotaResetsAfter: { fromKey: "x-ratelimit-reset", schema: DurationFromSecondsString }
  })

  it.effect("should call persistency layer methods directly", () =>
    Effect.gen(function*() {
      const { persistencyLayer, eventsQueue } = yield* createMockPersistencyLayer

      // Test publishing an event directly
      const testEvent: HttpRequestsRateLimiter.RateLimitEvent = {
        type: "quota_exhausted",
        duration: Duration.seconds(30),
        timestamp: Duration.millis(Date.now())
      }

      yield* persistencyLayer.publishEvent(testEvent)

      // Check that event was published
      const eventOption = yield* Queue.poll(eventsQueue)
      expect(eventOption._tag).toBe("Some")
      if (eventOption._tag === "Some") {
        const event = eventOption.value
        expect(event.type).toBe("quota_exhausted")
        expect(event.duration).toBeDefined()
        if (event.duration) {
          expect(Duration.toMillis(event.duration)).toBe(30_000)
        }
      }
    }))

  it.scoped("should update shared quota state on successful response", () =>
    Effect.gen(function*() {
      const { persistencyLayer, quotaState } = yield* createMockPersistencyLayer

      const mockClient = createMockHttpClient([{
        status: 200,
        headers: {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "60"
        }
      }])

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: RateLimitHeadersSchema,
        persistency: persistencyLayer
      })

      const req = HttpClientRequest.get("http://example.com")
      yield* rateLimiter.execute(req)

      // Check that quota state was updated
      const quota = yield* Ref.get(quotaState)
      expect(quota.remaining).toBe(50)
      expect(quota.resetsAt).toBeDefined()
    }))

  it.scoped("should retrieve shared quota state", () =>
    Effect.gen(function*() {
      const { persistencyLayer, quotaState } = yield* createMockPersistencyLayer

      // Set some quota state
      const currentTime = Duration.millis(Date.now())
      const resetsAt = Duration.sum(currentTime, Duration.seconds(60))
      yield* Ref.set(quotaState, { remaining: 25, resetsAt })

      // Create a simple mock client (won't be called in this test)
      const mockClient = createMockHttpClient([{
        status: 200,
        headers: {}
      }])

      // Test the getSharedQuota functionality directly
      const sharedQuota = yield* persistencyLayer.getSharedQuota()
      expect(sharedQuota.remaining).toBe(25)
      expect(sharedQuota.resetsAt).toBeDefined()
    }))

  it.scoped("should handle persistency layer failures gracefully", () =>
    Effect.gen(function*() {
      // Create a persistency layer that always fails
      const failingPersistencyLayer: HttpRequestsRateLimiter.PersistencyLayer = {
        publishEvent: () => Effect.fail("Persistency layer error"),
        subscribeToEvents: Effect.fail("Persistency layer error"),
        getSharedQuota: () => Effect.fail("Persistency layer error"),
        updateSharedQuota: () => Effect.fail("Persistency layer error")
      }

      const mockClient = createMockHttpClient([{
        status: 200,
        headers: {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "60"
        }
      }])

      const rateLimiter = yield* HttpRequestsRateLimiter.make(mockClient, {
        rateLimiterHeadersSchema: RateLimitHeadersSchema,
        persistency: failingPersistencyLayer
      })

      // Request should still succeed despite persistency layer failures
      const req = HttpClientRequest.get("http://example.com")
      const response = yield* rateLimiter.execute(req)

      expect(response.status).toBe(200)
    }))
})
