import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

export default async function (app: FastifyInstance) {

    // GET /teams — lista times da organização com membros
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Lista times da organização',
        },
    }, async (request, reply) => {
        const userId = request.session.user.id
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organização detectada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        return prisma.team.findMany({
            where: { organizationId: orgId },
            orderBy: { name: 'asc' },
            include: {
                members: {
                    include: {
                        member: {
                            include: { user: { select: { id: true, name: true, email: true, image: true } } },
                        },
                    },
                },
            },
        })
    })

    // POST /teams — cria time
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Cria um novo time',
            body: {
                type: 'object',
                required: ['name'],
                properties: {
                    name:        { type: 'string', minLength: 1 },
                    description: { type: 'string' },
                    color:       { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { name, description, color } = request.body as { name: string; description?: string; color?: string }
        const userId = request.session.user.id
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organização detectada.' })

        const member = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
            return reply.status(403).send({ error: 'Apenas admins podem criar times.' })
        }

        const team = await prisma.team.create({
            data: {
                organizationId: orgId,
                name: name.trim(),
                description: description?.trim(),
                color: color ?? '#6366f1',
            },
        })

        return reply.status(201).send(team)
    })

    // PATCH /teams/:id — atualiza nome/descrição/cor
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Atualiza um time',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:        { type: 'string', minLength: 1 },
                    description: { type: 'string' },
                    color:       { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { name, description, color } = request.body as { name?: string; description?: string; color?: string }
        const userId = request.session.user.id

        const team = await prisma.team.findUnique({ where: { id } })
        if (!team) return reply.status(404).send({ error: 'Time não encontrado.' })

        const member = await prisma.member.findFirst({ where: { organizationId: team.organizationId, userId } })
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
            return reply.status(403).send({ error: 'Apenas admins podem editar times.' })
        }

        return prisma.team.update({
            where: { id },
            data: {
                ...(name        !== undefined && { name: name.trim() }),
                ...(description !== undefined && { description: description.trim() }),
                ...(color       !== undefined && { color }),
            },
        })
    })

    // DELETE /teams/:id — remove time
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Remove um time',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const team = await prisma.team.findUnique({ where: { id } })
        if (!team) return reply.status(404).send({ error: 'Time não encontrado.' })

        const member = await prisma.member.findFirst({ where: { organizationId: team.organizationId, userId } })
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
            return reply.status(403).send({ error: 'Apenas admins podem remover times.' })
        }

        await prisma.team.delete({ where: { id } })
        return reply.status(204).send()
    })

    // POST /teams/:id/members — adiciona membro ao time
    app.post('/:id/members', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Adiciona membro ao time',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['memberId'],
                properties: { memberId: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id: teamId } = request.params as { id: string }
        const { memberId } = request.body as { memberId: string }
        const userId = request.session.user.id

        const team = await prisma.team.findUnique({ where: { id: teamId } })
        if (!team) return reply.status(404).send({ error: 'Time não encontrado.' })

        const actor = await prisma.member.findFirst({ where: { organizationId: team.organizationId, userId } })
        if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
            return reply.status(403).send({ error: 'Apenas admins podem gerenciar membros do time.' })
        }

        // Garante que o memberId pertence à mesma organização
        const target = await prisma.member.findFirst({ where: { id: memberId, organizationId: team.organizationId } })
        if (!target) return reply.status(404).send({ error: 'Membro não encontrado nesta organização.' })

        const teamMember = await prisma.teamMember.upsert({
            where: { teamId_memberId: { teamId, memberId } },
            create: { teamId, memberId },
            update: {},
        })

        return reply.status(201).send(teamMember)
    })

    // DELETE /teams/:id/members/:memberId — remove membro do time
    app.delete('/:id/members/:memberId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Remove membro do time',
            params: {
                type: 'object',
                properties: { id: { type: 'string' }, memberId: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id: teamId, memberId } = request.params as { id: string; memberId: string }
        const userId = request.session.user.id

        const team = await prisma.team.findUnique({ where: { id: teamId } })
        if (!team) return reply.status(404).send({ error: 'Time não encontrado.' })

        const actor = await prisma.member.findFirst({ where: { organizationId: team.organizationId, userId } })
        if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
            return reply.status(403).send({ error: 'Apenas admins podem gerenciar membros do time.' })
        }

        await prisma.teamMember.deleteMany({ where: { teamId, memberId } })
        return reply.status(204).send()
    })

    // GET /teams/mine — retorna o time do usuário logado (se houver)
    app.get('/mine', {
        preHandler: requireAuth,
        schema: {
            tags: ['Teams'],
            summary: 'Retorna o(s) time(s) do usuário logado',
        },
    }, async (request, reply) => {
        const userId = request.session.user.id
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organização detectada.' })

        const member = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!member) return reply.status(403).send({ error: 'Sem permissão.' })

        return prisma.team.findMany({
            where: {
                organizationId: orgId,
                members: { some: { memberId: member.id } },
            },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, color: true, description: true },
        })
    })
}
