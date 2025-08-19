# Tests

Test suite for the Effect HTTP requests rate limiter.

## Structure

```
test/
├── __helpers__/          # Utilities & helpers for tests
│   ├── mock-server.ts    # Effect-based mock server
│   └── scenarios.ts      # Predefined scenarios
├── unit/                 # Unit tests
│   ├── headers-parsing.test.ts          # Header parsing & fallbacks
│   ├── gate-mechanism.test.ts           # Gate, 429, quota exhausted, batching wait
│   ├── concurrency-and-retry.test.ts    # Concurrency + retry with retry-after
│   ├── retry-policy-no-retry-after.test.ts # Retry policy without retry-after header
│   └── combined-limits.test.ts          # Interaction maxConcurrent + effectRateLimiter
├── integration/          # Integration tests
│   └── end-to-end.test.ts
└── performance/          # (placeholder for possible future benchmarks)
```

## Commands

```bash
# Run all tests
pnpm test

# Run tests with UI
pnpm test:ui

# Run tests once (for CI)
pnpm test:run
```

## Testing Strategy

- **TestClock**: Deterministic time control for gate, retry, and rate windows.
- **Mock HTTP Layer**: Each test builds an HttpClient simulating specific headers / statuses.
- **Gate Mechanism**: Covers exhausted quota and multiple 429s (batched delay + correct reopening).
- **Retry Policy**: Cases with and without retry-after header (policy still effective).
- **Concurrency**: maxConcurrentRequests (semaphore), effectRateLimiter (token/time window), and their combination.
- **Robustness**: Ensures header parsing errors do not block requests.

## Test Pattern

```ts
import { Effect, Duration, Fiber, TestClock } from "effect"
import * as HttpRequestsRateLimiter from "../../src" // example

const program = Effect.gen(function*() {
  const limiter = yield* HttpRequestsRateLimiter.make({ maxConcurrentRequests: 2 })
  const requestEffect = limiter.limit(/* HttpClientRequest */ req)
  const fiber = yield* Effect.fork(requestEffect)
  yield* TestClock.adjust(Duration.seconds(30))
  const res = yield* Fiber.join(fiber)
  // expect(res.status).toBe(200)
})

// In a test: it.effect(() => program)
```

## TODO

- [x] Concurrency limiting
- [x] Retry policy (429 with and without retry-after)
- [x] Gate mechanism (quota + 429 + batching)
- [x] Combination external limiter + internal semaphore
- [ ] Performance / load (high-volume scenarios + measurements)
- [ ] Tests with real server for complex scenarios (use example/server)
- [ ] Assertions on logging (capturing LogMessages)