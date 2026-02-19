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
                        createdAt: { type: 'string' },
                    },
                },
            },
        },
    }, async (request) => {
        return request.session.user
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
}
