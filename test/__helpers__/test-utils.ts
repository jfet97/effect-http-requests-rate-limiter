import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Duration, Effect, Layer, TestClock, TestContext } from "effect"

/**
 * Lightweight utilities kept for backwards compatibility in case external code still imports them.
 * Prefer using @effect/vitest helpers (it.effect / it.scoped) directly in new tests.
 */

export const makeTestRequest = (url: string): HttpClientRequest.HttpClientRequest => HttpClientRequest.get(url)

export const runWithTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => effect.pipe(Effect.provide(TestContext.TestContext))

export const advanceTime = (duration: Duration.Duration) => TestClock.adjust(duration)

export const expectEventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Duration = Duration.seconds(5)
) =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.provide(TestContext.TestContext)
  )

export const withMockHttpClient = <A, E, R>(
  matcher: (
    req: HttpClientRequest.HttpClientRequest
  ) => { status: number; headers?: Record<string, string>; body?: string } | undefined,
  effect: Effect.Effect<A, E, R>
) => {
  const mockClient = HttpClient.make((request) =>
    Effect.gen(function*() {
      const response = matcher(request)
      if (!response) {
        throw new Error("No mock response configured for request")
      }
      const webResponse = new Response(response.body ?? "", {
        status: response.status,
        statusText: response.status >= 200 && response.status < 300 ? "OK" : "Error",
        headers: response.headers ?? {}
      })
      return HttpClientResponse.fromWeb(request, webResponse)
    })
  )
  return effect.pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))
}

// Deprecated - use @effect/vitest it.effect or it.scoped instead
export const TestUtils = {
  makeTestRequest,
  runWithTestClock,
  advanceTime,
  expectEventually,
  withMockHttpClient
}
