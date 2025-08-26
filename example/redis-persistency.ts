/**
 * Example implementation of PersistencyLayer using Redis
 *
 * This is a demonstration of how to implement persistent state sharing
 * across multiple rate limiter instances using Redis as the backend.
 */

import { Duration, Effect, Queue, Schema as S } from "effect"
import type * as HttpRequestsRateLimiter from "../src/index.js"

// Mock Redis interface for demonstration purposes
// In a real implementation, you would use a Redis client like @upstash/redis or ioredis
interface RedisClient {
  set: (key: string, value: string, options?: { ex: number }) => Promise<string>
  get: (key: string) => Promise<string | null>
  publish: (channel: string, message: string) => Promise<number>
  subscribe: (channel: string, callback: (message: string) => void) => Promise<void>
  hset: (key: string, field: string, value: string) => Promise<number>
  hget: (key: string, field: string) => Promise<string | null>
  hgetall: (key: string) => Promise<Record<string, string>>
}

// Schema for serializing/deserializing rate limit events
const RateLimitEventSchema = S.Struct({
  type: S.Literal("gate_close", "gate_open", "quota_exhausted", "rate_limit_429"),
  duration: S.optional(S.Number.pipe(S.transform(S.Number, S.DurationFromMillis, {
    decode: Duration.millis,
    encode: Duration.toMillis
  }))),
  timestamp: S.Number.pipe(S.transform(S.Number, S.DurationFromMillis, {
    decode: Duration.millis,
    encode: Duration.toMillis
  })),
  context: S.optional(S.String)
})

// Configuration for Redis-based persistency
interface RedisConfig {
  /** Redis client instance */
  readonly client: RedisClient
  /** Prefix for Redis keys to avoid conflicts */
  readonly keyPrefix?: string
  /** Channel name for publishing/subscribing to events */
  readonly eventChannel?: string
  /** TTL for quota state in seconds */
  readonly quotaTTL?: number
}

/**
 * Creates a Redis-based PersistencyLayer implementation
 *
 * Features:
 * - Publishes rate limit events to a Redis channel for real-time sharing
 * - Stores shared quota state in Redis hash with TTL
 * - Provides fallback behavior when Redis operations fail
 *
 * @param config Redis configuration
 * @returns Effect that creates a PersistencyLayer
 */
export const makeRedisPersistencyLayer = (
  config: RedisConfig
): Effect.Effect<HttpRequestsRateLimiter.PersistencyLayer> =>
  Effect.gen(function*() {
    const keyPrefix = config.keyPrefix ?? "rate-limiter"
    const eventChannel = config.eventChannel ?? `${keyPrefix}:events`
    const quotaTTL = config.quotaTTL ?? 300 // 5 minutes default

    // Queue for incoming events from Redis
    const incomingEvents = yield* Queue.unbounded<HttpRequestsRateLimiter.RateLimitEvent>()

    // Set up Redis subscription for events
    yield* Effect.promise(async () => {
      await config.client.subscribe(eventChannel, (message) => {
        try {
          const eventData = JSON.parse(message)
          const event = S.decodeUnknownSync(RateLimitEventSchema)(eventData)
          Queue.unsafeOffer(incomingEvents, event)
        } catch (error) {
          // Log error but don't crash - best effort delivery
          console.warn("Failed to parse rate limit event from Redis:", error)
        }
      })
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`Failed to subscribe to Redis events: ${String(error)}`))
    )

    const persistencyLayer: HttpRequestsRateLimiter.PersistencyLayer = {
      publishEvent: (event) =>
        Effect.tryPromise({
          try: async () => {
            const serializedEvent = JSON.stringify(S.encodeSync(RateLimitEventSchema)(event))
            return await config.client.publish(eventChannel, serializedEvent)
          },
          catch: (error) => new Error(`Failed to publish event to Redis: ${String(error)}`)
        }).pipe(
          Effect.catchAll((error) => Effect.logWarning(`Redis publish failed: ${String(error)}`)),
          Effect.asVoid
        ),

      subscribeToEvents: Effect.succeed(incomingEvents),

      getSharedQuota: (context = "default") =>
        Effect.tryPromise({
          try: async () => await config.client.hgetall(`${keyPrefix}:quota:${context}`),
          catch: (error) => new Error(`Failed to get shared quota from Redis: ${String(error)}`)
        }).pipe(
          Effect.map((data) => ({
            remaining: data.remaining ? parseInt(data.remaining, 10) : undefined,
            resetsAt: data.resetsAt ? Duration.millis(parseInt(data.resetsAt, 10)) : undefined
          })),
          Effect.catchAll((error) =>
            // Log warning but return empty state - graceful degradation
            Effect.logWarning(`Redis get quota failed: ${String(error)}`).pipe(
              Effect.as({ remaining: undefined, resetsAt: undefined })
            )
          )
        ),

      updateSharedQuota: (remaining, resetsAt, context = "default") =>
        Effect.tryPromise({
          try: async () => {
            const key = `${keyPrefix}:quota:${context}`
            await config.client.hset(key, "remaining", remaining.toString())
            await config.client.hset(key, "resetsAt", Duration.toMillis(resetsAt).toString())
            // Set TTL to prevent stale data
            await config.client.set(key, "1", { ex: quotaTTL })
            return void 0
          },
          catch: (error) => new Error(`Failed to update shared quota in Redis: ${String(error)}`)
        }).pipe(
          Effect.catchAll((error) => Effect.logWarning(`Redis update quota failed: ${String(error)}`)),
          Effect.asVoid
        )
    }

    return persistencyLayer
  })

