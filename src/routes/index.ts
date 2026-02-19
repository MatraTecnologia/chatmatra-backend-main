import type { FastifyInstance } from 'fastify'

export default async function (app: FastifyInstance) {
    app.get('/', {
        schema: {
            tags: ['Geral'],
            summary: 'Bem-vindo',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        docs: { type: 'string' },
                    },
                },
            },
        },
    }, async () => {
        const base = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3333}`
        return {
            message: '🚀 MatraChat API — online e pronta para uso.',
            docs: `${base}/docs`,
            version: '1.0.0',
        }
    })
}
