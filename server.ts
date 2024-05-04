import Fastify from 'fastify'

const fastify = Fastify()

// like marketstack
fastify.register(import('@fastify/rate-limit'), {
  max: 5,
  timeWindow: '5 seconds',
  
}).then(() => {

  fastify.get('/', async (request, reply) => {
    console.log("received")
    // simulate some work
    await new Promise(resolve => setTimeout(resolve, 900))
    reply.send({ hello: 'world' })
  })

  fastify.listen({ port: 3000 }, err => {
    if (err) throw err
    console.log('Server listening at http://localhost:3000')
  })
})
