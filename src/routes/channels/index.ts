import type { FastifyInstance } from 'fastify'
import { type Prisma } from '@prisma/client'
import crypto from 'crypto'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { publishToOrg } from '../../lib/agentSse.js'
import { log } from '../../lib/logger.js'

// Gera instanceName: slug do nome + 8 chars hex aleatórios
// ex: "Suporte WhatsApp" → "suporte-whatsapp-a3f9c12b"
function generateInstanceName(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32)
    const suffix = crypto.randomBytes(4).toString('hex')
    return `${slug}-${suffix}`
}

// ─── Helpers Evolution API ────────────────────────────────────────────────────

type WhatsAppConfig = {
    evolutionUrl: string
    evolutionApiKey: string
    instanceName: string
    phone?: string
}

// ─── Helpers WhatsApp Business API (Meta) ─────────────────────────────────────

type WhatsAppBusinessConfig = {
    phoneNumberId: string       // ID do número de telefone do Meta Business
    accessToken: string         // Token de acesso permanente
    webhookVerifyToken: string  // Token de verificação do webhook
    businessAccountId?: string  // ID da conta comercial (opcional)
    phone?: string              // Número de telefone formatado
}

async function evolutionFetch(
    config: Pick<WhatsAppConfig, 'evolutionUrl' | 'evolutionApiKey'>,
    path: string,
    options: RequestInit = {}
) {
    const url = `${config.evolutionUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'apikey': config.evolutionApiKey,
            ...options.headers,
        },
    })
    const text = await res.text()
    try {
        return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
        return { ok: res.ok, status: res.status, data: text }
    }
}

async function whatsappBusinessFetch(
    config: Pick<WhatsAppBusinessConfig, 'accessToken'>,
    path: string,
    options: RequestInit = {}
) {
    const url = `https://graph.facebook.com/v21.0${path}`
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.accessToken}`,
            ...options.headers,
        },
    })
    const text = await res.text()
    try {
        return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
        return { ok: res.ok, status: res.status, data: text }
    }
}

// Mapeamento de cor WhatsApp (inteiro 0-20) → hex
const WA_COLORS: Record<number, string> = {
    0: '#00A884', 1: '#25D366', 2: '#128C7E', 3: '#075E54',
    4: '#B2DFDB', 5: '#FF6B6B', 6: '#FF8A65', 7: '#FF7043',
    8: '#FFD54F', 9: '#FFB300', 10: '#9B59B6', 11: '#3498DB',
    12: '#2ECC71', 13: '#E67E22', 14: '#E74C3C', 15: '#1ABC9C',
    16: '#F39C12', 17: '#D35400', 18: '#C0392B', 19: '#2980B9',
    20: '#8E44AD',
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

export default async function (app: FastifyInstance) {

    // GET /channels/evolution-defaults — retorna URL padrão da Evolution configurada via env
    // A API key nunca é exposta; apenas informa se está configurada.
    app.get('/evolution-defaults', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Retorna configurações padrão da Evolution API (sem expor a key)',
        },
    }, async () => {
        return {
            evolutionUrl:   process.env.EVOLUTION_URL   ?? '',
            hasDefaultKey:  !!process.env.EVOLUTION_API_KEY,
        }
    })

    // GET /channels — lista canais da organização
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Lista os canais da organização',
        },
    }, async (request, reply) => {
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const channels = await prisma.channel.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                type: true,
                status: true,
                createdAt: true,
                // config retornado SEM evolutionApiKey por segurança
                config: true,
            },
        })

        // Oculta a API key antes de retornar
        return channels.map((ch) => {
            if (ch.config && typeof ch.config === 'object') {
                const { evolutionApiKey: _k, ...safeConfig } = ch.config as Record<string, unknown>
                return { ...ch, config: safeConfig }
            }
            return ch
        })
    })

    // POST /channels — cria canal do tipo 'api', 'whatsapp' ou 'whatsapp-business'
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Cria um novo canal',
            body: {
                type: 'object',
                required: ['name', 'type'],
                properties: {
                    name: { type: 'string', minLength: 1 },
                    type: { type: 'string', enum: ['api', 'whatsapp', 'whatsapp-business'] },
                    // WhatsApp Evolution API
                    evolutionUrl: { type: 'string' },
                    evolutionApiKey: { type: 'string' },
                    // WhatsApp Business API (Meta)
                    phoneNumberId: { type: 'string' },
                    accessToken: { type: 'string' },
                    webhookVerifyToken: { type: 'string' },
                    businessAccountId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as {
            name: string
            type: 'api' | 'whatsapp' | 'whatsapp-business'
            evolutionUrl?: string
            evolutionApiKey?: string
            phoneNumberId?: string
            accessToken?: string
            webhookVerifyToken?: string
            businessAccountId?: string
        }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        let config: Record<string, unknown> = {}

        if (body.type === 'api') {
            config = { apiKey: crypto.randomBytes(24).toString('hex') }
        } else if (body.type === 'whatsapp') {
            const evolutionUrl    = body.evolutionUrl    || process.env.EVOLUTION_URL    || ''
            const evolutionApiKey = body.evolutionApiKey || process.env.EVOLUTION_API_KEY || ''
            if (!evolutionUrl || !evolutionApiKey) {
                return reply.status(400).send({ error: 'evolutionUrl e evolutionApiKey são obrigatórios (ou configure EVOLUTION_URL e EVOLUTION_API_KEY no servidor).' })
            }
            config = {
                evolutionUrl,
                evolutionApiKey,
                instanceName: generateInstanceName(body.name),
            }
        } else if (body.type === 'whatsapp-business') {
            if (!body.phoneNumberId || !body.accessToken || !body.webhookVerifyToken) {
                return reply.status(400).send({ error: 'phoneNumberId, accessToken e webhookVerifyToken são obrigatórios para WhatsApp Business API.' })
            }
            config = {
                phoneNumberId: body.phoneNumberId,
                accessToken: body.accessToken,
                webhookVerifyToken: body.webhookVerifyToken,
                businessAccountId: body.businessAccountId,
            }
        }

        const channel = await prisma.channel.create({
            data: {
                organizationId: orgId,
                name: body.name,
                type: body.type,
                // Canais API não precisam de conexão externa — já nascem ativos.
                // WhatsApp Business API também já nasce ativo (não precisa QR code)
                // Canais WhatsApp (Evolution) começam como 'pending' até o QR code ser escaneado.
                status: body.type === 'whatsapp' ? 'pending' : 'connected',
                config: config as Prisma.InputJsonValue,
            },
        })

        return reply.status(201).send(channel)
    })

    // GET /channels/:id — retorna canal com config completa (apiKey incluída)
    app.get('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Retorna detalhes de um canal (inclui apiKey)',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel) return reply.status(404).send({ error: 'Canal não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Hide internal Evolution API key but expose widget apiKey
        const config = channel.config && typeof channel.config === 'object'
            ? (() => {
                const { evolutionApiKey: _k, ...safe } = channel.config as Record<string, unknown>
                return safe
            })()
            : channel.config

        return { ...channel, config }
    })

    // PATCH /channels/:id — atualiza nome e/ou widgetConfig de um canal api
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Atualiza canal (nome e/ou widgetConfig)',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    widgetConfig: {
                        type: 'object',
                        properties: {
                            primaryColor:   { type: 'string' },
                            welcomeText:    { type: 'string' },
                            agentName:      { type: 'string' },
                            agentAvatarUrl: { type: 'string', nullable: true },
                            position:       { type: 'string', enum: ['left', 'right'] },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const body = request.body as {
            name?: string
            widgetConfig?: {
                primaryColor?: string
                welcomeText?: string
                agentName?: string
                agentAvatarUrl?: string | null
                position?: 'left' | 'right'
            }
        }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel) return reply.status(404).send({ error: 'Canal não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const existingConfig = (channel.config ?? {}) as Record<string, unknown>
        const updatedConfig = body.widgetConfig
            ? {
                ...existingConfig,
                widgetConfig: {
                    ...((existingConfig.widgetConfig as Record<string, unknown>) ?? {}),
                    ...body.widgetConfig,
                },
            }
            : existingConfig

        const updated = await prisma.channel.update({
            where: { id },
            data: {
                ...(body.name !== undefined && { name: body.name }),
                config: updatedConfig as Prisma.InputJsonValue,
            },
        })

        // Return without internal Evolution API key
        const safeConfig = updated.config && typeof updated.config === 'object'
            ? (() => {
                const { evolutionApiKey: _k, ...safe } = updated.config as Record<string, unknown>
                return safe
            })()
            : updated.config

        return { ...updated, config: safeConfig }
    })

    // DELETE /channels/:id — remove canal
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Remove um canal',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel) return reply.status(404).send({ error: 'Canal não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Se for WhatsApp, apaga a instância na Evolution API
        if (channel.type === 'whatsapp' && channel.config) {
            const cfg = channel.config as WhatsAppConfig
            await evolutionFetch(cfg, `/instance/delete/${cfg.instanceName}`, { method: 'DELETE' }).catch(() => null)
        }

        await prisma.channel.delete({ where: { id } })
        return reply.status(204).send()
    })

    // POST /channels/:id/whatsapp/connect
    // Cria a instância na Evolution API (ou reconecta) e retorna o QR code
    app.post('/:id/whatsapp/connect', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Inicia conexão WhatsApp via Evolution API e retorna QR code',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const cfg = channel.config as WhatsAppConfig

        // Tenta criar a instância (se já existir a Evolution API retorna erro, ignoramos)
        const backendUrl = (process.env.BACKEND_URL ?? '').replace(/\/$/, '')
        const webhookEvents = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'MESSAGES_UPDATE', 'SEND_MESSAGE']
        await evolutionFetch(cfg, '/instance/create', {
            method: 'POST',
            body: JSON.stringify({
                instanceName: cfg.instanceName,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS',
                syncFullHistory: true,
                ...(backendUrl && {
                    webhook: {
                        url: `${backendUrl}/channels/whatsapp/webhook`,
                        byEvents: false,
                        base64: true,
                        events: webhookEvents,
                    },
                }),
            }),
        })

        // Garante webhook atualizado mesmo se a instância já existia
        if (backendUrl) {
            await evolutionFetch(cfg, `/webhook/set/${cfg.instanceName}`, {
                method: 'POST',
                body: JSON.stringify({
                    url: `${backendUrl}/channels/whatsapp/webhook`,
                    webhook_by_events: false,
                    webhook_base64: true,
                    events: webhookEvents,
                }),
            }).catch(() => null)
        }

        // Busca o QR code
        const qrResult = await evolutionFetch(cfg, `/instance/connect/${cfg.instanceName}`)

        if (!qrResult.ok) {
            return reply.status(502).send({ error: 'Não foi possível obter o QR code da Evolution API.' })
        }

        // Atualiza status para 'connecting'
        await prisma.channel.update({ where: { id }, data: { status: 'connecting' } })

        return {
            qrCode: qrResult.data?.base64 ?? null,
            pairingCode: qrResult.data?.pairingCode ?? null,
        }
    })

    // POST /channels/:id/whatsapp/sync-profile — sincroniza foto do perfil
    app.post('/:id/whatsapp/sync-profile', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Sincroniza foto do perfil do canal WhatsApp',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppConfig

        if (!cfg.phone) {
            return reply.status(400).send({ error: 'Canal não possui número de telefone configurado.' })
        }

        try {
            const profileResult = await evolutionFetch(cfg, `/chat/fetchProfilePictureUrl/${cfg.instanceName}`, {
                method: 'POST',
                body: JSON.stringify({
                    number: cfg.phone.replace(/\D/g, ''), // remove caracteres não numéricos
                }),
            })

            if (profileResult.ok && profileResult.data?.profilePictureUrl) {
                const updatedConfig = {
                    ...(channel.config as Record<string, unknown>),
                    profilePictureUrl: profileResult.data.profilePictureUrl,
                }

                await prisma.channel.update({
                    where: { id },
                    data: { config: updatedConfig as Prisma.InputJsonValue },
                })

                return {
                    success: true,
                    profilePictureUrl: profileResult.data.profilePictureUrl,
                }
            }

            return reply.status(404).send({ error: 'Foto do perfil não encontrada.' })
        } catch (err) {
            log.error(`Erro ao buscar foto do perfil: ${err}`)
            return reply.status(502).send({ error: 'Erro ao buscar foto do perfil da Evolution API.' })
        }
    })

    // GET /channels/:id/whatsapp/status — consulta status da instância
    app.get('/:id/whatsapp/status', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Consulta o status da conexão WhatsApp',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const cfg = channel.config as WhatsAppConfig

        // Usa fetchInstances para buscar informações completas da instância
        const result = await evolutionFetch(cfg, `/instance/fetchInstances/${cfg.instanceName}`)

        if (!result.ok) {
            return { channelStatus: channel.status, instanceState: 'unknown' }
        }

        // fetchInstances retorna informações mais completas incluindo owner (telefone)
        const instanceData = result.data
        const instanceState: string = instanceData?.instance?.state ?? 'unknown'
        const instanceNumber: string | undefined = instanceData?.instance?.owner ?? undefined

        // Sincroniza status no banco
        const statusMap: Record<string, string> = {
            open: 'connected',
            connecting: 'connecting',
            close: 'disconnected',
        }
        const newStatus = statusMap[instanceState] ?? channel.status

        // Atualiza status e telefone se houver mudanças
        const needsUpdate = newStatus !== channel.status || (instanceNumber && !cfg.phone)
        if (needsUpdate) {
            const updatedConfig = {
                ...cfg,
                ...(instanceNumber ? { phone: instanceNumber } : {}),
            }
            await prisma.channel.update({
                where: { id },
                data: {
                    status: newStatus,
                    config: updatedConfig as Prisma.InputJsonValue
                }
            })
        }

        return { channelStatus: newStatus, instanceState, phone: instanceNumber ?? cfg.phone }
    })

    // POST /channels/:id/whatsapp/send — envia mensagem de texto ou mídia via Evolution API
    app.post('/:id/whatsapp/send', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Envia mensagem de texto ou mídia WhatsApp',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['number'],
                properties: {
                    number: { type: 'string' }, // número ou JID completo
                    text:   { type: 'string', minLength: 1 },
                    mediaMessage: {
                        type: 'object',
                        properties: {
                            mediatype: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
                            fileName: { type: 'string' },
                            media: { type: 'string' }, // base64 sem prefixo data:
                            caption: { type: 'string' },
                        },
                        required: ['mediatype', 'media'],
                    },
                },
                oneOf: [
                    { required: ['text'] },
                    { required: ['mediaMessage'] },
                ],
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { number, text, mediaMessage } = request.body as {
            number: string
            text?: string
            mediaMessage?: { mediatype: string; fileName?: string; media: string; caption?: string }
        }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppConfig

        // Remove sufixo @s.whatsapp.net se vier o JID completo
        const cleanNumber = number.includes('@') ? number.split('@')[0] : number

        let result

        if (mediaMessage) {
            // Envia mídia
            result = await evolutionFetch(cfg, `/message/sendMedia/${cfg.instanceName}`, {
                method: 'POST',
                body: JSON.stringify({
                    number: cleanNumber,
                    mediatype: mediaMessage.mediatype,
                    fileName: mediaMessage.fileName,
                    media: mediaMessage.media,
                    caption: mediaMessage.caption,
                }),
            })
        } else if (text) {
            // Envia texto
            result = await evolutionFetch(cfg, `/message/sendText/${cfg.instanceName}`, {
                method: 'POST',
                body: JSON.stringify({ number: cleanNumber, text }),
            })
        } else {
            return reply.status(400).send({ error: 'É necessário enviar text ou mediaMessage.' })
        }

        if (!result.ok) {
            return reply.status(502).send({ error: 'Falha ao enviar mensagem.', detail: result.data })
        }

        return reply.status(200).send({ ok: true, data: result.data })
    })

    // GET /channels/:id/whatsapp/media/:messageId — busca base64 de mídia sob demanda
    app.get('/:id/whatsapp/media/:messageId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Busca base64 de mensagem de mídia via Evolution API',
            params: { type: 'object', properties: { id: { type: 'string' }, messageId: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id, messageId } = request.params as { id: string; messageId: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') return reply.status(404).send({ error: 'Canal não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Busca a mensagem para reconstruir a WA key
        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: { contact: true },
        })
        if (!message || message.organizationId !== channel.organizationId) {
            return reply.status(404).send({ error: 'Mensagem não encontrada.' })
        }

        // Valida se é mensagem de mídia
        const mediaTypes = ['image', 'audio', 'video', 'document', 'sticker']
        if (!mediaTypes.includes(message.type)) {
            return reply.status(400).send({ error: 'Mensagem não é de mídia.' })
        }

        // Valida se tem externalId (key do WhatsApp)
        if (!message.externalId || !message.contact.externalId) {
            return reply.status(400).send({ error: 'Mensagem sem ID externo do WhatsApp.' })
        }

        const cfg = channel.config as WhatsAppConfig
        const waKey = {
            id:        message.externalId,
            remoteJid: message.contact.externalId,
            fromMe:    message.direction === 'outbound',
        }

        const mediaEndpoint = `/chat/getBase64FromMediaMessage/${cfg.instanceName}`
        const requestBody = {
            message: {
                key: {
                    id: waKey.id,
                    remoteJid: waKey.remoteJid,
                    fromMe: waKey.fromMe,
                }
            },
            convertToMp4: false,
        }

        try {
            const result = await evolutionFetch(cfg, mediaEndpoint, {
                method: 'POST',
                body: JSON.stringify(requestBody),
            })

            if (!result.ok) {
                log.error(`Evolution API erro ao buscar mídia: Status ${result.status}`)
                return reply.status(502).send({
                    error: 'Não foi possível obter a mídia da Evolution API.',
                    details: result.data,
                })
            }

            if (!result.data?.base64) {
                log.error('Evolution API retornou sem base64')
                return reply.status(502).send({ error: 'Mídia não disponível na Evolution API.' })
            }

            const mediaData = {
                base64:    result.data.base64 as string,
                mediaType: result.data.mediaType as string ?? message.type,
                mimeType:  result.data.mimetype  as string ?? 'application/octet-stream',
            }

            return mediaData
        } catch (error) {
            log.error(`Erro ao buscar mídia: ${error instanceof Error ? error.message : error}`)
            return reply.status(502).send({ error: 'Erro ao comunicar com Evolution API.' })
        }
    })

    // POST /channels/whatsapp/webhook — recebe eventos da Evolution API
    // Configure a URL no painel da Evolution API: POST /channels/whatsapp/webhook
    app.post('/whatsapp/webhook', {
        schema: {
            summary: 'Webhook para eventos da Evolution API',
        } as never,
    }, async (request, reply) => {
        type WaContact = {
            id?: string        // JID
            name?: string
            pushName?: string
            profilePictureUrl?: string
        }
        type WaDataObj = {
            // CONNECTION_UPDATE
            state?: string
            number?: string
            // MESSAGES_UPSERT
            key?: { remoteJid?: string; fromMe?: boolean; id?: string }
            message?: { conversation?: string; extendedTextMessage?: { text?: string } }
            messageType?: string
            pushName?: string
            // LABELS_ASSOCIATION
            id?: string
            label?: { id?: string; name?: string; color?: number; colorHex?: string }
            type?: string
            // LABELS_EDIT
            name?: string
            color?: number
            colorHex?: string
            deleted?: boolean
        }
        const body = request.body as {
            event?: string
            instance?: string
            data?: WaDataObj | WaContact[]
        }

        // Normaliza event name: Evolution API pode enviar "messages.upsert" ou "MESSAGES_UPSERT"
        // Converte para o formato padrão UPPERCASE_UNDERSCORE
        const event = (body.event ?? '').toUpperCase().replace(/\./g, '_')

        // Normaliza: contacts events têm data como array, demais como objeto
        const dataArr: WaContact[] | null = Array.isArray(body.data) ? body.data as WaContact[] : null
        const dataObj: WaDataObj | undefined = !Array.isArray(body.data) ? body.data as WaDataObj : undefined

        if (!body.instance) return reply.status(200).send({ ok: true })

        // Encontra o canal pela instanceName
        const channels = await prisma.channel.findMany({
            where: { type: 'whatsapp' },
        })

        const channel = channels.find((ch) => {
            const cfg = ch.config as WhatsAppConfig | null
            return cfg?.instanceName === body.instance
        })

        if (!channel) {
            log.warn(`webhook: instância "${body.instance}" não encontrada no banco`)
            return reply.status(200).send({ ok: true })
        }

        // ── CONNECTION_UPDATE: atualiza status ───────────────────────────────
        const stateToStatus: Record<string, string> = {
            open: 'connected',
            connecting: 'connecting',
            close: 'disconnected',
        }

        const instanceState = dataObj?.state ?? ''
        const newStatus = stateToStatus[instanceState]

        if (newStatus) {
            const currentConfig = channel.config as Record<string, unknown>
            const updatedConfig = {
                ...currentConfig,
                phone: dataObj?.number ?? (channel.config as WhatsAppConfig).phone,
            }

            // Se conectou com sucesso, busca a foto do perfil
            if (newStatus === 'connected' && dataObj?.number) {
                try {
                    const cfg = channel.config as WhatsAppConfig
                    const profileResult = await evolutionFetch(cfg, `/chat/fetchProfilePictureUrl/${cfg.instanceName}`, {
                        method: 'POST',
                        body: JSON.stringify({
                            number: dataObj.number.replace(/\D/g, ''), // remove caracteres não numéricos
                        }),
                    })
                    if (profileResult.ok && profileResult.data?.profilePictureUrl) {
                        updatedConfig.profilePictureUrl = profileResult.data.profilePictureUrl
                    }
                } catch (err) {
                    log.warn(`Erro ao buscar foto do perfil do canal: ${err}`)
                }
            }

            await prisma.channel.update({
                where: { id: channel.id },
                data: { status: newStatus, config: updatedConfig as Prisma.InputJsonValue },
            })
        }

        // ── MESSAGES_UPSERT: salva mensagem recebida ─────────────────────────
        if (event === 'MESSAGES_UPSERT' && dataObj?.key) {
            const { key, message, pushName } = dataObj
            const remoteJid = key.remoteJid ?? ''
            const fromMe    = key.fromMe ?? false

            // Só processa mensagens individuais (não grupos)
            if (remoteJid.includes('@s.whatsapp.net') || remoteJid.includes('@c.us')) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const msg = message as any

                // Detecta tipo de mídia
                type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
                let msgType: MsgType = 'text'
                let content = ''

                if (msg?.conversation)                     { content = msg.conversation;                      msgType = 'text' }
                else if (msg?.extendedTextMessage?.text)   { content = msg.extendedTextMessage.text;           msgType = 'text' }
                else if (msg?.imageMessage != null)        { content = msg.imageMessage?.caption ?? '';        msgType = 'image' }
                else if (msg?.videoMessage != null)        { content = msg.videoMessage?.caption ?? '';        msgType = 'video' }
                else if (msg?.audioMessage != null)        { content = '';                                     msgType = 'audio' }
                else if (msg?.documentMessage != null)     { content = msg.documentMessage?.fileName ?? '';   msgType = 'document' }
                else if (msg?.stickerMessage != null)      { content = '';                                     msgType = 'sticker' }
                else if (msg?.locationMessage != null)     { content = '[Localização]';                        msgType = 'text' }
                else if (msg?.contactMessage != null)      { content = '[Contato]';                            msgType = 'text' }
                else if (msg?.reactionMessage != null)     { content = `[Reação: ${msg.reactionMessage?.text ?? ''}]`; msgType = 'text' }

                const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)

                if (content || isMedia) {
                    const direction = fromMe ? 'outbound' : 'inbound'

                    // Busca ou cria o contato pelo JID
                    let contact = await prisma.contact.findFirst({
                        where: { organizationId: channel.organizationId, externalId: remoteJid },
                    })

                    let isNewContact = false
                    if (!contact) {
                        const rawNumber = remoteJid.split('@')[0]
                        // Para mensagens enviadas (outbound), não usar pushName pois pode vir incorreto
                        // Apenas mensagens recebidas (inbound) devem usar pushName do remetente
                        const contactName = fromMe
                            ? (rawNumber || 'Contato')
                            : (pushName || rawNumber || 'Desconhecido')

                        contact = await prisma.contact.create({
                            data: {
                                organizationId: channel.organizationId,
                                channelId: channel.id,
                                externalId: remoteJid,
                                phone: rawNumber ? `+${rawNumber}` : undefined,
                                name: contactName,
                                convStatus: 'pending',
                            },
                        })
                        isNewContact = true
                    } else {
                        // Atualiza o nome do contato se receber mensagem inbound com pushName diferente
                        if (!fromMe && pushName && pushName !== contact.name) {
                            await prisma.contact.update({
                                where: { id: contact.id },
                                data: { name: pushName },
                            })
                            contact.name = pushName
                        }
                    }

                    const savedMsg = await prisma.message.create({
                        data: {
                            organizationId: channel.organizationId,
                            contactId:      contact.id,
                            channelId:      channel.id,
                            direction,
                            type:      msgType,
                            content,
                            status:    'sent',
                            externalId: key.id,
                        },
                    })

                    // Publica mensagem em tempo real para os agentes
                    // Se contato é novo, inclui dados para o frontend adicionar na lista
                    publishToOrg(channel.organizationId, {
                        type: 'new_message',
                        contactId:        contact.id,
                        channelId:        channel.id,
                        externalId:       contact.externalId,
                        contactName:      contact.name,
                        contactAvatarUrl: contact.avatarUrl,
                        message: {
                            id:        savedMsg.id,
                            direction: direction as 'outbound' | 'inbound',
                            type:      msgType,
                            content,
                            status:    'sent',
                            createdAt: savedMsg.createdAt.toISOString(),
                        },
                        // Inclui dados do contato se foi criado agora (aparece na lista do frontend)
                        ...(isNewContact ? {
                            contact: {
                                id:         contact.id,
                                name:       contact.name,
                                phone:      contact.phone,
                                avatarUrl:  contact.avatarUrl,
                                externalId: contact.externalId,
                                channelId:  contact.channelId,
                                convStatus: 'pending',
                                createdAt:  contact.createdAt.toISOString(),
                            },
                        } : {}),
                    })

                    // Mensagem inbound → atualiza contato (força updatedAt para ordenação por atividade)
                    if (!fromMe && !isNewContact) {
                        const needsStatusUpdate = !contact.convStatus || contact.convStatus === 'resolved'
                        const newStatus = needsStatusUpdate ? 'pending' : contact.convStatus
                        // Sempre faz update para que @updatedAt seja renovado (ordenação por última atividade)
                        await prisma.contact.update({
                            where: { id: contact.id },
                            data: { convStatus: newStatus },
                        })
                        if (needsStatusUpdate) {
                            publishToOrg(channel.organizationId, {
                                type: 'conv_updated',
                                contactId: contact.id,
                                convStatus: 'pending',
                                assignedToId: contact.assignedToId,
                                assignedToName: null,
                            })
                        }
                    }
                }
            }
        }

        // ── CONTACTS_UPSERT / CONTACTS_UPDATE: sincroniza nome e foto do contato ────
        if ((event === 'CONTACTS_UPSERT' || event === 'CONTACTS_UPDATE') && dataArr && dataArr.length > 0) {
            for (const waContact of dataArr) {
                const jid = waContact.id ?? ''
                if (!jid || (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us'))) continue

                const newName = (waContact.name || waContact.pushName || '').trim()
                const profilePictureUrl = waContact.profilePictureUrl

                // Monta os dados para atualização
                const updateData: Record<string, string> = {}
                if (newName) updateData.name = newName
                if (profilePictureUrl) updateData.avatarUrl = profilePictureUrl

                // Atualiza contato se houver dados para atualizar
                if (Object.keys(updateData).length > 0) {
                    await prisma.contact.updateMany({
                        where: {
                            organizationId: channel.organizationId,
                            externalId: jid,
                        },
                        data: updateData,
                    })
                }
            }
        }

        // ── LABELS_EDIT: renomeia ou remove tag quando label muda no WA ──────
        if (event === 'LABELS_EDIT' && dataObj) {
            const waLabelId = (dataObj.id ?? '').toString().trim()
            const newName   = (dataObj.name ?? '').trim()
            const deleted   = dataObj.deleted ?? false
            const color     = dataObj.colorHex ??
                (dataObj.color !== undefined ? WA_COLORS[dataObj.color] : undefined)

            if (waLabelId) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const pc = prisma as any
                // Busca a tag pelo waLabelId (preciso) ou pelo nome (fallback)
                const tag = await pc.tag.findFirst({
                    where: {
                        organizationId: channel.organizationId,
                        OR: [
                            { waLabelId },
                            ...(newName ? [{ name: { equals: newName, mode: 'insensitive' } }] : []),
                        ],
                    },
                })
                if (tag) {
                    if (deleted) {
                        await pc.contactTag.deleteMany({ where: { tagId: tag.id } })
                        await pc.tag.delete({ where: { id: tag.id } })
                    } else {
                        await pc.tag.update({
                            where: { id: tag.id },
                            data: {
                                ...(newName && newName !== tag.name ? { name: newName } : {}),
                                ...(color ? { color } : {}),
                                waLabelId,   // garante que está salvo
                            },
                        })
                    }
                }
            }
        }

        // ── LABELS_ASSOCIATION: sincroniza label do WA com ContactTag ───────
        if (event === 'LABELS_ASSOCIATION' && dataObj) {
            const { id: jid, label, type: assocType } = dataObj
            const labelName  = (label?.name ?? '').trim()
            const waLabelId  = (label?.id ?? '').toString().trim()

            if (jid && labelName && (jid.includes('@s.whatsapp.net') || jid.includes('@c.us'))) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const pc = prisma as any
                const contact = await pc.contact.findFirst({
                    where: { organizationId: channel.organizationId, externalId: jid },
                })

                if (contact) {
                    if (assocType === 'add') {
                        // Busca tag pelo waLabelId primeiro (mais preciso), depois pelo nome
                        let tag = await pc.tag.findFirst({
                            where: {
                                organizationId: channel.organizationId,
                                OR: [
                                    ...(waLabelId ? [{ waLabelId }] : []),
                                    { name: { equals: labelName, mode: 'insensitive' } },
                                ],
                            },
                        })
                        if (!tag) {
                            const color = label?.colorHex ?? (label?.color !== undefined ? WA_COLORS[label.color] : undefined) ?? '#6366f1'
                            tag = await pc.tag.create({
                                data: {
                                    organizationId: channel.organizationId,
                                    name: labelName,
                                    color,
                                    ...(waLabelId ? { waLabelId } : {}),
                                },
                            })
                        } else if (waLabelId && !tag.waLabelId) {
                            // Retroativamente salva o waLabelId se ainda não estava preenchido
                            await pc.tag.update({ where: { id: tag.id }, data: { waLabelId } })
                        }
                        await pc.contactTag.upsert({
                            where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
                            create: { contactId: contact.id, tagId: tag.id },
                            update: {},
                        })
                    } else if (assocType === 'remove') {
                        const tag = await pc.tag.findFirst({
                            where: {
                                organizationId: channel.organizationId,
                                OR: [
                                    ...(waLabelId ? [{ waLabelId }] : []),
                                    { name: { equals: labelName, mode: 'insensitive' } },
                                ],
                            },
                        })
                        if (tag) {
                            await pc.contactTag.deleteMany({
                                where: { contactId: contact.id, tagId: tag.id },
                            })
                        }
                    }
                }
            }
        }

        return reply.status(200).send({ ok: true })
    })

    // POST /channels/:id/whatsapp/import-labels
    // Importa as labels do WhatsApp Business como tags da organização (ignora duplicatas por nome)
    app.post('/:id/whatsapp/import-labels', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Importa labels do WhatsApp Business como tags da organização',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppConfig

        // Busca labels na Evolution API
        const result = await evolutionFetch(cfg, `/label/findLabels/${cfg.instanceName}`)

        if (!result.ok) {
            return reply.status(502).send({ error: 'Não foi possível buscar as labels do WhatsApp.', detail: result.data })
        }

        const labels: { id: string; name: string; color: number }[] = Array.isArray(result.data) ? result.data : []

        if (labels.length === 0) {
            return { created: 0, skipped: 0, message: 'Nenhuma label encontrada no WhatsApp Business.' }
        }

        // Busca tags existentes para evitar duplicatas e retroativamente preencher waLabelId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = prisma as any
        const existing: { id: string; name: string; waLabelId: string | null }[] = await pc.tag.findMany({
            where: { organizationId: channel.organizationId },
            select: { id: true, name: true, waLabelId: true },
        })
        const existingByName = new Map(existing.map((t) => [t.name.toLowerCase(), t]))

        let created = 0
        let skipped = 0

        for (const label of labels) {
            const name      = (label.name ?? '').trim()
            const waLabelId = (label.id ?? '').toString().trim()
            if (!name) { skipped++; continue }

            const existing = existingByName.get(name.toLowerCase())
            if (existing) {
                // Tag já existe — retroativamente salva waLabelId se ainda não tem
                if (waLabelId && !existing.waLabelId) {
                    await pc.tag.update({ where: { id: existing.id }, data: { waLabelId } })
                }
                skipped++
                continue
            }

            const color = WA_COLORS[label.color] ?? '#6366f1'
            await pc.tag.create({
                data: {
                    organizationId: channel.organizationId,
                    name,
                    color,
                    ...(waLabelId ? { waLabelId } : {}),
                },
            })
            existingByName.set(name.toLowerCase(), { id: '', name, waLabelId })
            created++
        }

        return { created, skipped, total: labels.length }
    })

    // POST /channels/:id/whatsapp/sync-label-contacts
    // Lê os chats da Evolution API (que incluem as labels de cada conversa) e associa
    // cada contato existente no banco às tags correspondentes da organização.
    app.post('/:id/whatsapp/sync-label-contacts', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Sincroniza contatos com as etiquetas do WhatsApp Business',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppConfig

        // Busca todos os chats da Evolution API — cada chat inclui o array "labels"
        const result = await evolutionFetch(cfg, `/chat/findChats/${cfg.instanceName}`, {
            method: 'POST',
            body: JSON.stringify({}),
        })

        if (!result.ok) {
            return reply.status(502).send({ error: 'Não foi possível buscar os chats do WhatsApp.', detail: result.data })
        }

        type WaChat = {
            remoteJid?: string
            id?: { remote?: string }
            labels?: Array<{ id?: string; name?: string; color?: number }>
        }

        const chats: WaChat[] = Array.isArray(result.data) ? result.data : []

        // Carrega todas as tags da organização para lookup por nome
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = prisma as any
        const orgTags: Array<{ id: string; name: string }> = await pc.tag.findMany({
            where: { organizationId: channel.organizationId },
            select: { id: true, name: true },
        })
        const tagByName = new Map(orgTags.map((t: { id: string; name: string }) => [t.name.toLowerCase(), t.id]))

        let synced = 0

        for (const chat of chats) {
            const jid = chat.remoteJid ?? chat.id?.remote ?? ''

            // Só processa conversas individuais (não grupos)
            if (!jid || (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us'))) continue

            const labels = chat.labels ?? []
            if (labels.length === 0) continue

            // Encontra o contato no banco pelo JID
            const contact = await pc.contact.findFirst({
                where: { organizationId: channel.organizationId, externalId: jid },
            })
            if (!contact) continue

            for (const label of labels) {
                const labelName = (label.name ?? '').trim()
                if (!labelName) continue

                const tagId = tagByName.get(labelName.toLowerCase())
                if (!tagId) continue

                await pc.contactTag.upsert({
                    where: { contactId_tagId: { contactId: contact.id, tagId } },
                    create: { contactId: contact.id, tagId },
                    update: {},
                })
                synced++
            }
        }

        return { synced }
    })

    // POST /channels/:id/whatsapp/sync-history
    // Importa o histórico de mensagens da Evolution API para o banco de dados.
    // Para cada chat individual, busca as mensagens e salva (upsert por externalId).
    // Aceita parâmetro opcional `limit` (máx de mensagens por contato, default 200).
    app.post('/:id/whatsapp/sync-history', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Importa histórico de mensagens do WhatsApp Business para o banco',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { limit: msgLimit = 200 } = (request.body ?? {}) as { limit?: number }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }
        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })
        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppConfig

        // 1. Busca todos os chats da instância
        const chatsResult = await evolutionFetch(cfg, `/chat/findChats/${cfg.instanceName}`, {
            method: 'POST',
            body: JSON.stringify({}),
        })
        if (!chatsResult.ok) {
            return reply.status(502).send({ error: 'Não foi possível buscar os chats.', detail: chatsResult.data })
        }

        type WaChat = { remoteJid?: string; id?: { remote?: string } }
        const chats: WaChat[] = Array.isArray(chatsResult.data) ? chatsResult.data : []

        // Estrutura de uma mensagem retornada pela Evolution API
        type WaMessage = {
            key?: { remoteJid?: string; fromMe?: boolean; id?: string }
            message?: {
                conversation?: string
                extendedTextMessage?: { text?: string }
                imageMessage?: { caption?: string }
                videoMessage?: { caption?: string }
                documentMessage?: { title?: string; caption?: string }
                audioMessage?: Record<string, unknown>
                stickerMessage?: Record<string, unknown>
            }
            messageType?: string
            pushName?: string
            messageTimestamp?: number
        }

        let importedMessages = 0
        let importedContacts = 0

        for (const chat of chats) {
            const jid = chat.remoteJid ?? chat.id?.remote ?? ''
            // Só processa conversas individuais
            if (!jid || (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us'))) continue

            // 2. Busca mensagens deste chat na Evolution API
            const msgsResult = await evolutionFetch(cfg, `/chat/findMessages/${cfg.instanceName}`, {
                method: 'POST',
                body: JSON.stringify({
                    where: { key: { remoteJid: jid } },
                    limit: msgLimit,
                }),
            })
            if (!msgsResult.ok) continue

            // A Evolution API pode retornar mensagens em vários formatos:
            // [ ...array... ]
            // { messages: [...] }
            // { messages: { records: [...], total: N } }
            // { records: [...] }
            const raw = msgsResult.data as
                | WaMessage[]
                | { messages?: WaMessage[] | { records?: WaMessage[] } }
                | { records?: WaMessage[] }

            let msgs: WaMessage[] = []
            if (Array.isArray(raw)) {
                msgs = raw
            } else {
                const m = (raw as { messages?: unknown }).messages
                if (Array.isArray(m)) {
                    msgs = m as WaMessage[]
                } else if (m && Array.isArray((m as { records?: unknown }).records)) {
                    msgs = (m as { records: WaMessage[] }).records
                } else if (Array.isArray((raw as { records?: unknown }).records)) {
                    msgs = (raw as { records: WaMessage[] }).records
                }
            }

            if (msgs.length === 0) continue

            // 3. Garante que o contato existe no banco
            let contact = await prisma.contact.findFirst({
                where: { organizationId: channel.organizationId, externalId: jid },
            })
            if (!contact) {
                const rawNumber = jid.split('@')[0]
                const firstName = msgs.find((m) => !m.key?.fromMe && m.pushName)?.pushName
                contact = await prisma.contact.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        externalId: jid,
                        phone: rawNumber ? `+${rawNumber}` : undefined,
                        name: firstName || rawNumber || 'Desconhecido',
                    },
                })
                importedContacts++
            }

            // 4. Salva cada mensagem (upsert por externalId para evitar duplicatas)
            for (const msg of msgs) {
                if (!msg.key?.id) continue
                const fromMe = msg.key.fromMe ?? false

                // Detecta tipo de mídia
                type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
                let msgType: MsgType = 'text'
                let content = ''

                if (msg.message?.conversation)                     { content = msg.message.conversation;                      msgType = 'text' }
                else if (msg.message?.extendedTextMessage?.text)   { content = msg.message.extendedTextMessage.text;           msgType = 'text' }
                else if (msg.message?.imageMessage != null)        { content = msg.message.imageMessage?.caption ?? '';        msgType = 'image' }
                else if (msg.message?.videoMessage != null)        { content = msg.message.videoMessage?.caption ?? '';        msgType = 'video' }
                else if (msg.message?.audioMessage != null)        { content = '';                                             msgType = 'audio' }
                else if (msg.message?.documentMessage != null)     { content = msg.message.documentMessage?.caption ?? '';     msgType = 'document' }
                else if (msg.message?.stickerMessage != null)      { content = '';                                             msgType = 'sticker' }

                const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)
                if (!content && !isMedia) continue

                const createdAt = msg.messageTimestamp
                    ? new Date(msg.messageTimestamp * 1000)
                    : new Date()

                // Upsert: se já existe pela externalId, não duplica
                const existing = await prisma.message.findFirst({
                    where: { organizationId: channel.organizationId, externalId: msg.key.id },
                })
                if (!existing) {
                    await prisma.message.create({
                        data: {
                            organizationId: channel.organizationId,
                            contactId:      contact.id,
                            channelId:      channel.id,
                            direction:      fromMe ? 'outbound' : 'inbound',
                            type:           msgType,
                            content,
                            status:         'sent',
                            externalId:     msg.key.id,
                            createdAt,
                        },
                    })
                    importedMessages++
                }
            }
        }

        return { importedMessages, importedContacts, chatsProcessed: chats.filter((c) => {
            const j = c.remoteJid ?? c.id?.remote ?? ''
            return j.includes('@s.whatsapp.net') || j.includes('@c.us')
        }).length }
    })

    // ═══════════════════════════════════════════════════════════════════════════════
    // WHATSAPP BUSINESS API (META) ROUTES
    // ═══════════════════════════════════════════════════════════════════════════════

    // POST /channels/:id/whatsapp-business/send — envia mensagem via WhatsApp Business API
    app.post('/:id/whatsapp-business/send', {
        preHandler: requireAuth,
        schema: {
            tags: ['Channels'],
            summary: 'Envia mensagem via WhatsApp Business API (Meta)',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['to'],
                properties: {
                    to: { type: 'string' }, // número no formato internacional (sem +)
                    text: { type: 'string', minLength: 1 },
                    mediaUrl: { type: 'string' },
                    mediaType: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
                    caption: { type: 'string' },
                },
                oneOf: [
                    { required: ['text'] },
                    { required: ['mediaUrl', 'mediaType'] },
                ],
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { to, text, mediaUrl, mediaType, caption } = request.body as {
            to: string
            text?: string
            mediaUrl?: string
            mediaType?: 'image' | 'video' | 'audio' | 'document'
            caption?: string
        }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id } })
        if (!channel || channel.type !== 'whatsapp-business') {
            return reply.status(404).send({ error: 'Canal WhatsApp Business não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: channel.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (channel.status !== 'connected') {
            return reply.status(409).send({ error: 'Canal não está conectado.' })
        }

        const cfg = channel.config as WhatsAppBusinessConfig

        let result
        const messaging_product = 'whatsapp'
        const recipient_type = 'individual'

        if (text) {
            // Mensagem de texto
            result = await whatsappBusinessFetch(cfg, `/${cfg.phoneNumberId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    messaging_product,
                    recipient_type,
                    to,
                    type: 'text',
                    text: { body: text },
                }),
            })
        } else if (mediaUrl && mediaType) {
            // Mensagem de mídia
            const mediaBody: Record<string, unknown> = { link: mediaUrl }
            if (caption) mediaBody.caption = caption

            result = await whatsappBusinessFetch(cfg, `/${cfg.phoneNumberId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    messaging_product,
                    recipient_type,
                    to,
                    type: mediaType,
                    [mediaType]: mediaBody,
                }),
            })
        } else {
            return reply.status(400).send({ error: 'É necessário enviar text ou (mediaUrl + mediaType).' })
        }

        if (!result.ok) {
            log.error(`WhatsApp Business API erro ao enviar: ${JSON.stringify(result.data)}`)
            return reply.status(502).send({ error: 'Falha ao enviar mensagem.', detail: result.data })
        }

        return reply.status(200).send({ ok: true, data: result.data })
    })

    // GET /channels/whatsapp-business/webhook — verificação do webhook Meta
    app.get('/whatsapp-business/webhook', {
        schema: {
            summary: 'Verificação do webhook WhatsApp Business API',
            querystring: {
                type: 'object',
                properties: {
                    'hub.mode': { type: 'string' },
                    'hub.verify_token': { type: 'string' },
                    'hub.challenge': { type: 'string' },
                },
            },
        } as never,
    }, async (request, reply) => {
        const query = request.query as {
            'hub.mode'?: string
            'hub.verify_token'?: string
            'hub.challenge'?: string
        }

        const mode = query['hub.mode']
        const token = query['hub.verify_token']
        const challenge = query['hub.challenge']

        if (mode === 'subscribe') {
            // Busca o canal pelo verify token
            const channels = await prisma.channel.findMany({
                where: { type: 'whatsapp-business' },
            })

            const channel = channels.find((ch) => {
                const cfg = ch.config as WhatsAppBusinessConfig | null
                return cfg?.webhookVerifyToken === token
            })

            if (channel && challenge) {
                log.info(`Webhook WhatsApp Business verificado: ${channel.name}`)
                return reply.status(200).send(challenge)
            }
        }

        return reply.status(403).send('Forbidden')
    })

    // POST /channels/whatsapp-business/webhook — recebe mensagens do Meta
    app.post('/whatsapp-business/webhook', {
        schema: {
            summary: 'Webhook para receber mensagens WhatsApp Business API',
        } as never,
    }, async (request, reply) => {
        const body = request.body as {
            object?: string
            entry?: Array<{
                id?: string
                changes?: Array<{
                    value?: {
                        messaging_product?: string
                        metadata?: {
                            display_phone_number?: string
                            phone_number_id?: string
                        }
                        contacts?: Array<{
                            profile?: { name?: string }
                            wa_id?: string
                        }>
                        messages?: Array<{
                            from?: string
                            id?: string
                            timestamp?: string
                            type?: string
                            text?: { body?: string }
                            image?: { caption?: string; id?: string; mime_type?: string }
                            video?: { caption?: string; id?: string; mime_type?: string }
                            audio?: { id?: string; mime_type?: string }
                            document?: { caption?: string; filename?: string; id?: string; mime_type?: string }
                        }>
                        statuses?: Array<{
                            id?: string
                            status?: string
                            timestamp?: string
                            recipient_id?: string
                        }>
                    }
                    field?: string
                }>
            }>
        }

        if (body.object !== 'whatsapp_business_account') {
            return reply.status(200).send({ ok: true })
        }

        for (const entry of body.entry ?? []) {
            for (const change of entry.changes ?? []) {
                if (change.field !== 'messages') continue

                const value = change.value
                if (!value?.metadata?.phone_number_id) continue

                const phoneNumberId = value.metadata.phone_number_id

                // Encontra o canal pelo phoneNumberId
                const channels = await prisma.channel.findMany({
                    where: { type: 'whatsapp-business' },
                })

                const channel = channels.find((ch) => {
                    const cfg = ch.config as WhatsAppBusinessConfig | null
                    return cfg?.phoneNumberId === phoneNumberId
                })

                if (!channel) {
                    log.warn(`Webhook: phoneNumberId "${phoneNumberId}" não encontrado`)
                    continue
                }

                // Processa mensagens recebidas
                for (const message of value.messages ?? []) {
                    const from = message.from ?? ''
                    const msgId = message.id ?? ''
                    const timestamp = message.timestamp ?? ''
                    const type = message.type ?? 'text'

                    if (!from || !msgId) continue

                    // Detecta tipo e conteúdo
                    let content = ''
                    let msgType: 'text' | 'image' | 'video' | 'audio' | 'document' = 'text'

                    if (type === 'text' && message.text?.body) {
                        content = message.text.body
                        msgType = 'text'
                    } else if (type === 'image') {
                        content = message.image?.caption ?? ''
                        msgType = 'image'
                    } else if (type === 'video') {
                        content = message.video?.caption ?? ''
                        msgType = 'video'
                    } else if (type === 'audio') {
                        content = ''
                        msgType = 'audio'
                    } else if (type === 'document') {
                        content = message.document?.filename ?? message.document?.caption ?? ''
                        msgType = 'document'
                    }

                    // Busca ou cria contato
                    const contactName = value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? from
                    let contact = await prisma.contact.findFirst({
                        where: { organizationId: channel.organizationId, externalId: from },
                    })

                    let isNewContact = false
                    if (!contact) {
                        contact = await prisma.contact.create({
                            data: {
                                organizationId: channel.organizationId,
                                channelId: channel.id,
                                externalId: from,
                                phone: `+${from}`,
                                name: contactName,
                                convStatus: 'pending',
                            },
                        })
                        isNewContact = true
                    }

                    // Salva mensagem
                    const createdAt = timestamp ? new Date(Number(timestamp) * 1000) : new Date()
                    const savedMsg = await prisma.message.create({
                        data: {
                            organizationId: channel.organizationId,
                            contactId: contact.id,
                            channelId: channel.id,
                            direction: 'inbound',
                            type: msgType,
                            content,
                            status: 'sent',
                            externalId: msgId,
                            createdAt,
                        },
                    })

                    // Publica em tempo real
                    publishToOrg(channel.organizationId, {
                        type: 'new_message',
                        contactId: contact.id,
                        channelId: channel.id,
                        externalId: contact.externalId,
                        contactName: contact.name,
                        contactAvatarUrl: contact.avatarUrl,
                        message: {
                            id: savedMsg.id,
                            direction: 'inbound',
                            type: msgType,
                            content,
                            status: 'sent',
                            createdAt: savedMsg.createdAt.toISOString(),
                        },
                        ...(isNewContact ? {
                            contact: {
                                id: contact.id,
                                name: contact.name,
                                phone: contact.phone,
                                avatarUrl: contact.avatarUrl,
                                externalId: contact.externalId,
                                channelId: contact.channelId,
                                convStatus: 'pending',
                                createdAt: contact.createdAt.toISOString(),
                            },
                        } : {}),
                    })

                    // Atualiza status do contato
                    if (!isNewContact) {
                        const needsStatusUpdate = !contact.convStatus || contact.convStatus === 'resolved'
                        const newStatus = needsStatusUpdate ? 'pending' : contact.convStatus
                        await prisma.contact.update({
                            where: { id: contact.id },
                            data: { convStatus: newStatus },
                        })
                        if (needsStatusUpdate) {
                            publishToOrg(channel.organizationId, {
                                type: 'conv_updated',
                                contactId: contact.id,
                                convStatus: 'pending',
                                assignedToId: contact.assignedToId,
                                assignedToName: null,
                            })
                        }
                    }
                }

                // Processa status de mensagens enviadas
                for (const status of value.statuses ?? []) {
                    const msgId = status.id
                    const statusValue = status.status // sent, delivered, read, failed

                    if (!msgId || !statusValue) continue

                    // Atualiza status da mensagem no banco
                    const statusMap: Record<string, string> = {
                        sent: 'sent',
                        delivered: 'delivered',
                        read: 'read',
                        failed: 'error',
                    }
                    const newStatus = statusMap[statusValue] ?? 'sent'

                    await prisma.message.updateMany({
                        where: {
                            organizationId: channel.organizationId,
                            externalId: msgId,
                        },
                        data: { status: newStatus },
                    })
                }
            }
        }

        return reply.status(200).send({ ok: true })
    })
}