/**
 * Example usage of Redis persistency layer
 *
 * This shows how to integrate the Redis-based persistency layer
 * with the HTTP requests rate limiter.
 */
export const exampleUsage = Effect.gen(function*() {
  // Mock Redis client for demonstration
  const mockRedis: RedisClient = {
    set: async (key, value, options) => "OK",
    get: async (key) => null,
    publish: async (channel, message) => 1,
    subscribe: async (channel, callback) => void 0,
    hset: async (key, field, value) => 1,
    hget: async (key, field) => null,
    hgetall: async (key) => ({})
  }

  // Create Redis persistency layer
  const persistencyLayer = yield* makeRedisPersistencyLayer({
    client: mockRedis,
    keyPrefix: "my-app-rate-limiter",
    eventChannel: "my-app-rate-limit-events",
    quotaTTL: 600 // 10 minutes
  })

  // Create headers schema
  const rateLimitHeadersSchema = HttpRequestsRateLimiter.makeHeadersSchema({
    retryAfter: {
      fromKey: "retry-after",
      schema: S.NumberFromString.pipe(
        S.transform(S.Number, S.DurationFromMillis, {
          decode: (s) => s * 1000,
          encode: (ms) => ms / 1000
        })
      )
    },
    quotaRemainingRequests: { fromKey: "x-ratelimit-remaining", schema: S.NumberFromString.pipe(S.NonNegative) },
    quotaResetsAfter: {
      fromKey: "x-ratelimit-reset",
      schema: S.NumberFromString.pipe(
        S.transform(S.Number, S.DurationFromMillis, {
          decode: (s) => s * 1000,
          encode: (ms) => ms / 1000
        })
      )
    }
  })

  // Example of how this would be used (pseudo-code)
  /*
  const httpClient = yield* HttpClient.HttpClient
  const rateLimiter = yield* HttpRequestsRateLimiter.make(httpClient, {
    rateLimiterHeadersSchema,
    persistency: persistencyLayer,
    maxConcurrentRequests: 10
  })

  // Now all instances using this persistency layer will share rate limit state
  const response = yield* rateLimiter.execute(
    HttpClientRequest.get("https://api.example.com/data")
  )
  */

  return "Redis persistency layer created successfully"
})

/**
 * Advanced Redis configuration example with clustering support
 */
export interface RedisClusterConfig extends Omit<RedisConfig, "client"> {
  /** Redis cluster nodes */
  readonly nodes: Array<{ host: string; port: number }>
  /** Redis auth password */
  readonly password?: string
  /** Connection pool size */
  readonly poolSize?: number
}

/**
 * Factory for creating production-ready Redis persistency with clustering
 *
 * @param config Redis cluster configuration
 * @returns Effect that creates a clustered Redis persistency layer
 */
export const makeRedisClusterPersistencyLayer = (
  config: RedisClusterConfig
): Effect.Effect<HttpRequestsRateLimiter.PersistencyLayer> =>
  Effect.gen(function*() {
    // In a real implementation, you would create a Redis cluster client here
    // For example, using ioredis:
    // const Redis = require('ioredis')
    // const cluster = new Redis.Cluster(config.nodes, {
    //   redisOptions: { password: config.password },
    //   maxRetriesPerRequest: 3,
    //   retryDelayOnFailover: 100
    // })

    // Mock cluster client for demonstration
    const clusterClient: RedisClient = {
      set: async (key, value, options) => "OK",
      get: async (key) => null,
      publish: async (channel, message) => config.nodes.length,
      subscribe: async (channel, callback) => void 0,
      hset: async (key, field, value) => 1,
      hget: async (key, field) => null,
      hgetall: async (key) => ({})
    }

    return yield* makeRedisPersistencyLayer({
      client: clusterClient,
      keyPrefix: config.keyPrefix,
      eventChannel: config.eventChannel,
      quotaTTL: config.quotaTTL
    })
  })
