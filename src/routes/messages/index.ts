import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { emitWidgetMessage } from '../../lib/presence.js'
import { publishToOrg } from '../../lib/agentSse.js'

export default async function (app: FastifyInstance) {

    // GET /messages?contactId=&limit=&before=<ISO-date>
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
                required: ['contactId'],
                properties: {
                    contactId: { type: 'string' },
                    page:      { type: 'integer', minimum: 1 },
                    limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    before:    { type: 'string' },
                    after:     { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { contactId, page, limit = 50, before, after } = request.query as {
            contactId: string
            page?: number
            limit?: number
            before?: string
            after?: string
        }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Modo cursor: sem page explícito → retorna as mais recentes (ou anteriores a 'before')
        if (page === undefined) {
            const createdAtFilter = {
                ...(before ? { lt: new Date(before) } : {}),
                ...(after ? { gte: new Date(after) } : {}),
            }
            const where = {
                contactId,
                organizationId: orgId,
                ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
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
                    quotedExternalId: true,
                    quotedText: true,
                    createdAt: true,
                    user: { select: { id: true, name: true, image: true } },
                },
            })
            // Inverte para exibição cronológica (mais antigas no topo)
            const messages = rows.reverse().map(m => ({
                ...m,
                quotedMessage: m.quotedText ? { text: m.quotedText, quotedExternalId: m.quotedExternalId } : null,
            }))
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
                    quotedExternalId: true,
                    quotedText: true,
                    createdAt: true,
                    user: { select: { id: true, name: true, image: true } },
                },
            }),
        ])

        const messages2 = messages.map(m => ({
            ...m,
            quotedMessage: (m as any).quotedText ? { text: (m as any).quotedText, quotedExternalId: (m as any).quotedExternalId } : null,
        }))
        return { total, page, limit, messages: messages2 }
    })

    // POST /messages — salva uma mensagem enviada/nota
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Messages'],
            summary: 'Salva uma mensagem ou nota interna',
            body: {
                type: 'object',
                required: ['contactId', 'content', 'type', 'direction'],
                properties: {
                    contactId:  { type: 'string' },
                    channelId:  { type: 'string' },
                    direction:  { type: 'string', enum: ['outbound', 'inbound'] },
                    type:       { type: 'string', enum: ['text', 'note', 'image', 'audio', 'video', 'document', 'sticker'] },
                    content:    { type: 'string', minLength: 1 },
                    status:     { type: 'string' },
                    externalId:       { type: 'string' },
                    quotedExternalId: { type: 'string' },
                    quotedText:       { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const body = request.body as {
            contactId: string
            channelId?: string
            direction: 'outbound' | 'inbound'
            type: 'text' | 'note' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
            content: string
            status?: string
            externalId?: string
            quotedExternalId?: string
            quotedText?: string
        }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // ─── ASSINATURA: Aplicada apenas no frontend antes de enviar ───
        // O backend não modifica o conteúdo para evitar adicionar assinatura em mensagens
        // vindas de webhooks (mensagens enviadas diretamente pelo WhatsApp do usuário)

        const message = await prisma.message.create({
            data: {
                organizationId: orgId,
                contactId:      body.contactId,
                channelId:      body.channelId,
                direction:      body.direction,
                type:           body.type,
                content:        body.content,
                status:          body.status ?? 'sent',
                externalId:      body.externalId,
                quotedExternalId: body.quotedExternalId ?? null,
                quotedText:       body.quotedText ?? null,
                // Registra o agente que enviou (apenas para mensagens outbound do painel)
                userId:          body.direction === 'outbound' ? userId : undefined,
            },
        })

        // Broadcast mensagem em tempo real para todos os agentes da org
        {
            const [contact, sender] = await Promise.all([
                prisma.contact.findUnique({
                    where: { id: body.contactId },
                    select: { assignedToId: true, externalId: true, name: true, avatarUrl: true },
                }),
                body.direction === 'outbound'
                    ? prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, image: true } })
                    : null,
            ])
            publishToOrg(orgId, {
                type: 'new_message',
                contactId:        body.contactId,
                assignedToId:     contact?.assignedToId ?? null,
                channelId:        body.channelId ?? null,
                externalId:       contact?.externalId ?? null,
                contactName:      contact?.name ?? null,
                contactAvatarUrl: contact?.avatarUrl ?? null,
                message: {
                    id:         message.id,
                    direction:  body.direction,
                    type:       body.type,
                    content:    body.content,
                    status:     message.status,
                    channelId:  body.channelId ?? null,
                    createdAt:  message.createdAt.toISOString(),
                    externalId: body.externalId ?? null,
                    user:       sender ?? null,
                    ...(body.quotedText ? { quotedMessage: { text: body.quotedText, quotedExternalId: body.quotedExternalId } } : {}),
                },
            })
        }

        // Push to widget WebSocket room when an outbound message is saved for an api channel
        if (body.direction === 'outbound' && body.channelId) {
            const channel = await prisma.channel.findUnique({
                where: { id: body.channelId },
                select: { type: true },
            })
            if (channel?.type === 'api') {
                emitWidgetMessage(body.contactId, {
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
