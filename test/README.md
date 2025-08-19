# Tests

Test suite per il rate limiter Effect requests.

## Struttura

```
test/
├── __helpers__/          # Utilities e helper per i test
│   ├── mock-server.ts    # Mock server Effect-based 
│   └── scenarios.ts      # Scenari predefiniti
├── unit/                 # Test unitari
│   ├── headers-parsing.test.ts          # Parsing e fallback headers
│   ├── gate-mechanism.test.ts           # Gate, 429, quota exhausted, batching wait
│   ├── concurrency-and-retry.test.ts    # Concurrency + retry con retry-after
│   ├── retry-policy-no-retry-after.test.ts # Retry policy senza header retry-after
│   └── combined-limits.test.ts          # Interazione maxConcurrent + effectRateLimiter
├── integration/          # Test di integrazione
│   └── end-to-end.test.ts
└── performance/          # (placeholder per eventuali benchmark futuri)
```

## Comandi

```bash
# Esegui tutti i test
pnpm test

# Esegui test con UI
pnpm test:ui

# Esegui test una volta sola (per CI)
pnpm test:run
```

## Strategia di Testing

- **TestClock**: Controllo deterministico del tempo per gate, retry e rate windows.
- **Mock HTTP Layer**: Ogni test costruisce un HttpClient simulando headers / status specifici.
- **Gate Mechanism**: Coperti quota esaurita e 429 multipli (batching delay + sblocco corretto).
- **Retry Policy**: Casi con header retry-after e senza (policy efficace comunque).
- **Concurrency**: maxConcurrentRequests (semaforo), effectRateLimiter (token/time window) e combinazione.
- **Robustezza**: Verifica che errori di parsing headers non blocchino le richieste.

## Test Pattern

```ts
import { Effect, Duration, Fiber, TestClock } from "effect"
import * as HttpRequestsRateLimiter from "../../src" // es.

const program = Effect.gen(function*() {
  const limiter = yield* HttpRequestsRateLimiter.make({ maxConcurrentRequests: 2 })
  const requestEffect = limiter.limit(/* HttpClientRequest */ req)
  const fiber = yield* Effect.fork(requestEffect)
  yield* TestClock.adjust(Duration.seconds(30))
  const res = yield* Fiber.join(fiber)
  // expect(res.status).toBe(200)
})

// In un test: it.effect(() => program)
```

## TODO

- [x] Concurrency limiting
- [x] Retry policy (429 con e senza retry-after)
- [x] Gate mechanism (quota + 429 + batching)
- [x] Combinazione limiter esterno + semaforo interno
- [ ] Performance / load (scenari high-volume + misure)
- [ ] Test con server reale per scenari complessi (usare example/server)
- [ ] Asserzioni sul logging (capturing LogMessages)