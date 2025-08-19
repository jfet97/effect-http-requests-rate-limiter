# Effect Requests Rate Limiter

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Description

Intelligent HTTP request rate limiter for [Effect](https://effect.website/) with dynamic gate control, quota monitoring, and smart delay optimization.

**Features:**
- 🚪 **Smart Gate Control**: Auto-manages request flow based on rate limit headers and 429 responses
- ⚡ **Optimized Delays**: Minimizes cascading waits for concurrent requests
- 📊 **Quota Monitoring**: Proactive handling using relevant headers
- 🔄 **Flexible Retries**: Configurable retry policies with exponential backoff
- 🎛️ **Effect Integration**: Works with any Effect RateLimiter
- 🚦 **Concurrency Control**: Semaphore-based request limiting

## Installation

```sh
pnpm i effect-requests-rate-limiter
```

## Usage

```ts
import { DevTools } from "@effect/experimental"
import { HttpClientRequest } from "@effect/platform"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Duration, Effect, RateLimiter, Schedule, Schema as S } from "effect"
import { makeRequestsRateLimiter, type RetryPolicy } from "effect-requests-rate-limiter"

// Helper for converting seconds to Duration
const DurationFromSecondsString = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

// Define schema for parsing rate limit headers
const RateLimitHeadersSchema = S.Struct({
  retryAfter: S.optional(DurationFromSecondsString).pipe(S.fromKey("retry-after")),
  remainingRequestsQuota: S.optional(S.compose(S.NumberFromString, S.NonNegative)).pipe(
    S.fromKey("x-ratelimit-remaining")
  ),
  resetAfter: S.optional(DurationFromSecondsString).pipe(S.fromKey("x-ratelimit-reset"))
})

// Configure retry policy for 429 responses
const MyRetryPolicy = Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5
}) satisfies RetryPolicy

// Create Effect rate limiter
const MyRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(3)
})

const main = Effect.gen(function*($) {
  const rateLimiter = yield* MyRateLimiter

  // Create the requests rate limiter
  const requestsRateLimiter = yield* makeRequestsRateLimiter({
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: MyRetryPolicy,
    effectRateLimiter: rateLimiter,
    maxConcurrentRequests: 4
  })

  const req = HttpClientRequest.get("http://localhost:3000")

  // Use the rate limiter to control requests
  const limitedRequest = requestsRateLimiter.limit(req)

  // Execute the rate-limited request
  const response = yield* limitedRequest

  // Handle response...
})

NodeRuntime.runMain(main.pipe(
  Effect.provide(NodeHttpClient.layer),
  Effect.provide(DevTools.layer())
))
```

## Configuration Options

The `makeRequestsRateLimiter` function accepts the following configuration:

```ts
interface RequestsRateLimiterConfig {
  /** Schema for parsing rate limit headers from HTTP responses */
  rateLimiterHeadersSchema?: RateLimiterHeadersSchema
  /** Retry policy to use when rate limit is exceeded (429 status) */
  retryPolicy?: RetryPolicy
  /** Effect rate limiter to control the number of concurrent outgoing requests */
  effectRateLimiter?: RateLimiter.RateLimiter
  /** Maximum number of concurrent requests allowed (simple alternative to effectRateLimiter) */
  maxConcurrentRequests?: number
}
```

### Rate Limiting Options

- **`effectRateLimiter`**: Effect RateLimiter with algorithms (fixed-window, sliding-window, token-bucket)
- **`maxConcurrentRequests`**: Simple concurrent request limit with semaphore

Typically configure **one or the other**: use `effectRateLimiter` for time-based limits, `maxConcurrentRequests` for simple concurrency.

### Rate Limit Headers Schema

The library uses a **configurable schema** to parse HTTP response headers into three standardized fields:

```ts
{
  /** Retry delay - used when receiving 429 responses */
  readonly "retryAfter"?: Duration.Duration | undefined
  /** Remaining request quota in the current window */
  readonly "remainingRequestsQuota"?: number | undefined  
  /** Time until the rate limit window resets */
  readonly "resetAfter"?: Duration.Duration | undefined
}
```

**All fields optional** - without headers, only retry policy, Effect rate limiter, and concurrency limits apply.

- **`retryAfter`**: Wait time after 429 responses
- **`remainingRequestsQuota` + `resetAfter`**: Proactive quota management - gate closes when quota = 0
- Schema transforms API headers (`x-ratelimit-remaining`, `retry-after`) to standardized fields

## How It Works

1. Requests pass through the rate limiter gate
2. Response headers parsed for rate limit info
3. Gate closes on 429/quota exhaustion, reopens after delay
4. Smart delays optimize concurrent request timing
5. Failed requests retry per configured policy

## Peer Dependencies

- `effect`
- `@effect/platform`