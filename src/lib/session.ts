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
    // Em multi-tenant com API separada, o frontend faz requests para api.X.com
    // mas precisamos detectar o tenant baseado no Origin/Referer do frontend

    let hostname: string | undefined

    // Prioridade 1: Origin header (domínio do frontend que está fazendo a request)
    const origin = request.headers['origin']

    if (origin) {
        try {
            const url = new URL(origin)
            hostname = url.hostname
        } catch {
            // Ignora erro de parsing
        }
    }

    // Prioridade 2: x-forwarded-host (proxy)
    if (!hostname) {
        hostname = request.headers['x-forwarded-host'] as string | undefined
    }

    // Prioridade 3: Host header (pode ser o domínio da API)
    if (!hostname) {
        hostname = request.headers['host'] as string | undefined
    }

    // Prioridade 4: request.hostname
    if (!hostname) {
        hostname = request.hostname
    }

    // Garante que hostname é string (pode vir como array em alguns casos)
    if (Array.isArray(hostname)) {
        hostname = hostname[0]
    }

    // Ignora em localhost/desenvolvimento
    if (hostname && typeof hostname === 'string' && hostname !== 'localhost' && !hostname.startsWith('localhost:') && !hostname.startsWith('127.0.0.1')) {
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
    } else {

        // MODO DESENVOLVIMENTO: Em localhost, usa organização específica configurada
        if (process.env.NODE_ENV === 'development' || hostname === 'localhost' || hostname?.startsWith('localhost:') || hostname?.startsWith('127.0.0.1')) {
            let devOrgId = process.env.DEV_ORGANIZATION_ID

            // Se não tiver variável de ambiente, busca org chamada "Desenvolvimento" ou "Dev"
            if (!devOrgId) {
                const devOrg = await prisma.organization.findFirst({
                    where: {
                        OR: [
                            { name: { contains: 'Desenvolvimento', mode: 'insensitive' } },
                            { name: { contains: 'Dev', mode: 'insensitive' } },
                            { domain: 'localhost' },
                        ]
                    },
                    select: { id: true },
                })

                if (devOrg) {
                    devOrgId = devOrg.id
                }
            }

            if (devOrgId) {
                // Verifica se o usuário é membro dessa organização
                const member = await prisma.member.findUnique({
                    where: { organizationId_userId: { organizationId: devOrgId, userId: session.user.id } },
                })

                if (member) {
                    request.organizationId = devOrgId
                }
            }
        }
    }
}
