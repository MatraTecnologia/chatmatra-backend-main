import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { subscribe } from '../../lib/widgetSse.js'
import { publishToOrg } from '../../lib/agentSse.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type ApiChannelConfig = {
    apiKey: string
    widgetConfig?: {
        primaryColor?: string
        welcomeText?: string
        agentName?: string
        agentAvatarUrl?: string | null
        position?: 'left' | 'right'
    }
}

type WidgetConfig = {
    primaryColor: string
    welcomeText: string
    agentName: string
    agentAvatarUrl: string | null
    position: 'left' | 'right'
}

// ─── CORS Headers ─────────────────────────────────────────────────────────────

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key, X-Contact-Id',
    'Access-Control-Max-Age': '86400',
}

function setCors(reply: FastifyReply) {
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        reply.header(k, v)
    }
}

// ─── Helper: resolve channel from api key ─────────────────────────────────────

async function resolveChannel(apiKey: string): Promise<{
    channel: { id: string; organizationId: string; config: ApiChannelConfig }
    widgetConfig: WidgetConfig
} | null> {
    if (!apiKey) return null

    // Use raw query to filter on JSONB field for performance
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM channels
        WHERE type = 'api'
          AND config->>'apiKey' = ${apiKey}
        LIMIT 1
    `
    if (!rows.length) return null

    const channel = await prisma.channel.findUnique({
        where: { id: rows[0].id },
        select: { id: true, organizationId: true, config: true },
    })
    if (!channel) return null

    const cfg = channel.config as ApiChannelConfig
    const wc = cfg.widgetConfig ?? {}

    return {
        channel: channel as { id: string; organizationId: string; config: ApiChannelConfig },
        widgetConfig: {
            primaryColor:  wc.primaryColor  ?? '#6366f1',
            welcomeText:   wc.welcomeText   ?? 'Olá! Como posso ajudar?',
            agentName:     wc.agentName     ?? 'Suporte',
            agentAvatarUrl: wc.agentAvatarUrl ?? null,
            position:      wc.position      ?? 'right',
        },
    }
}

// ─── Helper: validate contact belongs to channel ──────────────────────────────

async function resolveContact(contactId: string, channelId: string, orgId: string) {
    return prisma.contact.findFirst({
        where: { id: contactId, channelId, organizationId: orgId },
        select: { id: true, name: true },
    })
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export default async function (app: FastifyInstance) {

    // ── GET /widget/config ────────────────────────────────────────────────────
    // Returns public widget display config (no secrets).
    // X-Widget-Key: <apiKey>

    app.get('/config', {
        schema: { tags: ['Widget'], summary: 'Retorna a configuração pública do widget' },
    }, async (request, reply) => {
        setCors(reply)
        const apiKey = request.headers['x-widget-key'] as string
        const resolved = await resolveChannel(apiKey)
        if (!resolved) return reply.status(401).send({ error: 'API key inválida.' })
        return resolved.widgetConfig
    })

    // ── POST /widget/session ──────────────────────────────────────────────────
    // Creates or resumes a visitor contact session.
    // X-Widget-Key: <apiKey>
    // Body: { name, email }

    app.post('/session', {
        schema: {
            tags: ['Widget'],
            summary: 'Inicia ou retoma sessão do visitante',
            body: {
                type: 'object',
                required: ['name', 'email'],
                properties: {
                    name:  { type: 'string', minLength: 1 },
                    email: { type: 'string', minLength: 1 },
                    phone: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        setCors(reply)
        const apiKey = request.headers['x-widget-key'] as string
        const resolved = await resolveChannel(apiKey)
        if (!resolved) return reply.status(401).send({ error: 'API key inválida.' })

        const { channel } = resolved
        const { name, email, phone } = request.body as { name: string; email: string; phone?: string }

        // Find existing contact for this visitor (by email + channel)
        const contact = await prisma.contact.findFirst({
            where: { organizationId: channel.organizationId, channelId: channel.id, email },
            select: { id: true, name: true, phone: true },
        })

        if (contact) {
            // Only update fields that changed and have a new non-empty value
            const updates: Record<string, string> = {}
            if (name  && contact.name  !== name)  updates.name  = name
            if (phone && contact.phone !== phone)  updates.phone = phone

            if (Object.keys(updates).length > 0) {
                const updated = await prisma.contact.update({
                    where: { id: contact.id },
                    data: updates,
                    select: { id: true, name: true },
                })
                return { contactId: updated.id, name: updated.name, isNew: false }
            }
            return { contactId: contact.id, name: contact.name, isNew: false }
        }

        // Create new contact
        const newContact = await prisma.contact.create({
            data: {
                organizationId: channel.organizationId,
                channelId: channel.id,
                name,
                email,
                ...(phone ? { phone } : {}),
            },
            select: { id: true, name: true },
        })

        return reply.status(201).send({ contactId: newContact.id, name: newContact.name, isNew: true })
    })

    // ── GET /widget/messages ──────────────────────────────────────────────────
    // Returns message history for the visitor's conversation.
    // X-Widget-Key: <apiKey>
    // X-Contact-Id: <contactId>

    app.get('/messages', {
        schema: { tags: ['Widget'], summary: 'Histórico de mensagens do visitante' },
    }, async (request, reply) => {
        setCors(reply)
        const apiKey    = request.headers['x-widget-key']   as string
        const contactId = request.headers['x-contact-id']   as string

        const resolved = await resolveChannel(apiKey)
        if (!resolved) return reply.status(401).send({ error: 'API key inválida.' })

        const { channel } = resolved
        const contact = await resolveContact(contactId, channel.id, channel.organizationId)
        if (!contact) return reply.status(403).send({ error: 'Sessão inválida.' })

        const messages = await prisma.message.findMany({
            where: { contactId, organizationId: channel.organizationId },
            orderBy: { createdAt: 'asc' },
            take: 100,
            select: { id: true, direction: true, type: true, content: true, status: true, createdAt: true },
        })

        return { messages }
    })

    // ── POST /widget/messages ─────────────────────────────────────────────────
    // Saves an inbound message from the website visitor.
    // X-Widget-Key: <apiKey>
    // X-Contact-Id: <contactId>
    // Body: { content }

    app.post('/messages', {
        schema: {
            tags: ['Widget'],
            summary: 'Envia mensagem do visitante',
            body: {
                type: 'object',
                required: ['content'],
                properties: { content: { type: 'string', minLength: 1 } },
            },
        },
    }, async (request, reply) => {
        setCors(reply)
        const apiKey    = request.headers['x-widget-key']   as string
        const contactId = request.headers['x-contact-id']   as string

        const resolved = await resolveChannel(apiKey)
        if (!resolved) return reply.status(401).send({ error: 'API key inválida.' })

        const { channel } = resolved
        const contact = await resolveContact(contactId, channel.id, channel.organizationId)
        if (!contact) return reply.status(403).send({ error: 'Sessão inválida.' })

        const { content } = request.body as { content: string }

        const message = await prisma.message.create({
            data: {
                organizationId: channel.organizationId,
                contactId,
                channelId: channel.id,
                direction: 'inbound',
                type: 'text',
                content,
                status: 'sent',
            },
            select: { id: true, direction: true, type: true, content: true, status: true, createdAt: true },
        })

        // Publish to agent dashboard SSE streams
        publishToOrg(channel.organizationId, {
            type: 'new_message',
            contactId,
            message: {
                id: message.id,
                direction: 'inbound',
                type: message.type,
                content: message.content,
                status: message.status,
                createdAt: message.createdAt.toISOString(),
            },
        })

        return reply.status(201).send(message)
    })

    // ── GET /widget/sse/:contactId ────────────────────────────────────────────
    // SSE stream. Agent outbound replies are pushed here in real-time.
    // ?key=<apiKey>  (EventSource does not support custom headers)

    app.get('/sse/:contactId', {
        schema: { tags: ['Widget'], summary: 'Stream SSE de respostas do agente' },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { contactId } = request.params as { contactId: string }
        const apiKey = (request.query as Record<string, string>).key

        setCors(reply)

        const resolved = await resolveChannel(apiKey)
        if (!resolved) return reply.status(401).send({ error: 'API key inválida.' })

        const { channel } = resolved
        const contact = await resolveContact(contactId, channel.id, channel.organizationId)
        if (!contact) return reply.status(403).send({ error: 'Sessão inválida.' })

        // Hijack the response so Fastify does not finalize it
        reply.hijack()
        reply.raw.writeHead(200, {
            'Content-Type':                'text/event-stream',
            'Cache-Control':               'no-cache',
            'Connection':                  'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering':           'no', // disable nginx buffering
        })

        // Initial connected event
        reply.raw.write('event: connected\ndata: {}\n\n')

        // Subscribe to pub/sub
        const unsubscribe = subscribe(contactId, (msg) => {
            reply.raw.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
        })

        // Heartbeat every 25 seconds to keep connection alive through proxies
        const heartbeat = setInterval(() => {
            reply.raw.write(': ping\n\n')
        }, 25_000)

        // Cleanup when client disconnects
        request.raw.on('close', () => {
            clearInterval(heartbeat)
            unsubscribe()
        })

        // Keep the handler alive (never resolve the promise)
        await new Promise<void>(() => {})
    })
}
