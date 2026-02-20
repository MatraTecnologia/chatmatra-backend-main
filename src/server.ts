import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import ScalarApiReference from '@scalar/fastify-api-reference'
import autoload from '@fastify/autoload'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { initializePresenceSystem } from './lib/presence.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// bodyLimit aumentado para 10 MB para suportar logos em base64 (imagem 2 MB ≈ 2,7 MB em base64)
const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 })

await app.register(fastifyCors, {
    // Reflete a origem da request — necessário para suportar tanto o dashboard
    // (credenciais de sessão) quanto o widget embarcado em sites externos.
    // A segurança das rotas protegidas é garantida pelo requireAuth (sessão httpOnly),
    // e das rotas widget pela validação de apiKey + contactId no handler.
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Widget-Key', 'X-Contact-Id'],
    strictPreflight: false,
})

await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/static/',
    decorateReply: false,
})

await app.register(fastifySwagger, {
    openapi: {
        info: {
            title: 'MatraChat API',
            version: '1.0.0',
        },
    },
})

await app.register(ScalarApiReference, {
    routePrefix: '/docs',
})

await app.register(autoload, {
    dir: join(__dirname, 'routes'),
})

await app.listen({ port: Number(process.env.PORT) || 3333, host: '0.0.0.0' })

// Inicializa Socket.io para presença em tempo real
const httpServer = app.server
initializePresenceSystem(httpServer)

console.log(`🚀 Servidor rodando em http://localhost:${Number(process.env.PORT) || 3333}`)
console.log(`📡 WebSocket (Socket.io) pronto para conexões`)
