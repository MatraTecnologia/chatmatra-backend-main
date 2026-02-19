import type { FastifyRequest, FastifyReply } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from './auth.js'

export type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

declare module 'fastify' {
    interface FastifyRequest {
        session: Session
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
}
