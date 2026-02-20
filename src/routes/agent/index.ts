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

        const member = await prisma.member.findFirst({
            where: { organizationId: orgId, userId },
            select: {
                notifyNewMessage: true,
                notifyAssigned: true,
                notifyMention: true,
                notifyResolved: true,
            },
        })
        if (!member) return reply.status(403).send({ error: 'Sem permissão.' })

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

        const unsubscribe = subscribeOrg(orgId, userId, (event) => {
            // Filtrar eventos baseado nas configurações de notificação do membro
            let shouldNotify = false

            if (event.type === 'new_message') {
                shouldNotify = member.notifyNewMessage
            } else if (event.type === 'conv_updated') {
                // Verificar se foi atribuído a este usuário
                if (event.assignedToId === userId) {
                    shouldNotify = member.notifyAssigned
                }
                // Verificar se foi resolvido
                if (event.convStatus === 'resolved') {
                    shouldNotify = shouldNotify || member.notifyResolved
                }
            }

            // Só enviar o evento se o membro tiver a notificação ativa
            if (shouldNotify) {
                reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            }
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

    // ── GET /agent/presence/online ────────────────────────────────────────────
    // Retorna lista de usuários online da organização

    app.get('/presence/online', {
        preHandler: requireAuth,
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { getOnlineUsers } = await import('../../lib/agentSse.js')
        const onlineUsers = getOnlineUsers(orgId)

        return { users: onlineUsers }
    })

    // ── POST /agent/presence/viewing ──────────────────────────────────────────
    // Registra que um usuário está visualizando uma conversa

    app.post('/presence/viewing', {
        preHandler: requireAuth,
        schema: {
            tags: ['Agent'],
            summary: 'Registra que usuário está visualizando uma conversa',
            body: {
                type: 'object',
                required: ['contactId'],
                properties: {
                    contactId: { type: 'string' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { contactId } = request.body as { contactId: string }
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, image: true },
        })

        if (!user) return reply.status(404).send({ error: 'Usuário não encontrado.' })

        const { publishToOrg, setUserOnline } = await import('../../lib/agentSse.js')

        // Registra usuário como online e visualizando esta conversa
        setUserOnline(orgId, userId, user.name, user.image, contactId)

        publishToOrg(orgId, {
            type: 'user_viewing',
            contactId,
            userId,
            userName: user.name,
            userImage: user.image,
            timestamp: new Date().toISOString(),
        })

        return { ok: true }
    })

    // ── POST /agent/presence/left ─────────────────────────────────────────────
    // Registra que um usuário saiu de uma conversa

    app.post('/presence/left', {
        preHandler: requireAuth,
        schema: {
            tags: ['Agent'],
            summary: 'Registra que usuário saiu de uma conversa',
            body: {
                type: 'object',
                required: ['contactId'],
                properties: {
                    contactId: { type: 'string' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { contactId } = request.body as { contactId: string }
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id

        const { publishToOrg } = await import('../../lib/agentSse.js')
        publishToOrg(orgId, {
            type: 'user_left',
            contactId,
            userId,
        })

        return { ok: true }
    })

    // ── POST /agent/presence/typing ───────────────────────────────────────────
    // Registra que um usuário está digitando em uma conversa

    app.post('/presence/typing', {
        preHandler: requireAuth,
        schema: {
            tags: ['Agent'],
            summary: 'Registra que usuário está digitando',
            body: {
                type: 'object',
                required: ['contactId', 'isTyping'],
                properties: {
                    contactId: { type: 'string' },
                    isTyping: { type: 'boolean' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { contactId, isTyping } = request.body as { contactId: string; isTyping: boolean }
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true },
        })

        if (!user) return reply.status(404).send({ error: 'Usuário não encontrado.' })

        const { publishToOrg } = await import('../../lib/agentSse.js')
        publishToOrg(orgId, {
            type: 'user_typing',
            contactId,
            userId,
            userName: user.name,
            isTyping,
        })

        return { ok: true }
    })
}
