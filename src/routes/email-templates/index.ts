import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth } from '../../lib/auth.js'

// Tipos de template suportados e variáveis disponíveis para cada um
export const TEMPLATE_TYPES = {
    'verification':        { label: 'Verificação de e-mail',     vars: ['{{name}}', '{{url}}'] },
    'magic-link':          { label: 'Link mágico',               vars: ['{{url}}'] },
    'reset-password':      { label: 'Redefinição de senha',      vars: ['{{name}}', '{{url}}'] },
    'otp-sign-in':         { label: 'Código OTP (login)',         vars: ['{{otp}}'] },
    'otp-verification':    { label: 'Código OTP (verificação)',   vars: ['{{otp}}'] },
    'otp-forget-password': { label: 'Código OTP (senha)',         vars: ['{{otp}}'] },
} as const

export type TemplateType = keyof typeof TEMPLATE_TYPES

export default async function (app: FastifyInstance) {

    // GET /email-templates?orgId=xxx — lista todos os templates da org
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Email Templates'],
            summary: 'Lista templates de e-mail da organização',
            querystring: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const templates = await prisma.emailTemplate.findMany({ where: { organizationId: orgId } })
        return templates
    })

    // GET /email-templates/:type?orgId=xxx — retorna template específico (ou null)
    app.get('/:type', {
        preHandler: requireAuth,
        schema: {
            tags: ['Email Templates'],
            summary: 'Retorna um template de e-mail específico',
            params:      { type: 'object', properties: { type: { type: 'string' } } },
            querystring: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { type } = request.params as { type: string }
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const template = await prisma.emailTemplate.findUnique({
            where: { organizationId_type: { organizationId: orgId, type } },
        })

        return template ?? null
    })

    // PUT /email-templates/:type — cria ou atualiza um template
    app.put('/:type', {
        preHandler: requireAuth,
        schema: {
            tags: ['Email Templates'],
            summary: 'Cria ou atualiza um template de e-mail',
            params: { type: 'object', properties: { type: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['orgId', 'subject', 'html'],
                properties: {
                    orgId:   { type: 'string' },
                    subject: { type: 'string', minLength: 1 },
                    html:    { type: 'string', minLength: 1 },
                    design:  { type: 'object', nullable: true },
                },
            },
        },
    }, async (request, reply) => {
        const { type } = request.params as { type: string }
        const body = request.body as { orgId: string; subject: string; html: string; design?: object }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: body.orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const template = await prisma.emailTemplate.upsert({
            where: { organizationId_type: { organizationId: body.orgId, type } },
            update: { subject: body.subject, html: body.html, design: body.design ?? null },
            create: {
                organizationId: body.orgId,
                type,
                subject: body.subject,
                html: body.html,
                design: body.design ?? null,
            },
        })

        return template
    })

    // DELETE /email-templates/:type — remove template (volta ao padrão do sistema)
    app.delete('/:type', {
        preHandler: requireAuth,
        schema: {
            tags: ['Email Templates'],
            summary: 'Remove template personalizado (restaura padrão)',
            params: { type: 'object', properties: { type: { type: 'string' } } },
            querystring: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { type } = request.params as { type: string }
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.emailTemplate.deleteMany({
            where: { organizationId: orgId, type },
        })

        return reply.status(204).send()
    })

    // GET /email-templates/meta/types — retorna lista de tipos e variáveis disponíveis
    app.get('/meta/types', {
        preHandler: requireAuth,
        schema: {
            tags: ['Email Templates'],
            summary: 'Lista tipos de template e variáveis disponíveis',
        },
    }, async () => {
        return TEMPLATE_TYPES
    })
}
