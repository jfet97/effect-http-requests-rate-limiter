# Tests

Test suite per il rate limiter Effect requests.

## Struttura

```
test/
├── __helpers__/          # Utilities e helper per i test
│   ├── mock-server.ts    # Mock server Effect-based 
│   ├── test-utils.ts     # Utilities comuni
│   └── scenarios.ts      # Scenari predefiniti
├── unit/                 # Test unitari
│   ├── headers-parsing.test.ts
│   └── gate-mechanism.test.ts
├── integration/          # Test di integrazione
│   └── end-to-end.test.ts
└── performance/          # Test di performance (TODO)
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

- **TestClock**: Usa il TestClock di Effect per controllare il tempo nei test senza aspettare
- **Mock HTTP**: Mock delle risposte HTTP per testare scenari specifici
- **Fiber Management**: Test con fiber fork/join per verificare comportamenti asincroni

## Test Pattern

```typescript
const effect = Effect.gen(function*() {
  const rateLimiter = yield* HttpRequestsRateLimiter.make(config)
  
  // Fork per controllare il timing
  const fiber = yield* Effect.fork(rateLimiter.limit(request))
  
  // Avanza il tempo manualmente
  yield* TestUtils.advanceTime(Duration.seconds(30))
  
  // Verifica risultati
  const result = yield* Fiber.join(fiber)
  expect(result.status).toBe(200)
})

await Effect.runPromise(TestUtils.runWithTestClock(effect))
```

## TODO

- [ ] Test per concurrency limiting
- [ ] Test per retry policy
- [ ] Test di performance/load
- [ ] Test con server reale per scenari complessi