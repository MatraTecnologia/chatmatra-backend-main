import type { FastifyRequest, FastifyReply } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from './auth.js'
import { prisma } from './prisma.js'

export type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

declare module 'fastify' {
    interface FastifyRequest {
        session: Session
        organizationId?: string
    }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
    })

    if (!session) {
        return reply.status(401).send({ error: 'Não autorizado.' })
    }

    request.session = session

    // ─── MULTI-TENANT: Detecta organização pelo domínio da requisição ────────────
    const hostname =
        request.headers['x-forwarded-host'] ||
        request.headers['host'] ||
        request.hostname

    // Ignora em localhost/desenvolvimento
    if (hostname && hostname !== 'localhost' && !hostname.startsWith('localhost:') && !hostname.startsWith('127.0.0.1')) {
        // Remove porta se houver (ex: teste.matratecnologia.com:3000 → teste.matratecnologia.com)
        const domain = hostname.split(':')[0]

        // Busca organização pelo domínio
        const org = await prisma.organization.findUnique({
            where: { domain },
            select: { id: true },
        })

        if (org) {
            // Verifica se o usuário é membro dessa organização
            const member = await prisma.member.findUnique({
                where: { organizationId_userId: { organizationId: org.id, userId: session.user.id } },
            })

            if (!member) {
                return reply.status(403).send({ error: 'Acesso negado a esta organização.' })
            }

            // Injeta organizationId no request para uso nos endpoints
            request.organizationId = org.id
        }
    }
}
