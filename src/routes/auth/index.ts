import type { FastifyInstance } from 'fastify'
import { auth } from '../../lib/auth.js'

// Repassa todas as requisições /auth/* para o Better Auth
export default async function (app: FastifyInstance) {
    app.all('/*', async (request, reply) => {
        const url = `${request.protocol}://${request.hostname}${request.url}`

        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }

        const body =
            request.method !== 'GET' && request.method !== 'HEAD'
                ? JSON.stringify(request.body)
                : undefined

        const webRequest = new Request(url, { method: request.method, headers, body })

        let response: Response
        try {
            response = await auth.handler(webRequest)
        } catch (err) {
            request.log.error(err, 'Better Auth handler error')
            return reply.status(500).send({ error: 'Erro interno de autenticação.' })
        }

        const responseText = await response.text()

        reply.status(response.status)
        response.headers.forEach((value, key) => reply.header(key, value))

        return reply.send(responseText)
    })
}
