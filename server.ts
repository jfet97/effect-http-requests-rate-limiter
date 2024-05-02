import Fastify from 'fastify'

const fastify = Fastify()

// like marketstack
fastify.register(import('@fastify/rate-limit'), {
  max: 5,
  timeWindow: '5 seconds'
}).then(() => {

  fastify.get('/', (request, reply) => {
    console.log("received")
    reply.send({ hello: 'world' })
  })

  fastify.listen({ port: 3000 }, err => {
    if (err) throw err
    console.log('Server listening at http://localhost:3000')
  })
})
