import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type CampaignBody = {
    orgId: string
    name: string
    description?: string
    status?: string
    keywords?: string[]
    startDate?: string
    endDate?: string
    goalLeads?: number
    sourceChannel?: string
}

type FbWebhookEntry = {
    id: string
    time: number
    changes: Array<{
        field: string
        value: {
            leadgen_id: string
            page_id: string
            form_id: string
            adgroup_id?: string
        }
    }>
}

// ─── Helper: fetch lead data from Facebook Graph API ─────────────────────────

async function fetchFbLead(formId: string, leadId: string, pageToken: string) {
    const url = `https://graph.facebook.com/v19.0/${leadId}?access_token=${pageToken}&fields=field_data,created_time,ad_name,form_id`
    const res = await fetch(url)
    if (!res.ok) return null
    return res.json() as Promise<{
        id: string
        field_data: Array<{ name: string; values: string[] }>
        created_time: string
        ad_name?: string
        form_id?: string
    }>
}

// ─── Helper: extract contact fields from field_data ──────────────────────────

function extractLeadFields(fieldData: Array<{ name: string; values: string[] }>) {
    const get = (keys: string[]) => {
        for (const key of keys) {
            const f = fieldData.find((d) => d.name.toLowerCase().includes(key))
            if (f?.values?.[0]) return f.values[0]
        }
        return undefined
    }
    return {
        name:  get(['full_name', 'nome', 'name', 'first_name']),
        email: get(['email']),
        phone: get(['phone', 'telefone', 'celular', 'mobile']),
    }
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export default async function (app: FastifyInstance) {

    // ── GET /campaigns?orgId= ─────────────────────────────────────────────────

    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Campaigns'],
            summary: 'Lista campanhas da organização',
            querystring: {
                type: 'object',
                required: ['orgId'],
                properties: { orgId: { type: 'string' } },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const campaigns = await prisma.campaign.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { leads: true } } },
        })

        return campaigns
    })

    // ── POST /campaigns ───────────────────────────────────────────────────────

    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Campaigns'],
            summary: 'Cria nova campanha',
            body: {
                type: 'object',
                required: ['orgId', 'name'],
                properties: {
                    orgId:         { type: 'string' },
                    name:          { type: 'string', minLength: 1 },
                    description:   { type: 'string' },
                    status:        { type: 'string' },
                    keywords:      { type: 'array', items: { type: 'string' } },
                    startDate:     { type: 'string' },
                    endDate:       { type: 'string' },
                    goalLeads:     { type: 'integer' },
                    sourceChannel: { type: 'string' },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CampaignBody
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: body.orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const campaign = await prisma.campaign.create({
            data: {
                organizationId: body.orgId,
                name:           body.name,
                description:    body.description,
                status:         body.status ?? 'active',
                keywords:       body.keywords ?? [],
                startDate:      body.startDate ? new Date(body.startDate) : null,
                endDate:        body.endDate   ? new Date(body.endDate)   : null,
                goalLeads:      body.goalLeads,
                sourceChannel:  body.sourceChannel ?? 'all',
            },
        })

        return reply.status(201).send(campaign)
    })

    // ── PATCH /campaigns/:id ──────────────────────────────────────────────────

    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Campaigns'],
            summary: 'Atualiza campanha',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:          { type: 'string' },
                    description:   { type: 'string' },
                    status:        { type: 'string' },
                    keywords:      { type: 'array', items: { type: 'string' } },
                    startDate:     { type: 'string', nullable: true },
                    endDate:       { type: 'string', nullable: true },
                    goalLeads:     { type: 'integer', nullable: true },
                    sourceChannel: { type: 'string' },
                    // Facebook fields
                    fbPageId:      { type: 'string', nullable: true },
                    fbPageToken:   { type: 'string', nullable: true },
                    fbFormIds:     { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const body = request.body as Partial<CampaignBody & {
            fbPageId?: string | null
            fbPageToken?: string | null
            fbFormIds?: string[]
        }>
        const userId = request.session.user.id

        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: campaign.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const updated = await prisma.campaign.update({
            where: { id },
            data: {
                ...(body.name          !== undefined && { name:          body.name }),
                ...(body.description   !== undefined && { description:   body.description }),
                ...(body.status        !== undefined && { status:        body.status }),
                ...(body.keywords      !== undefined && { keywords:      body.keywords }),
                ...(body.startDate     !== undefined && { startDate:     body.startDate ? new Date(body.startDate) : null }),
                ...(body.endDate       !== undefined && { endDate:       body.endDate   ? new Date(body.endDate)   : null }),
                ...(body.goalLeads     !== undefined && { goalLeads:     body.goalLeads }),
                ...(body.sourceChannel !== undefined && { sourceChannel: body.sourceChannel }),
                ...(body.fbPageId      !== undefined && { fbPageId:      body.fbPageId }),
                ...(body.fbPageToken   !== undefined && { fbPageToken:   body.fbPageToken }),
                ...(body.fbFormIds     !== undefined && { fbFormIds:     body.fbFormIds }),
            },
        })

        return updated
    })

    // ── DELETE /campaigns/:id ─────────────────────────────────────────────────

    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Campaigns'],
            summary: 'Remove campanha',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: campaign.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.campaign.delete({ where: { id } })
        return reply.status(204).send()
    })

    // ── GET /campaigns/:id/leads ──────────────────────────────────────────────

    app.get('/:id/leads', {
        preHandler: requireAuth,
        schema: {
            tags: ['Campaigns'],
            summary: 'Lista leads de uma campanha',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            querystring: {
                type: 'object',
                properties: {
                    page:  { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                },
            },
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string }
        const { page = 1, limit = 50 } = request.query as { page?: number; limit?: number }
        const userId = request.session.user.id

        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: campaign.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const [total, leads] = await Promise.all([
            prisma.campaignLead.count({ where: { campaignId: id } }),
            prisma.campaignLead.findMany({
                where: { campaignId: id },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true, source: true, formName: true, fbLeadId: true, createdAt: true,
                    contact: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } },
                },
            }),
        ])

        return { total, page, limit, leads }
    })

    // ── GET /campaigns/facebook/webhook/:orgId — verificação pelo Facebook ────

    app.get('/facebook/webhook/:orgId', {
        schema: { tags: ['Campaigns'], summary: 'Verificação do webhook Facebook Lead Ads' },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId } = request.params as { orgId: string }
        const q = request.query as Record<string, string>

        if (q['hub.mode'] !== 'subscribe') {
            return reply.status(400).send({ error: 'hub.mode inválido' })
        }

        // Carrega o verify token da organização
        // Usamos um token gerado a partir do ID da org — simples e sem necessidade de config extra
        const expectedToken = `matra-fb-${orgId}`
        if (q['hub.verify_token'] !== expectedToken) {
            return reply.status(403).send({ error: 'Verify token inválido.' })
        }

        return reply.status(200).send(q['hub.challenge'])
    })

    // ── POST /campaigns/facebook/webhook/:orgId — recebe novos leads ──────────

    app.post('/facebook/webhook/:orgId', {
        config: { rawBody: true },
        schema: { tags: ['Campaigns'], summary: 'Webhook Facebook Lead Ads — recebe novos leads' },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId } = request.params as { orgId: string }

        // Valida assinatura com o App Secret da organização
        const org = await prisma.organization.findUnique({ where: { id: orgId } })
        if (!org || !org.fbAppSecret) {
            return reply.status(200).send('EVENT_RECEIVED') // ack sem processar
        }

        const signature = (request.headers['x-hub-signature-256'] as string)?.replace('sha256=', '')
        if (signature && org.fbAppSecret) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawBody = (request as any).rawBody as Buffer | string | undefined
            if (rawBody) {
                const expected = createHmac('sha256', org.fbAppSecret)
                    .update(rawBody)
                    .digest('hex')
                try {
                    const sigBuf = Buffer.from(signature,   'hex')
                    const expBuf = Buffer.from(expected,    'hex')
                    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
                        return reply.status(403).send({ error: 'Assinatura inválida.' })
                    }
                } catch {
                    return reply.status(403).send({ error: 'Assinatura inválida.' })
                }
            }
        }

        const body = request.body as { object?: string; entry?: FbWebhookEntry[] }
        if (body.object !== 'page' || !body.entry?.length) {
            return reply.status(200).send('EVENT_RECEIVED')
        }

        // Processar cada entry em background (respondemos 200 imediatamente)
        reply.status(200).send('EVENT_RECEIVED')

        for (const entry of body.entry) {
            for (const change of entry.changes ?? []) {
                if (change.field !== 'leadgen') continue

                const { leadgen_id, page_id, form_id } = change.value

                // Encontrar campanha que corresponde ao page_id + form_id
                const campaign = await prisma.campaign.findFirst({
                    where: {
                        organizationId: orgId,
                        fbPageId: page_id,
                    },
                })
                if (!campaign) continue

                const formIds = (campaign.fbFormIds as string[]) ?? []
                if (formIds.length > 0 && !formIds.includes(form_id)) continue

                // Verificar se lead já foi processado
                const existing = await prisma.campaignLead.findUnique({ where: { fbLeadId: leadgen_id } })
                if (existing) continue

                // Buscar dados do lead via Graph API
                if (!campaign.fbPageToken) continue
                const leadData = await fetchFbLead(form_id, leadgen_id, campaign.fbPageToken)
                if (!leadData) continue

                const { name, email, phone } = extractLeadFields(leadData.field_data ?? [])

                // Upsert contact
                let contactId: string | null = null
                if (name || email || phone) {
                    const contactName = name ?? email ?? phone ?? 'Lead Facebook'
                    let contact = email
                        ? await prisma.contact.findFirst({
                            where: { organizationId: orgId, email },
                        })
                        : null

                    if (!contact) {
                        contact = await prisma.contact.create({
                            data: {
                                organizationId: orgId,
                                name:  contactName,
                                email: email   ?? null,
                                phone: phone   ?? null,
                            },
                        })
                    }
                    contactId = contact.id
                }

                // Criar CampaignLead
                await prisma.campaignLead.create({
                    data: {
                        campaignId: campaign.id,
                        contactId,
                        fbLeadId:  leadgen_id,
                        source:    'facebook',
                        formName:  leadData.ad_name ?? null,
                        rawData:   leadData.field_data as object,
                    },
                })
            }
        }
    })
}
