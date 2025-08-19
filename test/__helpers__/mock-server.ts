import { HttpServerResponse } from "@effect/platform"
import { Duration, Effect, pipe, Ref } from "effect"

export interface MockServerConfig {
  readonly port: number
  readonly responses: MockResponse[]
}

export interface MockResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: string
  readonly delay?: Duration.Duration
}

export const make429Response = (retryAfter: Duration.Duration): MockResponse => ({
  status: 429,
  headers: {
    "retry-after": Duration.toSeconds(retryAfter).toString(),
    "content-type": "application/json"
  },
  body: JSON.stringify({ error: "Rate limit exceeded" })
})

export const makeQuotaResponse = (remaining: number, quotaResetsAfter: Duration.Duration): MockResponse => ({
  status: 200,
  headers: {
    "x-ratelimit-remaining": remaining.toString(),
    "x-ratelimit-reset": Duration.toSeconds(quotaResetsAfter).toString(),
    "content-type": "application/json"
  },
  body: JSON.stringify({ success: true })
})

export const makeSuccessResponse = (): MockResponse => ({
  status: 200,
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({ success: true })
})

export interface MockServerStats {
  readonly requestCount: number
  readonly requestTimes: Date[]
}

export const makeMockServer = (config: MockServerConfig) =>
  Effect.gen(function*() {
    const requestCountRef = yield* Ref.make(0)
    const requestTimesRef = yield* Ref.make<Date[]>([])
    let currentResponseIndex = 0

    const getStats = (): Effect.Effect<MockServerStats> =>
      Effect.gen(function*() {
        const requestCount = yield* Ref.get(requestCountRef)
        const requestTimes = yield* Ref.get(requestTimesRef)
        return { requestCount, requestTimes }
      })

    const getNextResponse = (): MockResponse => {
      const { responses } = config
      if (responses.length === 0) {
        throw new Error("MockServerConfig.responses must contain at least one response")
      }
      const response = responses.at(currentResponseIndex)
      if (!response) {
        throw new Error(`Invariant violated: no response at index ${currentResponseIndex}`)
      }
      currentResponseIndex = (currentResponseIndex + 1) % responses.length
      return response
    }

    const handleRequest = (response: HttpServerResponse.HttpServerResponse) =>
      Effect.gen(function*() {
        yield* Ref.update(requestCountRef, (count) => count + 1)
        yield* Ref.update(requestTimesRef, (times) => [...times, new Date()])

        const mockResponse = getNextResponse()

        if (mockResponse.delay) {
          yield* Effect.sleep(mockResponse.delay)
        }

        const eff = pipe(
          response,
          HttpServerResponse.setStatus(mockResponse.status),
          HttpServerResponse.setHeaders(mockResponse.headers),
          Effect.andThen(HttpServerResponse.text(mockResponse.body ?? ""))
        )
        return eff
      })

    return { getStats, handleRequest }
  })

export const MockServer = {
  make: makeMockServer,
  make429Response,
  makeQuotaResponse,
  makeSuccessResponse
}
