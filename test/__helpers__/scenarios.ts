import { Duration, Schema as S } from "effect"
import * as HttpRequestsRateLimiter from "../../src/index.js"

export const DurationFromSecondsString = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

export const NonNegativeFromString = S.compose(S.NumberFromString, S.NonNegative)

export const TestHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema(S.Struct({
  retryAfter: S.optional(DurationFromSecondsString).pipe(
    S.fromKey("retry-after")
  ),
  remainingRequestsQuota: S.optional(NonNegativeFromString).pipe(
    S.fromKey("x-ratelimit-remaining")
  ),
  resetAfter: S.optional(DurationFromSecondsString).pipe(
    S.fromKey("x-ratelimit-reset")
  )
}))

export const NoRetryPolicy = HttpRequestsRateLimiter.makeRetryPolicy((effect) => effect)

export const SimpleRetryPolicy = HttpRequestsRateLimiter.makeRetryPolicy(
  (effect) => effect // TODO: add actual retry logic for tests
)

export const TestScenarios = {
  quotaExhausted: {
    config: {
      rateLimiterHeadersSchema: TestHeadersSchema
    },
    responses: [
      {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "30"
        }
      }
    ]
  },
  
  rateLimitHit: {
    config: {
      rateLimiterHeadersSchema: TestHeadersSchema,
      retryPolicy: NoRetryPolicy
    },
    responses: [
      {
        status: 429,
        headers: {
          "retry-after": "60"
        }
      }
    ]
  },

  normalOperation: {
    config: {
      rateLimiterHeadersSchema: TestHeadersSchema
    },
    responses: [
      {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "10",
          "x-ratelimit-reset": "300"
        }
      }
    ]
  },

  malformedHeaders: {
    config: {
      rateLimiterHeadersSchema: TestHeadersSchema
    },
    responses: [
      {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "invalid",
          "x-ratelimit-reset": "not-a-number"
        }
      }
    ]
  }
}