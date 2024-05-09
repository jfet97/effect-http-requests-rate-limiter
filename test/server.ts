/* eslint-disable @typescript-eslint/no-floating-promises */
import Fastify from "fastify"

const fastify = Fastify()

// like marketstack
fastify.register(import("@fastify/rate-limit"), {
  max: 5,
  timeWindow: "3 second"
}).then(() => {
  fastify.get("/", async (_, reply) => {
    console.log("received")
    // simulate some work
    await new Promise((resolve) => setTimeout(resolve, 900))
    reply.send({ hello: "world" })
  })

  fastify.listen({ port: 3000 }, (err) => {
    if (err != null) throw err
    console.log("Server listening at http://localhost:3000")
  })
})
