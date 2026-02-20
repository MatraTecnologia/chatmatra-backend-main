import type { FastifyInstance } from 'fastify'
import { auth } from '../../lib/auth.js'

// Repassa todas as requisições /auth/* para o Better Auth
export default async function (app: FastifyInstance) {
    app.all('/*', async (request, reply) => {
        const url = `${request.protocol}://${request.hostname}${request.url}`
        const isMagicLinkCallback = request.url.includes('magic-link') || request.url.includes('callback')
        const acceptsHtml = request.headers.accept?.includes('text/html')

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

            // Se for callback de magic link e aceita HTML, mostra página de erro bonita
            if (isMagicLinkCallback && acceptsHtml) {
                return reply.type('text/html').send(generateErrorPage('internal_error'))
            }

            return reply.status(500).send({ error: 'Erro interno de autenticação.' })
        }

        const responseText = await response.text()

        // Se for callback de magic link com erro e aceita HTML
        if (isMagicLinkCallback && acceptsHtml && (response.status >= 400 || responseText.includes('error'))) {
            let errorType = 'unknown'

            try {
                const data = JSON.parse(responseText)
                if (data.error) errorType = data.error
            } catch {
                // Se não for JSON, tenta extrair do texto
                if (responseText.includes('expired')) errorType = 'expired'
                else if (responseText.includes('invalid')) errorType = 'invalid_token'
                else if (responseText.includes('used')) errorType = 'already_used'
            }

            return reply.type('text/html').send(generateErrorPage(errorType))
        }

        // Se for callback de magic link com sucesso e aceita HTML
        if (isMagicLinkCallback && acceptsHtml && response.status === 200 && request.method === 'GET') {
            return reply.type('text/html').send(generateSuccessPage())
        }

        reply.status(response.status)
        response.headers.forEach((value, key) => reply.header(key, value))

        return reply.send(responseText)
    })
}

function generateSuccessPage(): string {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login realizado! - MatraChat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 500px;
            width: 100%;
            padding: 48px 32px;
            text-align: center;
        }
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border-radius: 50%;
            margin: 0 auto 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 48px;
        }
        h1 {
            color: #1a202c;
            font-size: 28px;
            margin-bottom: 16px;
            font-weight: 700;
        }
        p {
            color: #4a5568;
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 32px;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #e2e8f0;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .footer {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            color: #718096;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✓</div>
        <h1>Login realizado com sucesso!</h1>
        <p>Você está sendo redirecionado...</p>
        <div class="spinner"></div>
        <p style="font-size: 14px; color: #718096;">Se não funcionar, <a href="${frontendUrl}" style="color: #667eea; font-weight: 600;">clique aqui</a>.</p>
        <div class="footer"><strong>MatraChat</strong> - Comunicação inteligente</div>
    </div>
    <script>
        setTimeout(() => { window.location.href = '${frontendUrl}'; }, 2000);
    </script>
</body>
</html>
    `
}

function generateErrorPage(errorType: string): string {
    let title = 'Erro no login'
    let message = 'Ocorreu um erro ao processar seu link.'
    let suggestion = 'Solicite um novo link de acesso.'

    if (errorType.includes('expired') || errorType.includes('token_expired')) {
        title = 'Link expirado'
        message = 'Este link de acesso já expirou.'
        suggestion = 'Por segurança, links expiram em 15 minutos. Solicite um novo link.'
    } else if (errorType.includes('invalid') || errorType.includes('missing')) {
        title = 'Link inválido'
        message = 'Este link não é válido.'
        suggestion = 'Verifique se copiou o link completo ou solicite um novo.'
    } else if (errorType.includes('used')) {
        title = 'Link já utilizado'
        message = 'Este link já foi usado.'
        suggestion = 'Cada link só pode ser usado uma vez. Solicite um novo.'
    } else if (errorType.includes('rate')) {
        title = 'Muitas tentativas'
        message = 'Limite de tentativas atingido.'
        suggestion = 'Aguarde alguns minutos e tente novamente.'
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - MatraChat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 500px;
            width: 100%;
            padding: 48px 32px;
            text-align: center;
        }
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            border-radius: 50%;
            margin: 0 auto 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 48px;
        }
        h1 {
            color: #1a202c;
            font-size: 28px;
            margin-bottom: 16px;
            font-weight: 700;
        }
        .message {
            color: #4a5568;
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 24px;
        }
        .suggestion {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 16px;
            border-radius: 8px;
            color: #92400e;
            font-size: 14px;
            line-height: 1.6;
            margin-bottom: 32px;
            text-align: left;
        }
        .button {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            padding: 14px 32px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
            transition: all 0.2s;
        }
        .button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
        }
        .footer {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid #e2e8f0;
            color: #718096;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">⚠️</div>
        <h1>${title}</h1>
        <p class="message">${message}</p>
        <div class="suggestion">
            <strong>💡 O que fazer:</strong><br>
            ${suggestion}
        </div>
        <a href="${frontendUrl}/login" class="button">Voltar para o Login</a>
        <div class="footer">
            <strong>MatraChat</strong> - Comunicação inteligente
        </div>
    </div>
</body>
</html>
    `
}
