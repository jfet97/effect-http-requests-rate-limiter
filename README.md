# Effect HTTP Requests Rate Limiter

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
pnpm i effect-http-requests-rate-limiter
```

## Usage

```ts
import { DevTools } from "@effect/experimental"
import { HttpClientRequest } from "@effect/platform"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Duration, Effect, Layer, pipe, RateLimiter, Schedule, Schema as S } from "effect"
import * as HttpRequestsRateLimiter from "effect-http-requests-rate-limiter"

// Helper for converting seconds to Duration
const DurationFromSecondsString = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

const NonNegativeFromString = S.compose(S.NumberFromString, S.NonNegative)

// Define schema for extracting relevant fields from the HTTP response headers
// Adjust it to match the API you integrate with.
const RateLimitHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema(S.Struct({
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

// Configure retry policy for errors
const myRetryPolicy = HttpRequestsRateLimiter.makeRetryPolicy(Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5
}))

// Create Effect rate limiter
const EffectRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(3)
})

const main = Effect.gen(function*() {
  const rateLimiter = yield* EffectRateLimiter

  // Create the requests rate limiter
  const requestsRateLimiter = yield* HttpRequestsRateLimiter.make({
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: myRetryPolicy,
    effectRateLimiter: rateLimiter,
    // maxConcurrentRequests: 4
  })

  const req = HttpClientRequest.get("http://localhost:3000")

  // Use the rate limiter to control requests
  const response = yield* requestsRateLimiter.limit(req)

  // Handle response...
}).pipe(Effect.scoped)

NodeRuntime.runMain(main.pipe(
  Effect.provide(Layer.merge(
    NodeHttpClient.layer,
    DevTools.layer()
  ))
))
```

## Configuration Options

The `HttpRequestsRateLimiter.make` function accepts the following configuration:

```ts
interface Config {
  /** Schema for parsing rate limit headers from HTTP responses */
  rateLimiterHeadersSchema?: HeadersSchema
  /** Retry policy to use when rate limit is exceeded (429 status) */
  retryPolicy?: RetryPolicy
  /** Effect rate limiter to control the number of concurrent outgoing requests */
  effectRateLimiter?: RateLimiter.RateLimiter
  /** Maximum number of concurrent requests allowed */
  maxConcurrentRequests?: number
}
```

## Helper Functions

- **`makeHeadersSchema(schema)`**: Util for creating header schemas
- **`makeRetryPolicy(policy)`**: Util for creating retry policies

### Rate Limiting Options

- **`effectRateLimiter`**: Effect `RateLimiter` with algorithms (fixed-window, sliding-window, token-bucket)
- **`maxConcurrentRequests`**: Simple concurrent request limit with semaphore

Typically configure **one or the other**: use `effectRateLimiter` for time-based limits, `maxConcurrentRequests` for simple concurrency.

### Rate Limit Headers Schema

The library uses a **configurable schema** to parse HTTP response headers into three standardized fields:

```ts
{
  /**
   * Retry delay after a 429 (relative duration to wait before retrying).
   */
  readonly "retryAfter"?: Duration.Duration | undefined
  /**
   * Remaining request quota in the current window. When it reaches 0 and
   * `resetAfter` is present the gate will proactively close for that duration.
   */
  readonly "remainingRequestsQuota"?: number | undefined
  /**
   * Time until the quota window resets (relative duration).
   */
  readonly "resetAfter"?: Duration.Duration | undefined
}
```

**All fields optional** - without headers, only retry policy, Effect rate limiter, and concurrency limits apply.

- **`retryAfter`**: Wait time after 429 responses
- **`remainingRequestsQuota` + `resetAfter`**: Proactive quota management - gate closes when quota = 0

#### Semantics of `retryAfter` and `resetAfter`

Always **relative durations** ("wait this long"), never absolute timestamps. Convert absolute values when decoding headers so the limiter only handles durations.

Common patterns:

```ts
// 1) Header already gives SECONDS to wait (e.g. retry-after: "12")
const DurationFromSeconds = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  { decode: (s) => s * 1000, encode: (ms) => ms / 1000 }
)

// 2) Header gives EPOCH milliseconds (e.g. x-ratelimit-reset: "1734012345123")
const DurationFromEpochMillis = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  { decode: (epochMs) => Math.max(epochMs - Date.now(), 0), encode: (ms) => Date.now() + ms }
)

// 3) Header gives HTTP date (e.g. Retry-After: "Wed, 21 Oct 2015 07:28:00 GMT")
const DurationFromHttpDate = S.transform(
  S.String,
  S.DurationFromMillis,
  { decode: (d) => Math.max(new Date(d).getTime() - Date.now(), 0), encode: (ms) => new Date(Date.now() + ms).toUTCString() }
)
```

Rule: end up with a `Duration` that represents "time to wait from now".

## How It Works

1. Requests pass through the rate limiter gate
2. Response headers parsed for rate limit info
3. Gate closes on 429/quota exhaustion, reopens after delay
4. Smart delays optimize concurrent request timing
5. Failed requests retry per configured policy

## Important Notes

⚠️ **Non-2xx Response Handling**: This library requires non-2xx HTTP responses to be treated as Effect errors for proper retry and gate control functionality. This is enforced internally using `HttpClient.filterStatusOk`, so 4xx/5xx responses will automatically flow through Effect's error channel.

## Peer Dependencies

- `effect`
- `@effect/platform`