# Requests Rate Limiter

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://travis-ci.org/username/repo.svg?branch=master)](https://travis-ci.org/username/repo)
[![Coverage Status](https://coveralls.io/repos/github/username/repo/badge.svg?branch=master)](https://coveralls.io/github/username/repo?branch=master)

## Description

The Requests Rate Limiter is an effectful function that provides rate limiting functionality for web applications. It helps to prevent going over usage limits for a given resource, such as an API endpoint, and can be configured to detect `429` responses when the rate limit is exceeded for any reason.

This is the type of a Requests Rate Limiter:
```ts
(req: Http.request.ClientRequest) => Http.request.ClientRequest
```

[What is an effect?](https://effect.website/)
## Features

- Configurable rate limiter (e.g., fixed window, token bucket)
- Customizable retry policy
- Customizable maximum of concurrent requests
- Customizable schema for headers parsing

## Installation

```sh
pnpm i effect-requests-rate-limiter
```

## Example

```ts
import { makeRequestsRateLimiter, type RetryPolicy } from "effect-requests-rate-limiter"

// retryAfterMillis is needed to know how much time to wait before letting other requests pass after a 429 response
//
// remainingRequestsQuota and resetAfterMillis are needed to know how many requests are left before reaching the limit of the current window and when the limit will be reset
const RateLimitHeadersSchema = S.Schema.Struct({
  "retryAfterMillis": S.Schema.transform(
    S.Schema.NumberFromString,
    S.Schema.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.Schema.optional(),
    S.Schema.fromKey("retry-after")
  ),
  "remainingRequestsQuota": S.Schema.NumberFromString.pipe(
    S.Schema.optional(),
    S.Schema.fromKey("x-ratelimit-remaining")
  ),
  "resetAfterMillis": S.Schema.transform(
    S.Schema.NumberFromString,
    S.Schema.Number,
    // from seconds to milliseconds
    { encode: (n) => n / 1000, decode: (n) => n * 1000 }
  ).pipe(
    S.Schema.optional(),
    S.Schema.fromKey("x-ratelimit-reset")
  )
})

const MyRetryPolicy = Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential("200 millis")),
  while: (err) => err._tag === "ResponseError" && err.response.status === 429,
  times: 5
}) satisfies RetryPolicy

const MyRateLimiter = RateLimiter.make({
  limit: 5,
  algorithm: "fixed-window",
  interval: Duration.seconds(3)
})

const main = Effect.gen(function*($) {

  const requestsRateLimiter = yield* makeRequestsRateLimiter({
    rateLimitHeadersSchema: RateLimitHeadersSchema,
    retryPolicy: MyRetryPolicy,
    rateLimiter: yield* MyRateLimiter,
    maxConcurrentRequests: 4
  })

  const aRequest = Http.request.get("https://jsonplaceholder.typicode.com/todos/1")
  const rateLimitedRequest = requestRateLimiter(aRequest)

  // ...
})

NodeRuntime.runMain(main.pipe(
  // fetchOk or similar must be used so that non 2xx responses are considered errors
  Effect.provideService(Http.client.Client, Http.client.fetchOk)
))
```

## Peer dependencies

"@effect/platform", "@effect/schema", "effect"