import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import crypto from 'crypto'

// Tipos para a API do Facebook/Meta
type FacebookOAuthTokenResponse = {
    access_token: string
    token_type: string
    expires_in?: number
}

type FacebookPhoneNumber = {
    id: string
    display_phone_number: string
    verified_name: string
    quality_rating?: string
}

type FacebookBusinessAccount = {
    id: string
    name: string
    phone_numbers?: {
        data: FacebookPhoneNumber[]
    }
}

// Store temporário para OAuth state (em produção, usar Redis ou banco)
const oauthStateStore = new Map<string, { userId: string, organizationId: string, timestamp: number }>()

// Limpar states expirados a cada 10 minutos
setInterval(() => {
    const now = Date.now()
    for (const [state, data] of oauthStateStore.entries()) {
        if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutos
            oauthStateStore.delete(state)
        }
    }
}, 10 * 60 * 1000)

export default async function (app: FastifyInstance) {
    // GET /facebook-oauth/connect — inicia o fluxo OAuth
    app.get('/connect', {
        preHandler: requireAuth,
    }, async (request, reply) => {
        const userId = request.session.user.id

        // Tenta pegar orgId da query string primeiro, depois do request
        const { orgId: queryOrgId } = request.query as { orgId?: string }
        const orgId = queryOrgId || request.organizationId

        // DEBUG: Logs para investigar o problema
        console.log('=== DEBUG FACEBOOK OAUTH ===')
        console.log('Headers:', {
            origin: request.headers.origin,
            host: request.headers.host,
            'x-forwarded-host': request.headers['x-forwarded-host'],
            referer: request.headers.referer,
        })
        console.log('User ID:', userId)
        console.log('Organization ID from query:', queryOrgId)
        console.log('Organization ID from request:', request.organizationId)
        console.log('Final Organization ID:', orgId)
        console.log('===========================')

        if (!orgId) {
            return reply.status(400).send({ error: 'Organização não encontrada.' })
        }

        // Verifica se o usuário é membro da organização
        const member = await prisma.member.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: userId
                }
            },
        })

        if (!member) {
            return reply.status(403).send({ error: 'Acesso negado a esta organização.' })
        }

        // Busca credenciais do Facebook App da organização
        const organization = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { fbAppId: true, fbAppSecret: true }
        })

        if (!organization?.fbAppId || !organization?.fbAppSecret) {
            return reply.status(400).send({
                error: 'Facebook App não configurado para esta organização. Configure em Configurações → Integrações.'
            })
        }

        const appId = organization.fbAppId
        const redirectUri = `${process.env.BACKEND_URL || 'http://localhost:3333'}/facebook-oauth/callback`

        // Gera um state único para prevenir CSRF
        const state = crypto.randomBytes(32).toString('hex')
        oauthStateStore.set(state, {
            userId,
            organizationId: orgId,
            timestamp: Date.now(),
        })

        // Scopes necessários para WhatsApp Business API
        const scopes = [
            'whatsapp_business_management',
            'whatsapp_business_messaging',
            'business_management',
        ].join(',')

        // URL de autorização do Facebook
        const authUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth')
        authUrl.searchParams.set('client_id', appId)
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('state', state)
        authUrl.searchParams.set('scope', scopes)
        authUrl.searchParams.set('response_type', 'code')

        return reply.redirect(authUrl.toString())
    })

    // GET /facebook-oauth/callback — recebe o código de autorização
    app.get('/callback', async (request, reply) => {
        const { code, state, error, error_description } = request.query as {
            code?: string
            state?: string
            error?: string
            error_description?: string
        }

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

        // Usuário negou permissões
        if (error) {
            app.log.warn(`Facebook OAuth error: ${error} - ${error_description}`)
            return reply.redirect(`${frontendUrl}/channels?oauth_error=${error}`)
        }

        if (!code || !state) {
            return reply.redirect(`${frontendUrl}/channels?oauth_error=missing_params`)
        }

        // Valida o state (CSRF protection)
        const stateData = oauthStateStore.get(state)
        if (!stateData) {
            return reply.redirect(`${frontendUrl}/channels?oauth_error=invalid_state`)
        }

        // Remove o state usado
        oauthStateStore.delete(state)

        // Busca credenciais do Facebook App da organização
        const organization = await prisma.organization.findUnique({
            where: { id: stateData.organizationId },
            select: { fbAppId: true, fbAppSecret: true }
        })

        if (!organization?.fbAppId || !organization?.fbAppSecret) {
            return reply.redirect(`${frontendUrl}/channels?oauth_error=config_missing`)
        }

        const appId = organization.fbAppId
        const appSecret = organization.fbAppSecret
        const redirectUri = `${process.env.BACKEND_URL || 'http://localhost:3333'}/facebook-oauth/callback`

        try {
            // Troca o código por um access token
            const tokenUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token')
            tokenUrl.searchParams.set('client_id', appId)
            tokenUrl.searchParams.set('client_secret', appSecret)
            tokenUrl.searchParams.set('redirect_uri', redirectUri)
            tokenUrl.searchParams.set('code', code)

            const tokenResponse = await fetch(tokenUrl.toString())
            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text()
                app.log.error(`Facebook token exchange failed: ${errorText}`)
                return reply.redirect(`${frontendUrl}/channels?oauth_error=token_exchange_failed`)
            }

            const tokenData = await tokenResponse.json() as FacebookOAuthTokenResponse
            const accessToken = tokenData.access_token

            // Busca as contas de negócio (Business Accounts) do usuário
            const businessAccountsUrl = new URL('https://graph.facebook.com/v21.0/me/businesses')
            businessAccountsUrl.searchParams.set('fields', 'id,name')
            businessAccountsUrl.searchParams.set('access_token', accessToken)

            const businessAccountsResponse = await fetch(businessAccountsUrl.toString())
            if (!businessAccountsResponse.ok) {
                app.log.error('Failed to fetch business accounts')
                return reply.redirect(`${frontendUrl}/channels?oauth_error=no_business_accounts`)
            }

            const businessAccountsData = await businessAccountsResponse.json() as { data: FacebookBusinessAccount[] }

            if (!businessAccountsData.data || businessAccountsData.data.length === 0) {
                return reply.redirect(`${frontendUrl}/channels?oauth_error=no_business_accounts`)
            }

            // Busca números de WhatsApp disponíveis para cada conta de negócio
            const allPhoneNumbers: Array<{
                phoneNumber: FacebookPhoneNumber
                businessAccountId: string
                businessAccountName: string
            }> = []

            for (const businessAccount of businessAccountsData.data) {
                const whatsappUrl = new URL(`https://graph.facebook.com/v21.0/${businessAccount.id}/phone_numbers`)
                whatsappUrl.searchParams.set('access_token', accessToken)

                const whatsappResponse = await fetch(whatsappUrl.toString())
                if (whatsappResponse.ok) {
                    const whatsappData = await whatsappResponse.json() as { data: FacebookPhoneNumber[] }

                    for (const phoneNumber of whatsappData.data || []) {
                        allPhoneNumbers.push({
                            phoneNumber,
                            businessAccountId: businessAccount.id,
                            businessAccountName: businessAccount.name,
                        })
                    }
                }
            }

            if (allPhoneNumbers.length === 0) {
                return reply.redirect(`${frontendUrl}/channels?oauth_error=no_phone_numbers`)
            }

            // Salva os dados na sessão (temporariamente)
            const sessionKey = crypto.randomBytes(32).toString('hex')
            oauthStateStore.set(sessionKey, {
                userId: stateData.userId,
                organizationId: stateData.organizationId,
                timestamp: Date.now(),
            })

            // Salva os dados OAuth em um store temporário (em produção, usar Redis)
            const oauthData = {
                accessToken,
                phoneNumbers: allPhoneNumbers,
                userId: stateData.userId,
                organizationId: stateData.organizationId,
            }

            oauthStateStore.set(`oauth_${sessionKey}`, {
                ...oauthData,
                timestamp: Date.now(),
            } as any)

            // Redireciona para o frontend com o session key
            return reply.redirect(`${frontendUrl}/channels?oauth_session=${sessionKey}`)

        } catch (err) {
            app.log.error(err, 'Facebook OAuth callback error')
            return reply.redirect(`${frontendUrl}/channels?oauth_error=unknown`)
        }
    })

    // GET /facebook-oauth/phone-numbers/:sessionKey — retorna números disponíveis
    app.get('/phone-numbers/:sessionKey', {
        preHandler: requireAuth,
    }, async (request, reply) => {
        const { sessionKey } = request.params as { sessionKey: string }

        const oauthData = oauthStateStore.get(`oauth_${sessionKey}`) as any

        if (!oauthData || Date.now() - oauthData.timestamp > 10 * 60 * 1000) {
            return reply.status(404).send({ error: 'Sessão OAuth expirada ou inválida.' })
        }

        // Verifica se o usuário tem permissão
        if (oauthData.userId !== request.session.user.id) {
            return reply.status(403).send({ error: 'Sem permissão.' })
        }

        return reply.send({
            phoneNumbers: oauthData.phoneNumbers.map((item: any) => ({
                id: item.phoneNumber.id,
                displayPhoneNumber: item.phoneNumber.display_phone_number,
                verifiedName: item.phoneNumber.verified_name,
                qualityRating: item.phoneNumber.quality_rating,
                businessAccountId: item.businessAccountId,
                businessAccountName: item.businessAccountName,
            })),
        })
    })

    // POST /facebook-oauth/create-channel — cria canal com número selecionado
    app.post('/create-channel', {
        preHandler: requireAuth,
        schema: {
            body: {
                type: 'object',
                required: ['sessionKey', 'phoneNumberId', 'name'],
                properties: {
                    sessionKey: { type: 'string' },
                    phoneNumberId: { type: 'string' },
                    name: { type: 'string', minLength: 1 },
                    businessAccountId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { sessionKey, phoneNumberId, name, businessAccountId } = request.body as {
            sessionKey: string
            phoneNumberId: string
            name: string
            businessAccountId?: string
        }

        const oauthData = oauthStateStore.get(`oauth_${sessionKey}`) as any

        if (!oauthData || Date.now() - oauthData.timestamp > 10 * 60 * 1000) {
            return reply.status(404).send({ error: 'Sessão OAuth expirada ou inválida.' })
        }

        // Verifica permissão
        if (oauthData.userId !== request.session.user.id) {
            return reply.status(403).send({ error: 'Sem permissão.' })
        }

        // Busca o número selecionado
        const selectedPhone = oauthData.phoneNumbers.find((item: any) =>
            item.phoneNumber.id === phoneNumberId
        )

        if (!selectedPhone) {
            return reply.status(404).send({ error: 'Número de telefone não encontrado.' })
        }

        // Gera um token de verificação para o webhook
        const webhookVerifyToken = crypto.randomBytes(32).toString('hex')

        // Cria o canal no banco de dados
        const channel = await prisma.channel.create({
            data: {
                organizationId: oauthData.organizationId,
                name,
                type: 'whatsapp-business',
                status: 'connected',
                config: {
                    phoneNumberId,
                    accessToken: oauthData.accessToken,
                    webhookVerifyToken,
                    businessAccountId: businessAccountId || selectedPhone.businessAccountId,
                    phone: selectedPhone.phoneNumber.display_phone_number,
                },
            },
        })

        // Remove a sessão OAuth usada
        oauthStateStore.delete(`oauth_${sessionKey}`)
        oauthStateStore.delete(sessionKey)

        return reply.status(201).send(channel)
    })
}
