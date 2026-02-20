import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

function periodStart(period: string): Date {
    const now = new Date()
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7
    now.setDate(now.getDate() - days)
    now.setHours(0, 0, 0, 0)
    return now
}

export default async function (app: FastifyInstance) {

    // ── GET /reports?period= ──────────────────────────────────────────────
    // Overview geral: totais de mensagens, contatos e conversas por status
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Reports'],
            summary: 'Overview de métricas da organização',
            querystring: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { period = '30d' } = request.query as { period?: string }
        const since = periodStart(period)

        const [
            totalMessages,
            inboundMessages,
            outboundMessages,
            newContacts,
            openConvs,
            pendingConvs,
            resolvedConvs,
            totalContacts,
        ] = await Promise.all([
            prisma.message.count({ where: { organizationId: orgId, createdAt: { gte: since } } }),
            prisma.message.count({ where: { organizationId: orgId, direction: 'inbound', createdAt: { gte: since } } }),
            prisma.message.count({ where: { organizationId: orgId, direction: 'outbound', type: 'text', createdAt: { gte: since } } }),
            prisma.contact.count({ where: { organizationId: orgId, createdAt: { gte: since } } }),
            prisma.contact.count({ where: { organizationId: orgId, convStatus: 'open' } }),
            prisma.contact.count({ where: { organizationId: orgId, convStatus: 'pending' } }),
            prisma.contact.count({ where: { organizationId: orgId, convStatus: 'resolved' } }),
            prisma.contact.count({ where: { organizationId: orgId } }),
        ])

        return {
            period,
            since: since.toISOString(),
            messages: {
                total: totalMessages,
                inbound: inboundMessages,
                outbound: outboundMessages,
            },
            contacts: {
                new: newContacts,
                total: totalContacts,
            },
            conversations: {
                open: openConvs,
                pending: pendingConvs,
                resolved: resolvedConvs,
                total: openConvs + pendingConvs + resolvedConvs,
            },
        }
    })

    // ── GET /reports/agents?period= ────────────────────────────────────────
    // Performance por agente: mensagens enviadas, contatos atribuídos, resolvidos
    app.get('/agents', {
        preHandler: requireAuth,
        schema: {
            tags: ['Reports'],
            summary: 'Performance por agente',
            querystring: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { period = '30d' } = request.query as { period?: string }
        const since = periodStart(period)

        const members = await prisma.member.findMany({
            where: { organizationId: orgId },
            include: { user: true },
        })

        const agentStats = await Promise.all(members.map(async (member) => {
            const userId = member.userId

            // Contar todos os contatos atualmente atribuídos ao agente
            const assignedContacts = await prisma.contact.count({
                where: {
                    organizationId: orgId,
                    assignedToId: userId,
                },
            })

            // Contar contatos resolvidos no período
            // Contatos que foram marcados como resolved E atualizados no período
            const resolvedContacts = await prisma.contact.count({
                where: {
                    organizationId: orgId,
                    assignedToId: userId,
                    convStatus: 'resolved',
                    updatedAt: { gte: since },
                },
            })

            // Mensagens enviadas pelo agente no período
            const messagesSent = await prisma.message.count({
                where: {
                    organizationId: orgId,
                    direction: 'outbound',
                    type: 'text',
                    createdAt: { gte: since },
                    contact: { assignedToId: userId },
                },
            })

            return {
                userId,
                name: member.user.name,
                email: member.user.email,
                image: member.user.image ?? null,
                role: member.role,
                assignedContacts,
                resolvedContacts,
                messagesSent,
            }
        }))

        // Ordenar por mensagens enviadas (maior primeiro)
        agentStats.sort((a, b) => b.messagesSent - a.messagesSent)

        return { period, agents: agentStats }
    })

    // ── GET /reports/timeline?period= ─────────────────────────────────────
    // Volume de mensagens por dia no período
    app.get('/timeline', {
        preHandler: requireAuth,
        schema: {
            tags: ['Reports'],
            summary: 'Volume de mensagens por dia',
            querystring: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { period = '30d' } = request.query as { period?: string }
        const since = periodStart(period)

        const rows = await prisma.$queryRaw<Array<{ day: Date; inbound: bigint; outbound: bigint }>>`
            SELECT
                DATE_TRUNC('day', "createdAt") AS day,
                COUNT(*) FILTER (WHERE direction = 'inbound')                     AS inbound,
                COUNT(*) FILTER (WHERE direction = 'outbound' AND type = 'text')  AS outbound
            FROM messages
            WHERE "organizationId" = ${orgId}
              AND "createdAt" >= ${since}
            GROUP BY 1
            ORDER BY 1 ASC
        `

        return {
            period,
            timeline: rows.map((r) => ({
                day: r.day.toISOString().slice(0, 10),
                inbound: Number(r.inbound),
                outbound: Number(r.outbound),
            })),
        }
    })

    // ── GET /reports/channels?period= ─────────────────────────────────────
    // Mensagens por canal no período
    app.get('/channels', {
        preHandler: requireAuth,
        schema: {
            tags: ['Reports'],
            summary: 'Mensagens por canal',
            querystring: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['7d', '30d', '90d'], default: '30d' },
                },
            },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const { period = '30d' } = request.query as { period?: string }
        const since = periodStart(period)

        const channels = await prisma.channel.findMany({
            where: { organizationId: orgId },
            select: { id: true, name: true, type: true },
        })

        const channelStats = await Promise.all(channels.map(async (ch) => {
            const count = await prisma.message.count({
                where: { organizationId: orgId, channelId: ch.id, createdAt: { gte: since } },
            })
            return { ...ch, messages: count }
        }))

        channelStats.sort((a, b) => b.messages - a.messages)

        return { period, channels: channelStats }
    })
}
