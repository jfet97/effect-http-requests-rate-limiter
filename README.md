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
import { HttpClient, HttpClientRequest } from "@effect/platform"
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
const RateLimitHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema({
  retryAfter: { fromKey: "retry-after", schema: DurationFromSecondsString },
  quotaRemainingRequests: { fromKey: "x-ratelimit-remaining", schema: NonNegativeFromString },
  quotaResetsAfter: { fromKey: "x-ratelimit-reset", schema: DurationFromSecondsString }
})

// Create Effect rate limiter
const EffectRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(10)
})

const main = Effect.gen(function*() {
  const rateLimiter = yield* EffectRateLimiter

  // Option 1: Use makeWithContext (HTTP client from context)
  const requestsRateLimiter = (yield* HttpRequestsRateLimiter.makeWithContext({
    rateLimiterHeadersSchema: RateLimitHeadersSchema,
    effectRateLimiter: rateLimiter
    // maxConcurrentRequests: 4
  })).pipe(HttpClient.retryTransient({
    schedule: Schedule.jittered(Schedule.exponential("200 millis")),
    while: (err) => err._tag === "ResponseError" && err.response.status === 429,
    times: 5
  }))

  // Option 2: Use make (provide HTTP client manually)
  // const httpClient = yield* HttpClient.HttpClient
  // const requestsRateLimiter = yield* HttpRequestsRateLimiter.make(httpClient, {
  //   rateLimiterHeadersSchema: RateLimitHeadersSchema,
  //   effectRateLimiter: rateLimiter
  // })

  const req = HttpClientRequest.get("http://localhost:5678")

  // Execute requests through the rate limiter
  const response = yield* requestsRateLimiter.execute(req)

  // Handle response...
}).pipe(Effect.scoped)

NodeRuntime.runMain(main.pipe(
  Effect.provide(Layer.merge(
    NodeHttpClient.layer,
    DevTools.layer()
  ))
))
```

## API Overview

The library provides two main functions for creating rate-limited HTTP clients:

```ts
// Option 1: Automatic HTTP client resolution from context
const rateLimiter = yield* HttpRequestsRateLimiter.makeWithContext(config)

// Option 2: Manual HTTP client provision
const rateLimiter = yield* HttpRequestsRateLimiter.make(httpClient, config)
```

### Configuration Options

```ts
interface Config {
  /** Schema for parsing rate limit headers from HTTP responses */
  rateLimiterHeadersSchema: HeadersSchema
  /** Effect rate limiter to control the number of concurrent outgoing requests */
  effectRateLimiter?: RateLimiter.RateLimiter
  /** Maximum number of concurrent requests allowed */
  maxConcurrentRequests?: number
}
```

## Helper Functions

- **`makeHeadersSchema(fields)`**: Utility to build the headers schema (maps raw header names + decoding schemas to the three canonical fields). It also enforces that you configure either: (a) only `retryAfter`, (b) the pair `quotaRemainingRequests` + `quotaResetsAfter`, or (c) all three – this keeps intent clear while each decoded field remains optional at runtime if the header is actually absent.

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
   * `quotaResetsAfter` is present the gate will proactively close for that duration.
   */
  readonly "quotaRemainingRequests"?: number | undefined
  /**
   * Time until the quota window resets (relative duration).
   */
  readonly "quotaResetsAfter"?: Duration.Duration | undefined
}
```

**All fields are optional** - without headers, only retry policy, Effect rate limiter, and concurrency limits apply.

- **`retryAfter`**: Wait time after 429 responses
- **`quotaRemainingRequests` + `quotaResetsAfter`**: Proactive quota management - gate closes when quota = 0

Why optional? Rate‑limit headers are often:
1. Missing or intermittently stripped by proxies / CDNs
2. Present only on certain statuses (e.g. 200 vs 429) or after a threshold
3. Inconsistently documented / unreliable across API versions

Instead of failing parsing the schema treats every field as a best‑effort hint. The limiter then checks presence manually and only applies the gate / wait logic when the decoded value exists. This keeps the system resilient.

`HttpRequestsRateLimiter.makeHeadersSchema` exists to make that mapping explicit and typesafe: you declare which raw headers feed which semantic slot and (for clarity of the control logic) you must supply either just `retryAfter` (pure 429 handling), the quota pair (`quotaRemainingRequests` + `quotaResetsAfter`) for proactive gating, or all three for full behaviour.



#### Semantics of `retryAfter` and `quotaResetsAfter`

Always **relative durations** ("wait this long"), never absolute timestamps. Convert absolute values when decoding headers so the limiter only handles durations.

Common patterns:

```ts
// 1) Header already gives SECONDS to wait (e.g. retry-after: "12")
const DurationFromSeconds = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (s) => s * 1000,
    encode: (ms) => ms / 1000
  }
)

// 2) Header gives EPOCH seconds (e.g. x-ratelimit-reset: "1734012345")
const DurationFromEpochSeconds = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (epochS) => Math.max(epochS * 1000 - Date.now(), 0),
    encode: (ms) => Math.floor((Date.now() + ms) / 1000)
  }
)

// 3) Header gives EPOCH milliseconds (e.g. x-ratelimit-reset: "1734012345123")
const DurationFromEpochMillis = S.transform(
  S.NumberFromString,
  S.DurationFromMillis,
  {
    decode: (epochMs) => Math.max(epochMs - Date.now(), 0),
    encode: (ms) => Date.now() + ms
  }
)

// 4) Header gives HTTP date (e.g. Retry-After: "Wed, 21 Oct 2015 07:28:00 GMT")
const DurationFromHttpDate = S.transform(
  S.String,
  S.DurationFromMillis,
  {
    decode: (d) => Math.max(new Date(d).getTime() - Date.now(), 0),
    encode: (ms) => new Date(Date.now() + ms).toUTCString()
  }
)
```

Rule: end up with a `Duration` that represents "time to wait from now".

Note: only `decode` matters for the limiter; `encode` is illustrative and not a round‑trip: time passes so exact reversibility is irrelevant here.

## How It Works

1. Requests pass through the rate limiter gate (FIFO semaphore)
2. Response headers parsed for rate limit info using configurable schema
3. Gate closes on 429/quota exhaustion, reopens after delay
4. Smart delays optimize concurrent request timing to avoid cascading waits

## Important Notes

⚠️ **Non-2xx Response Handling**: This library requires non-2xx HTTP responses to be treated as Effect errors for proper retry and gate control functionality. This is enforced internally using `HttpClient.filterStatusOk`, so 4xx/5xx responses will automatically flow through Effect's error channel.

## Peer Dependencies

- `effect`
- `@effect/platform`
