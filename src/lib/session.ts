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
    console.log('[MULTI-TENANT] 🔍 Origin header:', origin)

    if (origin) {
        try {
            const url = new URL(origin)
            hostname = url.hostname
            console.log('[MULTI-TENANT] ✅ Hostname extraído do Origin:', hostname)
        } catch (err) {
            console.log('[MULTI-TENANT] ❌ Erro ao parsear Origin:', err)
        }
    }

    // Prioridade 2: x-forwarded-host (proxy)
    if (!hostname) {
        hostname = request.headers['x-forwarded-host'] as string | undefined
        if (hostname) console.log('[MULTI-TENANT] 📍 Hostname do x-forwarded-host:', hostname)
    }

    // Prioridade 3: Host header (pode ser o domínio da API)
    if (!hostname) {
        hostname = request.headers['host'] as string | undefined
        if (hostname) console.log('[MULTI-TENANT] 📍 Hostname do host header:', hostname)
    }

    // Prioridade 4: request.hostname
    if (!hostname) {
        hostname = request.hostname
        if (hostname) console.log('[MULTI-TENANT] 📍 Hostname do request.hostname:', hostname)
    }

    // Garante que hostname é string (pode vir como array em alguns casos)
    if (Array.isArray(hostname)) {
        console.log('[MULTI-TENANT] ⚠️ Hostname era array, pegando primeiro:', hostname)
        hostname = hostname[0]
    }

    console.log('[MULTI-TENANT] 🎯 Hostname final:', hostname)

    // Ignora em localhost/desenvolvimento
    if (hostname && typeof hostname === 'string' && hostname !== 'localhost' && !hostname.startsWith('localhost:') && !hostname.startsWith('127.0.0.1')) {
        // Remove porta se houver (ex: teste.matratecnologia.com:3000 → teste.matratecnologia.com)
        const domain = hostname.split(':')[0]
        console.log('[MULTI-TENANT] 🔎 Buscando organização com domain:', domain)

        // Busca organização pelo domínio
        const org = await prisma.organization.findUnique({
            where: { domain },
            select: { id: true },
        })

        console.log('[MULTI-TENANT] 📊 Organização encontrada:', org)

        if (org) {
            // Verifica se o usuário é membro dessa organização
            const member = await prisma.member.findUnique({
                where: { organizationId_userId: { organizationId: org.id, userId: session.user.id } },
            })

            console.log('[MULTI-TENANT] 👤 Membro encontrado:', member ? `ID: ${member.id}` : 'null')

            if (!member) {
                console.log('[MULTI-TENANT] 🚫 Usuário não é membro da organização')
                return reply.status(403).send({ error: 'Acesso negado a esta organização.' })
            }

            // Injeta organizationId no request para uso nos endpoints
            request.organizationId = org.id
            console.log('[MULTI-TENANT] ✅ organizationId injetado no request:', org.id)
        } else {
            console.log('[MULTI-TENANT] ⚠️ Nenhuma organização encontrada para o domain:', domain)
        }
    } else {
        console.log('[MULTI-TENANT] ℹ️ Ignorando detecção (localhost ou hostname inválido)')
    }
}
