import { type Prisma } from '@prisma/client'
import crypto from 'crypto'
import type { FastifyInstance } from 'fastify'
import { log } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import {
  messageQueue,
  syncQueue,
  type WaBusinessMessageJobData,
} from '../../lib/queue.js'
import { requireAuth } from '../../lib/session.js'
import { type UazapiConfig, uazapiFetch } from '../../lib/uazapi.js'
import { processUazapiMessage } from '../../lib/workers/messageWorker.js'

// Gera instanceName: slug do nome + 8 chars hex aleatórios
// ex: "Suporte WhatsApp" → "suporte-whatsapp-a3f9c12b"
function generateInstanceName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  const suffix = crypto.randomBytes(4).toString('hex')
  return `${slug}-${suffix}`
}

// ─── Helpers WhatsApp Business API (Meta) ─────────────────────────────────────

type WhatsAppBusinessConfig = {
  phoneNumberId: string // ID do número de telefone do Meta Business
  accessToken: string // Token de acesso permanente
  webhookVerifyToken: string // Token de verificação do webhook
  businessAccountId?: string // ID da conta comercial (opcional)
  phone?: string // Número de telefone formatado
}

async function whatsappBusinessFetch(
  config: Pick<WhatsAppBusinessConfig, 'accessToken'>,
  path: string,
  options: RequestInit = {},
) {
  const url = `https://graph.facebook.com/v21.0${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.accessToken}`,
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
  0: '#00A884',
  1: '#25D366',
  2: '#128C7E',
  3: '#075E54',
  4: '#B2DFDB',
  5: '#FF6B6B',
  6: '#FF8A65',
  7: '#FF7043',
  8: '#FFD54F',
  9: '#FFB300',
  10: '#9B59B6',
  11: '#3498DB',
  12: '#2ECC71',
  13: '#E67E22',
  14: '#E74C3C',
  15: '#1ABC9C',
  16: '#F39C12',
  17: '#D35400',
  18: '#C0392B',
  19: '#2980B9',
  20: '#8E44AD',
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

export default async function (app: FastifyInstance) {
  // GET /channels/uazapi-defaults — retorna URL padrão do UAZAPI configurado via env
  // O admin token nunca é exposto; apenas informa se está configurado.
  app.get(
    '/uazapi-defaults',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary:
          'Retorna configurações padrão do UAZAPI (sem expor o admin token)',
      },
    },
    async () => {
      return {
        uazapiUrl: process.env.UAZAPI_URL ?? '',
        hasDefaultAdminToken: !!process.env.UAZAPI_ADMIN_TOKEN,
      }
    },
  )

  // GET /channels — lista canais da organização
  app.get(
    '/',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Lista os canais da organização',
      },
    },
    async (request, reply) => {
      const userId = request.session.user.id

      // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
      const orgId = request.organizationId
      if (!orgId) {
        return reply
          .status(400)
          .send({ error: 'Nenhuma organização detectada para este domínio.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: orgId, userId },
      })
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
          // config retornado SEM tokens sensíveis por segurança
          config: true,
        },
      })

      // Oculta tokens sensíveis antes de retornar
      return channels.map(ch => {
        if (ch.config && typeof ch.config === 'object') {
          const {
            uazapiAdminToken: _a,
            uazapiInstanceToken: _t,
            ...safeConfig
          } = ch.config as Record<string, unknown>
          return { ...ch, config: safeConfig }
        }
        return ch
      })
    },
  )

  // POST /channels — cria canal do tipo 'api', 'whatsapp' ou 'whatsapp-business'
  app.post(
    '/',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Cria um novo canal',
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', minLength: 1 },
            type: {
              type: 'string',
              enum: ['api', 'whatsapp', 'whatsapp-business'],
            },
            // WhatsApp UAZAPI
            uazapiUrl: { type: 'string' },
            uazapiAdminToken: { type: 'string' },
            // WhatsApp Business API (Meta)
            phoneNumberId: { type: 'string' },
            accessToken: { type: 'string' },
            webhookVerifyToken: { type: 'string' },
            businessAccountId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string
        type: 'api' | 'whatsapp' | 'whatsapp-business'
        uazapiUrl?: string
        uazapiAdminToken?: string
        phoneNumberId?: string
        accessToken?: string
        webhookVerifyToken?: string
        businessAccountId?: string
      }
      const userId = request.session.user.id

      // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
      const orgId = request.organizationId
      if (!orgId) {
        return reply
          .status(400)
          .send({ error: 'Nenhuma organização detectada para este domínio.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: orgId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      let config: Record<string, unknown> = {}

      if (body.type === 'api') {
        config = { apiKey: crypto.randomBytes(24).toString('hex') }
      } else if (body.type === 'whatsapp') {
        const uazapiUrl = body.uazapiUrl || process.env.UAZAPI_URL || ''
        const uazapiAdminToken =
          body.uazapiAdminToken || process.env.UAZAPI_ADMIN_TOKEN || ''
        if (!uazapiUrl || !uazapiAdminToken) {
          return reply.status(400).send({
            error:
              'uazapiUrl e uazapiAdminToken são obrigatórios (ou configure UAZAPI_URL e UAZAPI_ADMIN_TOKEN no servidor).',
          })
        }
        config = {
          uazapiUrl,
          uazapiAdminToken,
          instanceName: generateInstanceName(body.name),
        }
      } else if (body.type === 'whatsapp-business') {
        if (
          !body.phoneNumberId ||
          !body.accessToken ||
          !body.webhookVerifyToken
        ) {
          return reply.status(400).send({
            error:
              'phoneNumberId, accessToken e webhookVerifyToken são obrigatórios para WhatsApp Business API.',
          })
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
          // Canais WhatsApp (UAZAPI) começam como 'pending' até o QR code ser escaneado.
          status: body.type === 'whatsapp' ? 'pending' : 'connected',
          config: config as Prisma.InputJsonValue,
        },
      })

      return reply.status(201).send(channel)
    },
  )

  // GET /channels/:id — retorna canal com config completa (apiKey incluída)
  app.get(
    '/:id',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Retorna detalhes de um canal (inclui apiKey)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel)
        return reply.status(404).send({ error: 'Canal não encontrado.' })

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      // Hide internal tokens but expose widget apiKey
      const config =
        channel.config && typeof channel.config === 'object'
          ? (() => {
              const {
                uazapiAdminToken: _a,
                uazapiInstanceToken: _t,
                ...safe
              } = channel.config as Record<string, unknown>
              return safe
            })()
          : channel.config

      return { ...channel, config }
    },
  )

  // PATCH /channels/:id — atualiza nome e/ou widgetConfig de um canal api
  app.patch(
    '/:id',
    {
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
                primaryColor: { type: 'string' },
                welcomeText: { type: 'string' },
                agentName: { type: 'string' },
                agentAvatarUrl: { type: 'string', nullable: true },
                position: { type: 'string', enum: ['left', 'right'] },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
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
      if (!channel)
        return reply.status(404).send({ error: 'Canal não encontrado.' })

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      const existingConfig = (channel.config ?? {}) as Record<string, unknown>
      const updatedConfig = body.widgetConfig
        ? {
            ...existingConfig,
            widgetConfig: {
              ...((existingConfig.widgetConfig as Record<string, unknown>) ??
                {}),
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

      // Return without internal UAZAPI tokens
      const safeConfig =
        updated.config && typeof updated.config === 'object'
          ? (() => {
              const {
                uazapiAdminToken: _a,
                uazapiInstanceToken: _t,
                ...safe
              } = updated.config as Record<string, unknown>
              return safe
            })()
          : updated.config

      return { ...updated, config: safeConfig }
    },
  )

  // DELETE /channels/:id — remove canal
  app.delete(
    '/:id',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Remove um canal',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel)
        return reply.status(404).send({ error: 'Canal não encontrado.' })

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      // Se for WhatsApp, deleta a instância no UAZAPI
      if (channel.type === 'whatsapp' && channel.config) {
        const cfg = channel.config as UazapiConfig
        if (cfg.uazapiInstanceToken) {
          await uazapiFetch(
            cfg.uazapiUrl,
            '/instance',
            { instanceToken: cfg.uazapiInstanceToken },
            { method: 'DELETE' },
          ).catch(() => null)
        }
      }

      await prisma.channel.delete({ where: { id } })
      return reply.status(204).send()
    },
  )

  // POST /channels/:id/whatsapp/connect
  // Cria a instância no UAZAPI (ou reconecta) e retorna o QR code
  app.post(
    '/:id/whatsapp/connect',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Inicia conexão WhatsApp via UAZAPI e retorna QR code',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      const cfg = channel.config as UazapiConfig
      let instanceToken = cfg.uazapiInstanceToken

      // 1. Init instance if no token yet
      if (!instanceToken) {
        const initResult = await uazapiFetch(
          cfg.uazapiUrl,
          '/instance/init',
          { adminToken: cfg.uazapiAdminToken },
          {
            method: 'POST',
            body: JSON.stringify({ name: cfg.instanceName }),
          },
        )
        if (!initResult.ok || !initResult.data?.token) {
          return reply.status(502).send({
            error: 'Não foi possível criar a instância no UAZAPI.',
            detail: initResult.data,
          })
        }
        instanceToken = initResult.data.token as string
        // Save token in config
        await prisma.channel.update({
          where: { id },
          data: {
            config: {
              ...cfg,
              uazapiInstanceToken: instanceToken,
            } as Prisma.InputJsonValue,
          },
        })
      }

      // 2. Configure webhook
      const backendUrl = (process.env.BACKEND_URL ?? '').replace(/\/$/, '')
      if (backendUrl) {
        await uazapiFetch(
          cfg.uazapiUrl,
          '/webhook',
          { instanceToken },
          {
            method: 'POST',
            body: JSON.stringify({
              enabled: true,
              url: `${backendUrl}/channels/whatsapp/webhook`,
              events: [
                'messages',
                'connection',
                'labels',
                'chat_labels',
                'contacts',
              ],
              excludeMessages: ['wasSentByApi'],
            }),
          },
        ).catch(() => null)
      }

      // 3. Connect (triggers QR code generation)
      await uazapiFetch(
        cfg.uazapiUrl,
        '/instance/connect',
        { instanceToken },
        { method: 'POST' },
      )

      // 4. Get status with QR code
      const statusResult = await uazapiFetch(
        cfg.uazapiUrl,
        '/instance/status',
        { instanceToken },
      )

      if (!statusResult.ok) {
        return reply
          .status(502)
          .send({ error: 'Não foi possível obter o QR code do UAZAPI.' })
      }

      // Update status to connecting
      await prisma.channel.update({
        where: { id },
        data: { status: 'connecting' },
      })

      return {
        qrCode:
          statusResult.data?.qrcode ??
          statusResult.data?.instance?.qrcode ??
          null,
        pairingCode: statusResult.data?.paircode ?? null,
      }
    },
  )

  // POST /channels/:id/whatsapp/sync-profile — sincroniza foto do perfil
  app.post(
    '/:id/whatsapp/sync-profile',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Sincroniza foto do perfil do canal WhatsApp',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      if (channel.status !== 'connected') {
        return reply.status(409).send({ error: 'Canal não está conectado.' })
      }

      const cfg = channel.config as UazapiConfig

      if (!cfg.phone) {
        return reply
          .status(400)
          .send({ error: 'Canal não possui número de telefone configurado.' })
      }

      try {
        const statusResult = await uazapiFetch(
          cfg.uazapiUrl,
          '/instance/status',
          { instanceToken: cfg.uazapiInstanceToken },
        )

        if (statusResult.ok && statusResult.data?.profilePicUrl) {
          const updatedConfig = {
            ...(channel.config as Record<string, unknown>),
            profilePictureUrl: statusResult.data.profilePicUrl,
          }

          await prisma.channel.update({
            where: { id },
            data: { config: updatedConfig as Prisma.InputJsonValue },
          })

          return {
            success: true,
            profilePictureUrl: statusResult.data.profilePicUrl,
          }
        }

        return reply
          .status(404)
          .send({ error: 'Foto do perfil não encontrada.' })
      } catch (err) {
        log.error(`Erro ao buscar foto do perfil: ${err}`)
        return reply
          .status(502)
          .send({ error: 'Erro ao buscar foto do perfil do UAZAPI.' })
      }
    },
  )

  // GET /channels/:id/whatsapp/status — consulta status da instância
  app.get(
    '/:id/whatsapp/status',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Consulta o status da conexão WhatsApp',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      const cfg = channel.config as UazapiConfig

      if (!cfg.uazapiInstanceToken) {
        return { channelStatus: channel.status, instanceState: 'unknown' }
      }

      const result = await uazapiFetch(cfg.uazapiUrl, '/instance/status', {
        instanceToken: cfg.uazapiInstanceToken,
      })

      if (!result.ok) {
        return { channelStatus: channel.status, instanceState: 'unknown' }
      }

      const instanceState: string =
        result.data?.status ?? result.data?.instance?.status ?? 'unknown'
      const instanceNumber: string | undefined = result.data?.owner || undefined
      const profilePicUrl: string | undefined =
        result.data?.profilePicUrl || undefined
      const qrCode: string | undefined =
        result.data?.qrcode || result.data?.instance?.qrcode || undefined

      // UAZAPI states map directly
      const newStatus =
        instanceState === 'connected'
          ? 'connected'
          : instanceState === 'connecting'
            ? 'connecting'
            : instanceState === 'disconnected'
              ? 'disconnected'
              : channel.status

      const currentProfilePic = cfg.profilePictureUrl
      const needsUpdate =
        newStatus !== channel.status ||
        (instanceNumber && !cfg.phone) ||
        (!currentProfilePic && profilePicUrl)

      let finalConfig = cfg
      if (needsUpdate) {
        const updatedConfig: any = {
          ...cfg,
          ...(instanceNumber ? { phone: instanceNumber } : {}),
          ...(profilePicUrl && !currentProfilePic
            ? { profilePictureUrl: profilePicUrl }
            : {}),
        }

        await prisma.channel.update({
          where: { id },
          data: {
            status: newStatus,
            config: updatedConfig as Prisma.InputJsonValue,
          },
        })

        finalConfig = updatedConfig
        log.info(
          `✅ Canal ${channel.name} atualizado - Status: ${newStatus}, Phone: ${instanceNumber ?? 'N/A'}`,
        )
      }

      return {
        channelStatus: newStatus,
        instanceState,
        phone: instanceNumber ?? cfg.phone,
        profilePictureUrl: (finalConfig as any).profilePictureUrl,
        ...(qrCode ? { qrCode } : {}),
      }
    },
  )

  // POST /channels/:id/whatsapp/send — envia mensagem de texto ou mídia via UAZAPI
  app.post(
    '/:id/whatsapp/send',
    {
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
            text: { type: 'string', minLength: 1 },
            replyid: { type: 'string' }, // ID curto do WhatsApp da mensagem a responder
            mediaMessage: {
              type: 'object',
              properties: {
                mediatype: {
                  type: 'string',
                  enum: ['image', 'video', 'audio', 'document', 'ptt'],
                },
                fileName: { type: 'string' },
                media: { type: 'string' }, // base64 sem prefixo data:
                caption: { type: 'string' },
              },
              required: ['mediatype', 'media'],
            },
          },
          oneOf: [{ required: ['text'] }, { required: ['mediaMessage'] }],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { number, text, mediaMessage, replyid } = request.body as {
        number: string
        text?: string
        replyid?: string
        mediaMessage?: {
          mediatype: string
          fileName?: string
          media: string
          caption?: string
        }
      }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      if (channel.status !== 'connected') {
        return reply.status(409).send({ error: 'Canal não está conectado.' })
      }

      const cfg = channel.config as UazapiConfig

      // Remove sufixo @s.whatsapp.net se vier o JID completo
      const cleanNumber = number.includes('@') ? number.split('@')[0] : number

      let result

      if (mediaMessage) {
        // Envia mídia
        result = await uazapiFetch(
          cfg.uazapiUrl,
          '/send/media',
          { instanceToken: cfg.uazapiInstanceToken },
          {
            method: 'POST',
            body: JSON.stringify({
              number: cleanNumber,
              type: mediaMessage.mediatype,
              file: mediaMessage.media,
              text: mediaMessage.caption,
              docName: mediaMessage.fileName,
              ...(replyid ? { replyid } : {}),
            }),
          },
        )
      } else if (text) {
        // Envia texto
        result = await uazapiFetch(
          cfg.uazapiUrl,
          '/send/text',
          { instanceToken: cfg.uazapiInstanceToken },
          {
            method: 'POST',
            body: JSON.stringify({ number: cleanNumber, text, ...(replyid ? { replyid } : {}) }),
          },
        )
      } else {
        return reply
          .status(400)
          .send({ error: 'É necessário enviar text ou mediaMessage.' })
      }

      if (!result.ok) {
        return reply
          .status(502)
          .send({ error: 'Falha ao enviar mensagem.', detail: result.data })
      }

      return reply.status(200).send({ ok: true, data: result.data })
    },
  )

  // GET /channels/:id/whatsapp/media/:messageId — busca base64 de mídia sob demanda
  app.get(
    '/:id/whatsapp/media/:messageId',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Busca base64 de mensagem de mídia via UAZAPI',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, messageId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id, messageId } = request.params as {
        id: string
        messageId: string
      }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp')
        return reply.status(404).send({ error: 'Canal não encontrado.' })

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
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
        return reply
          .status(400)
          .send({ error: 'Mensagem sem ID externo do WhatsApp.' })
      }

      const cfg = channel.config as UazapiConfig

      try {
        const result = await uazapiFetch(
          cfg.uazapiUrl,
          '/message/download',
          { instanceToken: cfg.uazapiInstanceToken },
          {
            method: 'POST',
            body: JSON.stringify({ id: message.externalId }),
          },
        )

        if (!result.ok) {
          log.error(`UAZAPI erro ao buscar mídia: Status ${result.status}`)
          return reply.status(502).send({
            error: 'Não foi possível obter a mídia do UAZAPI.',
            details: result.data,
          })
        }

        const mimeType =
          (result.data.mimetype as string) ?? 'application/octet-stream'

        // UAZAPI retorna fileURL — baixa e converte para base64
        if (result.data?.fileURL) {
          const fileRes = await fetch(result.data.fileURL as string)
          if (!fileRes.ok) {
            log.error(
              `Erro ao baixar mídia da URL: ${result.data.fileURL} — status ${fileRes.status}`,
            )
            return reply
              .status(502)
              .send({ error: 'Erro ao baixar mídia do UAZAPI.' })
          }
          const buffer = Buffer.from(await fileRes.arrayBuffer())
          return {
            base64: buffer.toString('base64'),
            mediaType: message.type,
            mimeType,
          }
        }

        // Fallback: base64 direto (caso futuro)
        if (result.data?.base64) {
          return {
            base64: result.data.base64 as string,
            mediaType: message.type,
            mimeType,
          }
        }

        log.error('UAZAPI retornou sem fileURL nem base64')
        return reply
          .status(502)
          .send({ error: 'Mídia não disponível no UAZAPI.' })
      } catch (error) {
        log.error(
          `Erro ao buscar mídia: ${error instanceof Error ? error.message : error}`,
        )
        return reply
          .status(502)
          .send({ error: 'Erro ao comunicar com UAZAPI.' })
      }
    },
  )

  // POST /channels/whatsapp/webhook — recebe eventos do UAZAPI
  // Configure a URL no painel do UAZAPI: POST /channels/whatsapp/webhook
  app.post(
    '/whatsapp/webhook',
    {
      schema: {
        summary: 'Webhook para eventos do UAZAPI',
      } as never,
    },
    async (request, reply) => {
      const body = request.body as {
        BaseUrl?: string
        EventType?: string
        instanceName?: string
        owner?: string
        token?: string
        instance?: {
          status?: string
          qrcode?: string
          name?: string
          profilePicUrl?: string
          lastDisconnect?: string
          lastDisconnectReason?: string
        }
        message?: {
          id?: string
          chatid?: string
          fromMe?: boolean
          isGroup?: boolean
          type?: string
          mediaType?: string
          messageType?: string
          content?: any
          text?: string
          senderName?: string
          messageTimestamp?: number
          wasSentByApi?: boolean
        }
        chat?: {
          phone?: string
          name?: string
          image?: string
          wa_chatid?: string
          wa_name?: string
          wa_contactName?: string
          wa_label?: any[]
        }
        // contacts event (array at top level)
        contacts?: Array<{
          id?: string
          name?: string
          phone?: string
          image?: string
        }>
      }

      const event = (body.EventType ?? '').toLowerCase()

      if (!body.instanceName) {
        console.log('parou #1')
        return reply.status(200).send({ ok: true })
      }

      // Find channel by instanceName
      const channels = await prisma.channel.findMany({
        where: { type: 'whatsapp' },
      })
      const channel = channels.find(ch => {
        const cfg = ch.config as UazapiConfig | null
        return cfg?.instanceName === body.instanceName
      })

      if (!channel) {
        console.log(
          `webhook: instância "${body.instanceName}" não encontrada no banco`,
        )
        return reply.status(200).send({ ok: true })
      }

      // ── connection: update status ───────────────────────────────
      if (event === 'connection' && body.instance) {
        const instanceStatus = body.instance.status ?? ''
        const newStatus =
          instanceStatus === 'connected'
            ? 'connected'
            : instanceStatus === 'connecting'
              ? 'connecting'
              : instanceStatus === 'disconnected'
                ? 'disconnected'
                : null

        log.info(
          `📞 connection - Canal: ${channel.name}, Estado: ${instanceStatus}, Número: ${body.owner ?? 'N/A'}`,
        )

        if (newStatus) {
          const currentConfig = channel.config as Record<string, unknown>
          const phoneNumber =
            body.owner || (channel.config as UazapiConfig).phone

          await prisma.channel.update({
            where: { id: channel.id },
            data: {
              status: newStatus,
              config: {
                ...currentConfig,
                phone: phoneNumber,
              } as Prisma.InputJsonValue,
            },
          })
          log.info(
            `✅ Canal ${channel.name} atualizado - Status: ${newStatus}, Phone: ${phoneNumber ?? 'N/A'}`,
          )

          // Fetch profile pic in background
          if (newStatus === 'connected' && body.instance.profilePicUrl) {
            prisma.channel
              .update({
                where: { id: channel.id },
                data: {
                  config: {
                    ...currentConfig,
                    phone: phoneNumber,
                    profilePictureUrl: body.instance.profilePicUrl,
                  } as Prisma.InputJsonValue,
                },
              })
              .then(() =>
                log.info(`✅ Foto do perfil salva para ${channel.name}`),
              )
              .catch((err: unknown) =>
                log.warn(`⚠️ Foto do perfil falhou: ${err}`),
              )
          }
        }
      }

      // ── messages: enqueue for async processing ───────────────
      if (event === 'messages' && body.message) {
        const msg = body.message

        log.info(
          `📩 Webhook mensagem recebida - chatid: ${msg.chatid}, fromMe: ${msg.fromMe}, type: ${msg.type}, mediaType: ${msg.mediaType}, wasSentByApi: ${msg.wasSentByApi}, isGroup: ${msg.isGroup}, id: ${msg.id}`,
        )

        if (msg.wasSentByApi || msg.isGroup) {
          log.info(
            `⏭️ Mensagem ignorada - wasSentByApi: ${msg.wasSentByApi}, isGroup: ${msg.isGroup}`,
          )
          return reply.status(200).send({ ok: true })
        }

        // UAZAPI pode enviar chatid com @lid em vez de @s.whatsapp.net
        // Usa sender_pn (phone number JID) ou chat.wa_chatid como fallback
        let chatId = msg.chatid ?? ''
        if (!chatId.includes('@s.whatsapp.net') && !chatId.includes('@c.us')) {
          // Tenta usar o campo sender_pn ou construir a partir do chat.phone
          const senderPn = (msg as any).sender_pn ?? ''
          const chatPhone = body.chat?.phone ?? ''
          if (senderPn && senderPn.includes('@s.whatsapp.net')) {
            chatId = senderPn
          } else if (
            body.chat?.wa_chatid &&
            body.chat.wa_chatid.includes('@s.whatsapp.net')
          ) {
            chatId = body.chat.wa_chatid
          } else if (chatPhone) {
            chatId = `${chatPhone}@s.whatsapp.net`
          }
          if (chatId !== (msg.chatid ?? '')) {
            log.info(`🔄 chatId corrigido: ${msg.chatid} → ${chatId}`)
          }
        }

        // Extrai texto/label da mensagem citada quando é um reply
        let quotedText: string | undefined
        if (typeof msg.content === 'object' && msg.content !== null) {
          const qm = (msg.content as any)?.contextInfo?.quotedMessage
          if (qm) {
            if (qm.conversation)                          quotedText = qm.conversation
            else if (qm.extendedTextMessage?.text)        quotedText = qm.extendedTextMessage.text
            else if (qm.imageMessage)                     quotedText = qm.imageMessage.caption || '[Imagem]'
            else if (qm.videoMessage)                     quotedText = qm.videoMessage.caption || '[Vídeo]'
            else if (qm.audioMessage || qm.pttMessage)    quotedText = '[Áudio]'
            else if (qm.documentMessage)                  quotedText = qm.documentMessage.fileName || '[Documento]'
            else if (qm.stickerMessage)                   quotedText = '[Figurinha]'
            else                                          quotedText = '[Mídia]'
          }
        }

        // Processa inline (sem BullMQ) — fire-and-forget para não bloquear o webhook
        processUazapiMessage({
          channelId: channel.id,
          organizationId: channel.organizationId,
          channelName: channel.name,
          chatId,
          fromMe: msg.fromMe ?? false,
          messageId: msg.id ?? '',
          type: msg.type ?? 'text',
          mediaType: msg.mediaType ?? '',
          messageType: msg.messageType ?? '',
          content: msg.content ?? '',
          text: msg.text ?? '',
          senderName: msg.senderName ?? '',
          messageTimestamp: msg.messageTimestamp ?? Date.now(),
          chatImage: body.chat?.image,
          quoted: msg.quoted || undefined,
          quotedText,
        }).catch(err =>
          log.error(`[Webhook] Erro ao processar mensagem ${msg.id}: ${err}`),
        )
      }

      // ── contacts: sync contact name and avatar ───────────────
      if (event === 'contacts' && body.contacts && body.contacts.length > 0) {
        for (const waContact of body.contacts) {
          const phone = waContact.phone ?? ''
          if (!phone) continue

          const jid = `${phone}@s.whatsapp.net`
          const updateData: Record<string, string> = {}
          if (waContact.name) updateData.name = waContact.name
          if (waContact.image) updateData.avatarUrl = waContact.image

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

      // ── labels: rename or delete tag when WA label changes ───
      if (event === 'labels' && body.instance) {
        // UAZAPI fires labels event — handle similar to LABELS_EDIT
        // Payload structure may vary; handle gracefully
        const dataObj = body as any
        const waLabelId = (dataObj.id ?? '').toString().trim()
        const newName = (dataObj.name ?? '').trim()
        const deleted = dataObj.deleted ?? false
        const color =
          dataObj.colorHex ??
          (dataObj.color !== undefined ? WA_COLORS[dataObj.color] : undefined)

        if (waLabelId) {
          const pc = prisma as any
          const tag = await pc.tag.findFirst({
            where: {
              organizationId: channel.organizationId,
              OR: [
                { waLabelId },
                ...(newName
                  ? [{ name: { equals: newName, mode: 'insensitive' } }]
                  : []),
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
                  waLabelId,
                },
              })
            }
          }
        }
      }

      // ── chat_labels: sync label association with ContactTag ──
      if (event === 'chat_labels') {
        const dataObj = body as any
        const jid = (dataObj.chatid ?? dataObj.id ?? '').toString().trim()
        const label = dataObj.label
        const labelName = (label?.name ?? '').trim()
        const waLabelId = (label?.id ?? '').toString().trim()
        const assocType = dataObj.type ?? dataObj.action ?? ''

        if (
          jid &&
          labelName &&
          (jid.includes('@s.whatsapp.net') || jid.includes('@c.us'))
        ) {
          const pc = prisma as any
          const contact = await pc.contact.findFirst({
            where: { organizationId: channel.organizationId, externalId: jid },
          })

          if (contact) {
            if (assocType === 'add') {
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
                const color =
                  label?.colorHex ??
                  (label?.color !== undefined
                    ? WA_COLORS[label.color]
                    : undefined) ??
                  '#6366f1'
                tag = await pc.tag.create({
                  data: {
                    organizationId: channel.organizationId,
                    name: labelName,
                    color,
                    ...(waLabelId ? { waLabelId } : {}),
                  },
                })
              } else if (waLabelId && !tag.waLabelId) {
                await pc.tag.update({
                  where: { id: tag.id },
                  data: { waLabelId },
                })
              }
              await pc.contactTag.upsert({
                where: {
                  contactId_tagId: { contactId: contact.id, tagId: tag.id },
                },
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
    },
  )

  // POST /channels/:id/whatsapp/import-labels
  // Importa as labels do WhatsApp Business como tags da organização (ignora duplicatas por nome)
  app.post(
    '/:id/whatsapp/import-labels',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Importa labels do WhatsApp Business como tags da organização',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      if (channel.status !== 'connected') {
        return reply.status(409).send({ error: 'Canal não está conectado.' })
      }

      const cfg = channel.config as UazapiConfig

      // Busca labels no UAZAPI
      const result = await uazapiFetch(cfg.uazapiUrl, '/labels', {
        instanceToken: cfg.uazapiInstanceToken,
      })

      if (!result.ok) {
        return reply.status(502).send({
          error: 'Não foi possível buscar as labels do WhatsApp.',
          detail: result.data,
        })
      }

      const labels: { id: string; name: string; color: number }[] =
        Array.isArray(result.data) ? result.data : []

      if (labels.length === 0) {
        return {
          created: 0,
          skipped: 0,
          message: 'Nenhuma label encontrada no WhatsApp Business.',
        }
      }

      // Busca tags existentes para evitar duplicatas e retroativamente preencher waLabelId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc = prisma as any
      const existing: { id: string; name: string; waLabelId: string | null }[] =
        await pc.tag.findMany({
          where: { organizationId: channel.organizationId },
          select: { id: true, name: true, waLabelId: true },
        })
      const existingByName = new Map(
        existing.map(t => [t.name.toLowerCase(), t]),
      )

      let created = 0
      let skipped = 0

      for (const label of labels) {
        const name = (label.name ?? '').trim()
        const waLabelId = (label.id ?? '').toString().trim()
        if (!name) {
          skipped++
          continue
        }

        const existing = existingByName.get(name.toLowerCase())
        if (existing) {
          // Tag já existe — retroativamente salva waLabelId se ainda não tem
          if (waLabelId && !existing.waLabelId) {
            await pc.tag.update({
              where: { id: existing.id },
              data: { waLabelId },
            })
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
    },
  )

  // POST /channels/:id/whatsapp/sync-label-contacts
  // Lê os chats do UAZAPI (que incluem as labels de cada conversa) e associa
  // cada contato existente no banco às tags correspondentes da organização.
  app.post(
    '/:id/whatsapp/sync-label-contacts',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary: 'Sincroniza contatos com as etiquetas do WhatsApp Business',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

      if (channel.status !== 'connected') {
        return reply.status(409).send({ error: 'Canal não está conectado.' })
      }

      const cfg = channel.config as UazapiConfig

      // Busca todos os chats do UAZAPI — cada chat inclui o array "labels"
      const result = await uazapiFetch(
        cfg.uazapiUrl,
        '/chat/find',
        { instanceToken: cfg.uazapiInstanceToken },
        {
          method: 'POST',
          body: JSON.stringify({ wa_isGroup: false }),
        },
      )

      if (!result.ok) {
        return reply.status(502).send({
          error: 'Não foi possível buscar os chats do WhatsApp.',
          detail: result.data,
        })
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
      const orgTags: Array<{ id: string; name: string }> =
        await pc.tag.findMany({
          where: { organizationId: channel.organizationId },
          select: { id: true, name: true },
        })
      const tagByName = new Map(
        orgTags.map((t: { id: string; name: string }) => [
          t.name.toLowerCase(),
          t.id,
        ]),
      )

      let synced = 0

      for (const chat of chats) {
        const jid = chat.remoteJid ?? chat.id?.remote ?? ''

        // Só processa conversas individuais (não grupos)
        if (
          !jid ||
          (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us'))
        )
          continue

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
    },
  )

  // POST /channels/:id/whatsapp/sync-history
  // Importa o histórico de mensagens do UAZAPI para o banco de dados.
  // Para cada chat individual, busca as mensagens e salva (upsert por externalId).
  // Aceita parâmetro opcional `limit` (máx de mensagens por contato, default 200).
  app.post(
    '/:id/whatsapp/sync-history',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Channels'],
        summary:
          'Importa histórico de mensagens do WhatsApp Business para o banco',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { limit: msgLimit = 200 } = (request.body ?? {}) as {
        limit?: number
      }
      const userId = request.session.user.id

      const channel = await prisma.channel.findUnique({ where: { id } })
      if (!channel || channel.type !== 'whatsapp') {
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp não encontrado.' })
      }
      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
      if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })
      if (channel.status !== 'connected') {
        return reply.status(409).send({ error: 'Canal não está conectado.' })
      }

      const cfg = channel.config as UazapiConfig

      // 1. Busca todos os chats da instância
      const chatsResult = await uazapiFetch(
        cfg.uazapiUrl,
        '/chat/find',
        { instanceToken: cfg.uazapiInstanceToken },
        {
          method: 'POST',
          body: JSON.stringify({ wa_isGroup: false }),
        },
      )
      if (!chatsResult.ok) {
        return reply.status(502).send({
          error: 'Não foi possível buscar os chats.',
          detail: chatsResult.data,
        })
      }

      type WaChat = { remoteJid?: string; id?: { remote?: string } }
      const chats: WaChat[] = Array.isArray(chatsResult.data)
        ? chatsResult.data
        : []

      // Estrutura de uma mensagem retornada pelo UAZAPI
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
        if (
          !jid ||
          (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us'))
        )
          continue

        // 2. Busca mensagens deste chat no UAZAPI
        const msgsResult = await uazapiFetch(
          cfg.uazapiUrl,
          '/message/find',
          { instanceToken: cfg.uazapiInstanceToken },
          {
            method: 'POST',
            body: JSON.stringify({
              chatid: jid,
              ...(msgLimit ? { limit: msgLimit } : {}),
            }),
          },
        )
        if (!msgsResult.ok) continue

        // O UAZAPI pode retornar mensagens em vários formatos:
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
          const firstName = msgs.find(
            m => !m.key?.fromMe && m.pushName,
          )?.pushName
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
          type MsgType =
            | 'text'
            | 'image'
            | 'audio'
            | 'video'
            | 'document'
            | 'sticker'
          let msgType: MsgType = 'text'
          let content = ''

          if (msg.message?.conversation) {
            content = msg.message.conversation
            msgType = 'text'
          } else if (msg.message?.extendedTextMessage?.text) {
            content = msg.message.extendedTextMessage.text
            msgType = 'text'
          } else if (msg.message?.imageMessage != null) {
            content = msg.message.imageMessage?.caption ?? ''
            msgType = 'image'
          } else if (msg.message?.videoMessage != null) {
            content = msg.message.videoMessage?.caption ?? ''
            msgType = 'video'
          } else if (msg.message?.audioMessage != null) {
            content = ''
            msgType = 'audio'
          } else if (msg.message?.documentMessage != null) {
            content = msg.message.documentMessage?.caption ?? ''
            msgType = 'document'
          } else if (msg.message?.stickerMessage != null) {
            content = ''
            msgType = 'sticker'
          }

          const isMedia = [
            'image',
            'audio',
            'video',
            'document',
            'sticker',
          ].includes(msgType)
          if (!content && !isMedia) continue

          const createdAt = msg.messageTimestamp
            ? new Date(msg.messageTimestamp * 1000)
            : new Date()

          // Upsert: se já existe pela externalId, não duplica
          const existing = await prisma.message.findFirst({
            where: {
              organizationId: channel.organizationId,
              externalId: msg.key.id,
            },
          })
          if (!existing) {
            await prisma.message.create({
              data: {
                organizationId: channel.organizationId,
                contactId: contact.id,
                channelId: channel.id,
                direction: fromMe ? 'outbound' : 'inbound',
                type: msgType,
                content,
                status: 'sent',
                externalId: msg.key.id,
                createdAt,
              },
            })
            importedMessages++
          }
        }
      }

      return {
        importedMessages,
        importedContacts,
        chatsProcessed: chats.filter(c => {
          const j = c.remoteJid ?? c.id?.remote ?? ''
          return j.includes('@s.whatsapp.net') || j.includes('@c.us')
        }).length,
      }
    },
  )

  // POST /channels/whatsapp/sync-all-history
  // Enfileira um job de sincronização completa de histórico (processado pelo SyncWorker).
  app.post(
    '/whatsapp/sync-all-history',
    {
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const userId = request.session.user.id
      const orgId = request.organizationId
      if (!orgId)
        return reply.status(400).send({ error: 'Organização não detectada.' })

      const member = await prisma.member.findFirst({
        where: { organizationId: orgId, userId },
      })
      if (!member || !['admin', 'owner'].includes(member.role)) {
        return reply.status(403).send({
          error: 'Apenas admin/owner pode sincronizar o histórico completo.',
        })
      }

      // Impede jobs duplicados: verifica se já há sync ativo/aguardando para esta org
      const [waitingJobs, activeJobs] = await Promise.all([
        syncQueue.getJobs(['waiting']),
        syncQueue.getJobs(['active']),
      ])
      const existing = [...waitingJobs, ...activeJobs].find(
        j =>
          j.name === 'sync-all-history' &&
          (j.data as { orgId: string }).orgId === orgId,
      )
      if (existing) {
        return reply.status(409).send({
          error:
            'Já existe uma sincronização em andamento para esta organização.',
          jobId: existing.id,
        })
      }

      const job = await syncQueue.add('sync-all-history', { orgId, userId })
      return { jobId: job.id, queued: true }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════════
  // WHATSAPP BUSINESS API (META) ROUTES
  // ═══════════════════════════════════════════════════════════════════════════════

  // POST /channels/:id/whatsapp-business/send — envia mensagem via WhatsApp Business API
  app.post(
    '/:id/whatsapp-business/send',
    {
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
            mediaType: {
              type: 'string',
              enum: ['image', 'video', 'audio', 'document'],
            },
            caption: { type: 'string' },
          },
          oneOf: [
            { required: ['text'] },
            { required: ['mediaUrl', 'mediaType'] },
          ],
        },
      },
    },
    async (request, reply) => {
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
        return reply
          .status(404)
          .send({ error: 'Canal WhatsApp Business não encontrado.' })
      }

      const isMember = await prisma.member.findFirst({
        where: { organizationId: channel.organizationId, userId },
      })
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
        result = await whatsappBusinessFetch(
          cfg,
          `/${cfg.phoneNumberId}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              messaging_product,
              recipient_type,
              to,
              type: 'text',
              text: { body: text },
            }),
          },
        )
      } else if (mediaUrl && mediaType) {
        // Mensagem de mídia
        const mediaBody: Record<string, unknown> = { link: mediaUrl }
        if (caption) mediaBody.caption = caption

        result = await whatsappBusinessFetch(
          cfg,
          `/${cfg.phoneNumberId}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              messaging_product,
              recipient_type,
              to,
              type: mediaType,
              [mediaType]: mediaBody,
            }),
          },
        )
      } else {
        return reply.status(400).send({
          error: 'É necessário enviar text ou (mediaUrl + mediaType).',
        })
      }

      if (!result.ok) {
        log.error(
          `WhatsApp Business API erro ao enviar: ${JSON.stringify(result.data)}`,
        )
        return reply
          .status(502)
          .send({ error: 'Falha ao enviar mensagem.', detail: result.data })
      }

      return reply.status(200).send({ ok: true, data: result.data })
    },
  )

  // GET /channels/whatsapp-business/webhook — verificação do webhook Meta
  app.get(
    '/whatsapp-business/webhook',
    {
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
    },
    async (request, reply) => {
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

        const channel = channels.find(ch => {
          const cfg = ch.config as WhatsAppBusinessConfig | null
          return cfg?.webhookVerifyToken === token
        })

        if (channel && challenge) {
          log.info(`Webhook WhatsApp Business verificado: ${channel.name}`)
          return reply.status(200).send(challenge)
        }
      }

      return reply.status(403).send('Forbidden')
    },
  )

  // POST /channels/whatsapp-business/webhook — recebe mensagens do Meta
  app.post(
    '/whatsapp-business/webhook',
    {
      schema: {
        summary: 'Webhook para receber mensagens WhatsApp Business API',
      } as never,
    },
    async (request, reply) => {
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
                document?: {
                  caption?: string
                  filename?: string
                  id?: string
                  mime_type?: string
                }
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

          const channel = channels.find(ch => {
            const cfg = ch.config as WhatsAppBusinessConfig | null
            return cfg?.phoneNumberId === phoneNumberId
          })

          if (!channel) {
            log.warn(`Webhook: phoneNumberId "${phoneNumberId}" não encontrado`)
            continue
          }

          // Enfileira mensagens recebidas para processamento assíncrono
          for (const message of value.messages ?? []) {
            const from = message.from ?? ''
            const msgId = message.id ?? ''
            const timestamp = message.timestamp ?? ''
            const type = message.type ?? 'text'

            if (!from || !msgId) continue

            // Detecta tipo e conteúdo antes de enfileirar
            let content = ''
            let msgType: WaBusinessMessageJobData['msgType'] = 'text'

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
              content =
                message.document?.filename ?? message.document?.caption ?? ''
              msgType = 'document'
            }

            const contactName =
              value.contacts?.find(c => c.wa_id === from)?.profile?.name ?? from

            messageQueue
              .add('process-wa-business-message', {
                source: 'whatsapp-business',
                channelId: channel.id,
                organizationId: channel.organizationId,
                from,
                msgId,
                timestamp,
                msgType,
                content,
                contactName,
              })
              .catch((err: unknown) =>
                log.error(`[WA Business Webhook] Falha ao enfileirar: ${err}`),
              )
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
    },
  )
}
