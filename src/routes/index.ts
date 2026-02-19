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
        return {
            message: 'Seja bem-vindo ao backend do Chat Matra! Para acessar a documentação, acesse /docs.',
            docs: 'http://localhost:3333/docs',
        }
    })
}
