import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, TestClock, TestContext } from "effect"

export const makeTestRequest = (url: string): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(url)

export const runWithTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | TestContext.TestContext> =>
  effect.pipe(Effect.provide(TestContext.TestContext))

export const advanceTime = (duration: Duration.Duration) =>
  TestClock.adjust(duration)

export const expectEventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Duration = Duration.seconds(5)
): Effect.Effect<A, E, R | TestContext.TestContext> =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.provide(TestContext.TestContext)
  )

export const withMockHttpClient = <A, E, R>(
  responses: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const mockClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = HttpClientRequest.getUrl(request).href
      const response = responses[url]
      
      if (!response) {
        throw new Error(`No mock response configured for URL: ${url}`)
      }
      
      return HttpClientResponse.fromWeb(
        request,
        new Response(response.body || "", {
          status: response.status,
          statusText: response.status === 200 ? "OK" : "Error", 
          headers: response.headers ?? {}
        })
      )
    }).pipe(Effect.flatten)
  )
  
  const mockLayer = Layer.succeed(HttpClient.HttpClient, mockClient)
  const testLayer = Layer.merge(mockLayer, TestContext.TestContext)
  
  return effect.pipe(
    Effect.provide(testLayer),
    Effect.scoped
  )
}

export const TestUtils = {
  makeTestRequest,
  runWithTestClock,
  advanceTime,
  expectEventually,
  withMockHttpClient
}