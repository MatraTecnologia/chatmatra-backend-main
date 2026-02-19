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
