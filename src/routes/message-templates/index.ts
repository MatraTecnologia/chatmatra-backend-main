import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

export default async function (app: FastifyInstance) {

    // GET /message-templates — lista templates da organização
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Message Templates'],
            summary: 'Lista templates de mensagem da organização',
        },
    }, async (request, reply) => {
        const userId = request.session.user.id
        const orgId = request.organizationId

        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const templates = await prisma.messageTemplate.findMany({
            where: { organizationId: orgId },
            orderBy: { shortcut: 'asc' },
        })

        return templates
    })

    // POST /message-templates — cria novo template
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Message Templates'],
            summary: 'Cria um novo template de mensagem',
            body: {
                type: 'object',
                required: ['shortcut', 'name', 'content'],
                properties: {
                    shortcut: { type: 'string', minLength: 1, maxLength: 50 },
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    content: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { shortcut, name, content } = request.body as {
            shortcut: string
            name: string
            content: string
        }
        const userId = request.session.user.id
        const orgId = request.organizationId

        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Normaliza o atalho (remove espaços, lowercase, remove caracteres especiais)
        const normalizedShortcut = shortcut
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')

        // Verifica se já existe template com esse atalho
        const existing = await prisma.messageTemplate.findUnique({
            where: {
                organizationId_shortcut: {
                    organizationId: orgId,
                    shortcut: normalizedShortcut,
                },
            },
        })

        if (existing) {
            return reply.status(409).send({ error: 'Já existe um template com esse atalho.' })
        }

        const template = await prisma.messageTemplate.create({
            data: {
                organizationId: orgId,
                shortcut: normalizedShortcut,
                name,
                content,
            },
        })

        return reply.status(201).send(template)
    })

    // PATCH /message-templates/:id — atualiza template
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Message Templates'],
            summary: 'Atualiza um template de mensagem',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    content: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const body = request.body as {
            name?: string
            content?: string
        }
        const userId = request.session.user.id

        const template = await prisma.messageTemplate.findUnique({ where: { id } })
        if (!template) return reply.status(404).send({ error: 'Template não encontrado.' })

        const isMember = await prisma.member.findFirst({
            where: { organizationId: template.organizationId, userId },
        })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const updated = await prisma.messageTemplate.update({
            where: { id },
            data: {
                ...(body.name !== undefined && { name: body.name }),
                ...(body.content !== undefined && { content: body.content }),
            },
        })

        return updated
    })

    // DELETE /message-templates/:id — remove template
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Message Templates'],
            summary: 'Remove um template de mensagem',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const template = await prisma.messageTemplate.findUnique({ where: { id } })
        if (!template) return reply.status(404).send({ error: 'Template não encontrado.' })

        const isMember = await prisma.member.findFirst({
            where: { organizationId: template.organizationId, userId },
        })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.messageTemplate.delete({ where: { id } })
        return reply.status(204).send()
    })

    // GET /message-templates/search?q=:query — busca templates por atalho ou nome
    app.get('/search', {
        preHandler: requireAuth,
        schema: {
            tags: ['Message Templates'],
            summary: 'Busca templates por atalho ou nome',
            querystring: {
                type: 'object',
                properties: {
                    q: { type: 'string', minLength: 1 },
                },
                required: ['q'],
            },
        },
    }, async (request, reply) => {
        const { q } = request.query as { q: string }
        const userId = request.session.user.id
        const orgId = request.organizationId

        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const templates = await prisma.messageTemplate.findMany({
            where: {
                organizationId: orgId,
                OR: [
                    { shortcut: { contains: q.toLowerCase(), mode: 'insensitive' } },
                    { name: { contains: q, mode: 'insensitive' } },
                ],
            },
            orderBy: { shortcut: 'asc' },
            take: 10,
        })

        return templates
    })
}
