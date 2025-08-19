# Effect Requests Rate Limiter

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Description

The Effect Requests Rate Limiter is a sophisticated rate limiting solution built on the [Effect](https://effect.website/) ecosystem. It provides intelligent rate limiting for HTTP requests with advanced features like dynamic gate control, quota monitoring, and smart delay optimization for concurrent requests.

Key capabilities:
- **Intelligent Gate Control**: Automatically closes/opens request flow based on rate limit headers and 429 responses
- **Smart Delay Optimization**: Minimizes cascading delays when multiple concurrent requests hit rate limits
- **Quota Monitoring**: Proactively handles quota exhaustion using `x-ratelimit-remaining` headers
- **Configurable Retry Policies**: Supports custom retry strategies with exponential backoff

## Features

- 🚪 **Dynamic Gate Control**: Automatically manages request flow based on rate limit signals
- ⚡ **Smart Concurrency**: Optimized delay handling for concurrent requests hitting rate limits
- 🔄 **Flexible Retry Policies**: Configurable retry strategies with jittered exponential backoff
- 📊 **Quota Awareness**: Proactive handling of request quotas using standard rate limit headers
- 🎛️ **Configurable Rate Limiting**: Support for various algorithms (fixed-window, token bucket, etc.)
- 🔧 **Header Schema Parsing**: Customizable parsing of rate limit headers (`retry-after`, `x-ratelimit-remaining`, `x-ratelimit-reset`)
- 🚦 **Concurrency Control**: Maximum concurrent request limiting with semaphore-based control

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

// Define schema for parsing rate limit headers
const RateLimitHeadersSchema = S.Struct({
  retryAfter: S.optional(S.transform(
    S.NumberFromString,
    S.DurationFromMillis,
    {
      decode: (s) => s * 1000, // seconds to milliseconds
      encode: (ms) => ms / 1000
    }
  )).pipe(S.fromKey("retry-after")),
  remainingRequestsQuota: S.optional(S.compose(S.NumberFromString, S.NonNegative)).pipe(
    S.fromKey("x-ratelimit-remaining")
  ),
  resetAfter: S.optional(S.transform(
    S.NumberFromString,
    S.DurationFromMillis,
    {
      decode: (s) => s * 1000, // seconds to milliseconds
      encode: (ms) => ms / 1000
    }
  )).pipe(S.fromKey("x-ratelimit-reset"))
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

You can control request flow using either:
- **`effectRateLimiter`**: Full-featured Effect RateLimiter with various algorithms (fixed-window, sliding-window, token-bucket)
- **`maxConcurrentRequests`**: Simple concurrent request limit using a semaphore

These options can coexist, but typically you'll configure **one or the other** based on your needs:
- Use `effectRateLimiter` for sophisticated rate limiting with time windows and algorithms
- Use `maxConcurrentRequests` for simple concurrency control without time-based limits

### Rate Limit Headers

The library supports **configurable** rate limit headers through a custom schema. You define which headers to parse and how to transform them. Common headers include:
- `retry-after`: Time to wait before retrying (in seconds)
- `x-ratelimit-remaining`: Remaining requests in current window  
- `x-ratelimit-reset`: Time when the rate limit window resets (in seconds)

The schema allows you to adapt to any API's specific header format and naming conventions.

### Smart Gate Control

The rate limiter features intelligent gate control that:
- **Closes the gate** when receiving 429 responses or when quota is exhausted
- **Optimizes delays** for concurrent requests to avoid cascading waits
- **Automatically reopens** the gate after the appropriate delay period
- **Skips unnecessary waits** when sufficient time has already elapsed

## How It Works

1. **Request Interception**: All requests pass through the rate limiter gate
2. **Header Analysis**: Response headers are parsed for rate limit information
3. **Dynamic Control**: Gate closes when limits are hit, opens when safe to proceed
4. **Smart Delays**: Concurrent requests are optimized to minimize total wait time
5. **Retry Logic**: Failed requests are retried according to configured policy

## Peer Dependencies

- `effect`
- `@effect/platform`