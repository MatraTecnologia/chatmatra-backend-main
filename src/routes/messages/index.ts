import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { publish } from '../../lib/widgetSse.js'

// ─── Helper: Substitui variáveis na assinatura ────────────────────────────────
function applySignature(content: string, signature: string, user: { name: string; email: string; phone?: string | null }): string {
    const processedSignature = signature
        .replace(/\{\{name\}\}/g, user.name)
        .replace(/\{\{email\}\}/g, user.email)
        .replace(/\{\{phone\}\}/g, user.phone || user.email)

    return `${content}\n\nassinatura:\n${processedSignature}`
}

export default async function (app: FastifyInstance) {

    // GET /messages?contactId=&orgId=&limit=&before=<ISO-date>
    // Sem 'before' → retorna as mensagens mais recentes (limit)
    // Com 'before' → retorna mensagens anteriores à data informada
    // Legado: se 'page' for informado, usa paginação offset clássica
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Messages'],
            summary: 'Lista mensagens de um contato',
            querystring: {
                type: 'object',
                required: ['contactId', 'orgId'],
                properties: {
                    contactId: { type: 'string' },
                    orgId:     { type: 'string' },
                    page:      { type: 'integer', minimum: 1 },
                    limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    before:    { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { contactId, orgId, page, limit = 50, before } = request.query as {
            contactId: string
            orgId: string
            page?: number
            limit?: number
            before?: string
        }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Modo cursor: sem page explícito → retorna as mais recentes (ou anteriores a 'before')
        if (page === undefined) {
            const where = {
                contactId,
                organizationId: orgId,
                ...(before ? { createdAt: { lt: new Date(before) } } : {}),
            }
            const rows = await prisma.message.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: limit,
                select: {
                    id: true,
                    direction: true,
                    type: true,
                    content: true,
                    status: true,
                    channelId: true,
                    externalId: true,
                    createdAt: true,
                },
            })
            // Inverte para exibição cronológica (mais antigas no topo)
            const messages = rows.reverse()
            return { hasMore: rows.length === limit, messages }
        }

        // Modo legado com page/offset
        const [total, messages] = await Promise.all([
            prisma.message.count({ where: { contactId, organizationId: orgId } }),
            prisma.message.findMany({
                where: { contactId, organizationId: orgId },
                orderBy: { createdAt: 'asc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true,
                    direction: true,
                    type: true,
                    content: true,
                    status: true,
                    channelId: true,
                    externalId: true,
                    createdAt: true,
                },
            }),
        ])

        return { total, page, limit, messages }
    })

    // POST /messages — salva uma mensagem enviada/nota
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Messages'],
            summary: 'Salva uma mensagem ou nota interna',
            body: {
                type: 'object',
                required: ['orgId', 'contactId', 'content', 'type', 'direction'],
                properties: {
                    orgId:      { type: 'string' },
                    contactId:  { type: 'string' },
                    channelId:  { type: 'string' },
                    direction:  { type: 'string', enum: ['outbound', 'inbound'] },
                    type:       { type: 'string', enum: ['text', 'note'] },
                    content:    { type: 'string', minLength: 1 },
                    status:     { type: 'string' },
                    externalId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as {
            orgId: string
            contactId: string
            channelId?: string
            direction: 'outbound' | 'inbound'
            type: 'text' | 'note'
            content: string
            status?: string
            externalId?: string
        }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: body.orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // ─── ASSINATURA AUTOMÁTICA: Adiciona assinatura se outbound + text + usuário tem assinatura configurada ───
        let finalContent = body.content
        if (body.direction === 'outbound' && body.type === 'text') {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { signature: true, name: true, email: true, phone: true },
            })

            if (user?.signature) {
                finalContent = applySignature(body.content, user.signature, {
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                })
            }
        }

        const message = await prisma.message.create({
            data: {
                organizationId: body.orgId,
                contactId:      body.contactId,
                channelId:      body.channelId,
                direction:      body.direction,
                type:           body.type,
                content:        finalContent, // Usa finalContent que pode conter assinatura
                status:         body.status ?? 'sent',
                externalId:     body.externalId,
            },
        })

        // Push to widget SSE stream when an outbound message is saved for an api channel
        if (body.direction === 'outbound' && body.channelId) {
            const channel = await prisma.channel.findUnique({
                where: { id: body.channelId },
                select: { type: true },
            })
            if (channel?.type === 'api') {
                publish(body.contactId, {
                    id:         message.id,
                    contactId:  message.contactId,
                    direction:  message.direction as 'outbound' | 'inbound',
                    type:       message.type as 'text' | 'note',
                    content:    message.content,
                    status:     message.status,
                    createdAt:  message.createdAt.toISOString(),
                })
            }
        }

        return reply.status(201).send(message)
    })
}
