import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

export default async function (app: FastifyInstance) {
    // GET /users/me - perfil do usuário logado
    app.get('/me', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Retorna o perfil do usuário autenticado',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        image: { type: 'string', nullable: true },
                        signature: { type: 'string', nullable: true },
                        signaturePosition: { type: 'string' },
                        createdAt: { type: 'string' },
                    },
                },
            },
        },
    }, async (request) => {
        const userId = request.session.user.id
        return prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                email: true,
                image: true,
                signature: true,
                signaturePosition: true,
                createdAt: true,
            },
        })
    })

    // GET /users/me/validate-tenant?domain=teste.matratecnologia.com
    // Valida se o usuário é membro da organização do domínio informado
    app.get('/me/validate-tenant', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Valida acesso do usuário ao tenant (subdomínio)',
            querystring: {
                type: 'object',
                required: ['domain'],
                properties: {
                    domain: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        authorized: { type: 'boolean' },
                        organizationId: { type: 'string', nullable: true },
                        organizationName: { type: 'string', nullable: true },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { domain } = request.query as { domain: string }
        const userId = request.session.user.id

        // Busca organização pelo domínio completo (ex: teste.matratecnologia.com)
        const org = await prisma.organization.findUnique({
            where: { domain },
            select: { id: true, name: true },
        })

        if (!org) {
            return reply.send({ authorized: false, organizationId: null, organizationName: null })
        }

        // Verifica se o usuário é membro dessa organização
        const member = await prisma.member.findUnique({
            where: { organizationId_userId: { organizationId: org.id, userId } },
        })

        if (!member) {
            return reply.send({ authorized: false, organizationId: null, organizationName: null })
        }

        return reply.send({
            authorized: true,
            organizationId: org.id,
            organizationName: org.name,
        })
    })

    // PATCH /users/me - atualizar perfil
    app.patch('/me', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Atualiza o perfil do usuário autenticado',
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 2 },
                    image: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        image: { type: 'string', nullable: true },
                    },
                },
            },
        },
    }, async (request) => {
        const { name, image } = request.body as { name?: string; image?: string }
        const userId = request.session.user.id

        return prisma.user.update({
            where: { id: userId },
            data: { name, image },
            select: { id: true, name: true, email: true, image: true },
        })
    })

    // PATCH /users/me/signature - atualizar assinatura eletrônica
    app.patch('/me/signature', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Atualiza a assinatura eletrônica do usuário',
            description: 'Assinatura suporta variáveis: {{name}}, {{email}}, {{phone}}',
            body: {
                type: 'object',
                properties: {
                    signature: { type: 'string' },
                    signaturePosition: {
                        type: 'string',
                        enum: ['pre', 'post']
                    },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        signature: { type: 'string', nullable: true },
                        signaturePosition: { type: 'string' },
                    },
                },
            },
        },
    }, async (request) => {
        const { signature, signaturePosition } = request.body as {
            signature?: string
            signaturePosition?: string
        }
        const userId = request.session.user.id

        const updated = await prisma.user.update({
            where: { id: userId },
            data: {
                ...(signature !== undefined && { signature: signature || null }),
                ...(signaturePosition !== undefined && { signaturePosition }),
            },
            select: {
                signature: true,
                signaturePosition: true,
            },
        })

        return updated
    })

    // GET /users/me/notifications - buscar configurações de notificação
    app.get('/me/notifications', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Retorna as configurações de notificação do membro na organização atual',
        },
    }, async (request, reply) => {
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

        if (!member) {
            return reply.status(404).send({ error: 'Membro não encontrado nesta organização.' })
        }

        return member
    })

    // PATCH /users/me/notifications - atualizar configurações de notificação
    app.patch('/me/notifications', {
        preHandler: requireAuth,
        schema: {
            tags: ['Users'],
            summary: 'Atualiza as configurações de notificação do membro na organização atual',
            body: {
                type: 'object',
                properties: {
                    notifyNewMessage: { type: 'boolean' },
                    notifyAssigned: { type: 'boolean' },
                    notifyMention: { type: 'boolean' },
                    notifyResolved: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const userId = request.session.user.id
        const body = request.body as {
            notifyNewMessage?: boolean
            notifyAssigned?: boolean
            notifyMention?: boolean
            notifyResolved?: boolean
        }

        // Busca o member atual
        const member = await prisma.member.findFirst({
            where: { organizationId: orgId, userId },
        })

        if (!member) {
            return reply.status(404).send({ error: 'Membro não encontrado nesta organização.' })
        }

        // Atualiza apenas os campos fornecidos
        const updated = await prisma.member.update({
            where: { id: member.id },
            data: {
                notifyNewMessage: body.notifyNewMessage,
                notifyAssigned: body.notifyAssigned,
                notifyMention: body.notifyMention,
                notifyResolved: body.notifyResolved,
            },
            select: {
                notifyNewMessage: true,
                notifyAssigned: true,
                notifyMention: true,
                notifyResolved: true,
            },
        })

        return updated
    })
}
