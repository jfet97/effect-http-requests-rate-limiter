import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, TestClock, TestContext } from "effect"

export const makeTestRequest = (url: string): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(url)

export const runWithTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(Effect.provide(TestContext.TestContext))

export const advanceTime = (duration: Duration.Duration) =>
  TestClock.adjust(duration)

export const expectEventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Duration = Duration.seconds(5)
) =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.provide(TestContext.TestContext)
  )

export const withMockHttpClient = <A, E, R>(
  responses: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
  effect: Effect.Effect<A, E, R>
) => {
  const mockClient = HttpClient.make((request) =>
    Effect.gen(function*() {
      const url = HttpClientRequest.getUrl(request).href
      const response = responses[url]
      
      if (!response) {
        throw new Error(`No mock response configured for URL: ${url}`)
      }
      
      const webResponse = new Response(response.body || "", {
        status: response.status,
        statusText: response.status >= 200 && response.status < 300 ? "OK" : "Error", 
        headers: response.headers ?? {}
      })
      
      return HttpClientResponse.fromWeb(request, webResponse)
    })
  )
  
  const mockLayer = Layer.succeed(HttpClient.HttpClient, mockClient)
  
  return effect.pipe(Effect.provide(mockLayer))
}

// Deprecated - use @effect/vitest it.effect or it.scoped instead
export const runEffectTest = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => 
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(
        TestContext.TestContext,
        NodeHttpClient.layerUndici
      )),
      Effect.scoped
    )
  )

export const TestUtils = {
  makeTestRequest,
  runWithTestClock,
  advanceTime,
  expectEventually,
  withMockHttpClient,
  runEffectTest
}