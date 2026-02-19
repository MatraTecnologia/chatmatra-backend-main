import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentBody = {
    orgId: string
    name: string
    description?: string
    type?: string
    model?: string
    apiKey?: string | null
    systemPrompt?: string | null
    temperature?: number
    active?: boolean
    channelIds?: string[]
}

type RuleBody = {
    name: string
    active?: boolean
    priority?: number
    conditionType: string
    conditionValue?: Record<string, unknown> | null
    actionType: string
    actionValue?: Record<string, unknown> | null
}

type FileBody = {
    name: string
    mimeType: string
    category?: string
    content: string   // base64
    sizeBytes: number
}

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB

// ─── Helper: verificar membro ─────────────────────────────────────────────────

async function assertMember(orgId: string, userId: string, reply: FastifyReply) {
    const m = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
    if (!m) {
        reply.status(403).send({ error: 'Sem permissão.' })
        return false
    }
    return true
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export default async function (app: FastifyInstance) {

    // ── GET /copilot/agents?orgId= ────────────────────────────────────────────

    app.get('/agents', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Lista agentes de IA da organização',
            querystring: {
                type: 'object',
                required: ['orgId'],
                properties: { orgId: { type: 'string' } },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        if (!await assertMember(orgId, userId, reply)) return

        const agents = await prisma.aiAgent.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { files: true } } },
            // Omit apiKey from list response for security
        })

        // Strip apiKey from list
        return agents.map(({ apiKey: _k, ...a }) => a)
    })

    // ── POST /copilot/agents ──────────────────────────────────────────────────

    app.post('/agents', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Cria agente de IA',
            body: {
                type: 'object',
                required: ['orgId', 'name'],
                properties: {
                    orgId:        { type: 'string' },
                    name:         { type: 'string', minLength: 1 },
                    description:  { type: 'string' },
                    type:         { type: 'string' },
                    model:        { type: 'string' },
                    apiKey:       { type: 'string', nullable: true },
                    systemPrompt: { type: 'string', nullable: true },
                    temperature:  { type: 'number' },
                    active:       { type: 'boolean' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AgentBody
        const userId = request.session.user.id

        if (!await assertMember(body.orgId, userId, reply)) return

        const agent = await prisma.aiAgent.create({
            data: {
                organizationId: body.orgId,
                name:           body.name,
                description:    body.description,
                type:           body.type        ?? 'support',
                model:          body.model       ?? 'gpt-4o-mini',
                apiKey:         body.apiKey      ?? null,
                systemPrompt:   body.systemPrompt ?? null,
                temperature:    body.temperature  ?? 0.7,
                active:         body.active       ?? true,
            },
        })

        const { apiKey: _k, ...safe } = agent
        return reply.status(201).send(safe)
    })

    // ── GET /copilot/agents/:id ───────────────────────────────────────────────

    app.get('/agents/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Detalhe do agente (inclui apiKey)',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        return agent
    })

    // ── PATCH /copilot/agents/:id ─────────────────────────────────────────────

    app.patch('/agents/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Atualiza agente de IA',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:         { type: 'string' },
                    description:  { type: 'string', nullable: true },
                    type:         { type: 'string' },
                    model:        { type: 'string' },
                    apiKey:       { type: 'string', nullable: true },
                    systemPrompt: { type: 'string', nullable: true },
                    temperature:  { type: 'number' },
                    active:       { type: 'boolean' },
                    channelIds:   { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const body = request.body as Partial<AgentBody>
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        const updated = await prisma.aiAgent.update({
            where: { id },
            data: {
                ...(body.name         !== undefined && { name:         body.name }),
                ...(body.description  !== undefined && { description:  body.description }),
                ...(body.type         !== undefined && { type:         body.type }),
                ...(body.model        !== undefined && { model:        body.model }),
                ...(body.apiKey       !== undefined && { apiKey:       body.apiKey }),
                ...(body.systemPrompt !== undefined && { systemPrompt: body.systemPrompt }),
                ...(body.temperature  !== undefined && { temperature:  body.temperature }),
                ...(body.active       !== undefined && { active:       body.active }),
                ...(body.channelIds   !== undefined && { channelIds:   body.channelIds }),
            },
        })

        return updated
    })

    // ── DELETE /copilot/agents/:id ────────────────────────────────────────────

    app.delete('/agents/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Remove agente de IA',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        await prisma.aiAgent.delete({ where: { id } })
        return reply.status(204).send()
    })

    // ── GET /copilot/agents/:id/files ─────────────────────────────────────────

    app.get('/agents/:id/files', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Lista arquivos da base de conhecimento do agente',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        // Omit content (base64) from list to keep response small
        const files = await prisma.aiAgentFile.findMany({
            where: { agentId: id },
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, mimeType: true, category: true, sizeBytes: true, createdAt: true },
        })

        return files
    })

    // ── POST /copilot/agents/:id/files ────────────────────────────────────────

    app.post('/agents/:id/files', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Faz upload de arquivo para a base de conhecimento',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['name', 'mimeType', 'content', 'sizeBytes'],
                properties: {
                    name:      { type: 'string' },
                    mimeType:  { type: 'string' },
                    category:  { type: 'string' },
                    content:   { type: 'string' },   // base64
                    sizeBytes: { type: 'integer' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const body = request.body as FileBody
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        if (body.sizeBytes > MAX_FILE_BYTES) {
            return reply.status(413).send({ error: 'Arquivo muito grande. Limite: 5 MB.' })
        }

        const file = await prisma.aiAgentFile.create({
            data: {
                agentId:   id,
                name:      body.name,
                mimeType:  body.mimeType,
                category:  body.category ?? 'general',
                sizeBytes: body.sizeBytes,
                content:   body.content,
            },
            select: { id: true, name: true, mimeType: true, category: true, sizeBytes: true, createdAt: true },
        })

        return reply.status(201).send(file)
    })

    // ── DELETE /copilot/agents/:id/files/:fileId ──────────────────────────────

    app.delete('/agents/:id/files/:fileId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Remove arquivo da base de conhecimento',
            params: {
                type: 'object',
                properties: { id: { type: 'string' }, fileId: { type: 'string' } },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, fileId } = request.params as { id: string; fileId: string }
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        const file = await prisma.aiAgentFile.findUnique({ where: { id: fileId } })
        if (!file || file.agentId !== id) {
            return reply.status(404).send({ error: 'Arquivo não encontrado.' })
        }

        await prisma.aiAgentFile.delete({ where: { id: fileId } })
        return reply.status(204).send()
    })

    // ── GET /copilot/agents/:id/rules ─────────────────────────────────────────

    app.get('/agents/:id/rules', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Lista regras de automação do agente',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        return prisma.agentRule.findMany({
            where: { agentId: id },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        })
    })

    // ── POST /copilot/agents/:id/rules ────────────────────────────────────────

    app.post('/agents/:id/rules', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Cria regra de automação',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['name', 'conditionType', 'actionType'],
                properties: {
                    name:           { type: 'string' },
                    active:         { type: 'boolean' },
                    priority:       { type: 'integer' },
                    conditionType:  { type: 'string' },
                    conditionValue: {},
                    actionType:     { type: 'string' },
                    actionValue:    {},
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const body = request.body as RuleBody
        const userId = request.session.user.id

        const agent = await prisma.aiAgent.findUnique({ where: { id } })
        if (!agent) return reply.status(404).send({ error: 'Agente não encontrado.' })

        if (!await assertMember(agent.organizationId, userId, reply)) return

        const rule = await prisma.agentRule.create({
            data: {
                agentId:        id,
                name:           body.name,
                active:         body.active         ?? true,
                priority:       body.priority        ?? 0,
                conditionType:  body.conditionType,
                conditionValue: body.conditionValue  ?? null,
                actionType:     body.actionType,
                actionValue:    body.actionValue     ?? null,
            },
        })

        return reply.status(201).send(rule)
    })

    // ── PATCH /copilot/rules/:ruleId ──────────────────────────────────────────

    app.patch('/rules/:ruleId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Atualiza regra de automação',
            params: { type: 'object', properties: { ruleId: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:           { type: 'string' },
                    active:         { type: 'boolean' },
                    priority:       { type: 'integer' },
                    conditionType:  { type: 'string' },
                    conditionValue: {},
                    actionType:     { type: 'string' },
                    actionValue:    {},
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { ruleId } = request.params as { ruleId: string }
        const body = request.body as Partial<RuleBody>
        const userId = request.session.user.id

        const rule = await prisma.agentRule.findUnique({
            where: { id: ruleId },
            include: { agent: { select: { organizationId: true } } },
        })
        if (!rule) return reply.status(404).send({ error: 'Regra não encontrada.' })

        if (!await assertMember(rule.agent.organizationId, userId, reply)) return

        const updated = await prisma.agentRule.update({
            where: { id: ruleId },
            data: {
                ...(body.name           !== undefined && { name:           body.name }),
                ...(body.active         !== undefined && { active:         body.active }),
                ...(body.priority       !== undefined && { priority:       body.priority }),
                ...(body.conditionType  !== undefined && { conditionType:  body.conditionType }),
                ...(body.conditionValue !== undefined && { conditionValue: body.conditionValue }),
                ...(body.actionType     !== undefined && { actionType:     body.actionType }),
                ...(body.actionValue    !== undefined && { actionValue:    body.actionValue }),
            },
        })

        return updated
    })

    // ── DELETE /copilot/rules/:ruleId ─────────────────────────────────────────

    app.delete('/rules/:ruleId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Copilot'],
            summary: 'Remove regra de automação',
            params: { type: 'object', properties: { ruleId: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { ruleId } = request.params as { ruleId: string }
        const userId = request.session.user.id

        const rule = await prisma.agentRule.findUnique({
            where: { id: ruleId },
            include: { agent: { select: { organizationId: true } } },
        })
        if (!rule) return reply.status(404).send({ error: 'Regra não encontrada.' })

        if (!await assertMember(rule.agent.organizationId, userId, reply)) return

        await prisma.agentRule.delete({ where: { id: ruleId } })
        return reply.status(204).send()
    })
}
