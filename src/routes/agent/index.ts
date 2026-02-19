import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { subscribeOrg } from '../../lib/agentSse.js'

export default async function (app: FastifyInstance) {

    // ── GET /agent/sse ────────────────────────────────────────────────────────
    // Authenticated SSE stream. Pushes new_message and conv_updated events to
    // all agents watching this org in real-time.

    app.get('/sse', {
        preHandler: requireAuth,
        schema: {
            tags: ['Agent'],
            summary: 'SSE em tempo real para o dashboard do agente',
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // reply.hijack() bypasses Fastify's onSend hooks (including @fastify/cors),
        // so we must add CORS headers manually here.
        const origin = (request.headers.origin as string | undefined) ?? ''

        reply.hijack()
        reply.raw.writeHead(200, {
            'Content-Type':                     'text/event-stream',
            'Cache-Control':                    'no-cache',
            'Connection':                       'keep-alive',
            'X-Accel-Buffering':               'no',
            'Access-Control-Allow-Origin':      origin,
            'Access-Control-Allow-Credentials': 'true',
            'Vary':                             'Origin',
        })
        reply.raw.write('event: connected\ndata: {}\n\n')

        const unsubscribe = subscribeOrg(orgId, (event) => {
            reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        })

        const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)

        request.raw.on('close', () => {
            clearInterval(heartbeat)
            unsubscribe()
        })

        await new Promise<void>(() => {})
    })

    // ── GET /agent/members ────────────────────────────────────────────────────
    // Lists all members of the org (for the agent assignment selector).

    app.get('/members', {
        preHandler: requireAuth,
        schema: {
            tags: ['Agent'],
            summary: 'Lista agentes (membros) da organização',
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const members = await prisma.member.findMany({
            where: { organizationId: orgId },
            select: {
                id:   true,
                role: true,
                user: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: 'asc' },
        })

        return members
    })
}
