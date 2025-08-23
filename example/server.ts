import rateLimit from "@fastify/rate-limit"
import Fastify from "fastify"
import { setTimeout as sleep } from "node:timers/promises"

const fastify = Fastify({ logger: true })

await fastify.register(rateLimit, {
  max: 5,
  timeWindow: "10 seconds"
})

fastify.get("/", async (_req, reply) => {
  fastify.log.info("received")
  await sleep(900)
  await reply.send({ hello: "world" })
})

await fastify
  .listen({ port: 5678 })
  .then(() => {
    fastify.log.info("Server listening at http://localhost:3000")
  })
  .catch((err: unknown) => {
    fastify.log.error({ err }, "Failed to start server")
    throw err
  })
