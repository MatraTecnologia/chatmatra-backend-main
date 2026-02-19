import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { publishToOrg } from '../../lib/agentSse.js'

// ─── Helper Evolution API ─────────────────────────────────────────────────────

type WaConfig = { evolutionUrl: string; evolutionApiKey: string; instanceName: string }

async function evolutionFetch(
    cfg: Pick<WaConfig, 'evolutionUrl' | 'evolutionApiKey'>,
    path: string,
    options: RequestInit = {}
) {
    const url = `${cfg.evolutionUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'apikey': cfg.evolutionApiKey,
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

export default async function (app: FastifyInstance) {

    // GET /contacts?search=&page=&limit=
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Lista contatos da organização',
            querystring: {
                type: 'object',
                properties: {
                    search:      { type: 'string' },
                    tagId:       { type: 'string' },
                    hasMessages: { type: 'boolean' },
                    page:        { type: 'integer', minimum: 1, default: 1 },
                    limit:       { type: 'integer', minimum: 1, maximum: 500, default: 30 },
                },
            },
        },
    }, async (request, reply) => {
        const { search, tagId, hasMessages, page = 1, limit = 30 } = request.query as {
            search?: string
            tagId?: string
            hasMessages?: boolean
            page?: number
            limit?: number
        }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const where = {
            organizationId: orgId,
            ...(hasMessages ? { messages: { some: {} } } : {}),
            ...(tagId ? { tags: { some: { tagId } } } : {}),
            ...(search
                ? {
                    OR: [
                        { name:  { contains: search, mode: 'insensitive' as const } },
                        { phone: { contains: search, mode: 'insensitive' as const } },
                        { email: { contains: search, mode: 'insensitive' as const } },
                    ],
                }
                : {}),
        }

        const [total, contacts] = await Promise.all([
            prisma.contact.count({ where }),
            prisma.contact.findMany({
                where,
                orderBy: { updatedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true,
                    name: true,
                    phone: true,
                    email: true,
                    avatarUrl: true,
                    channelId: true,
                    externalId: true,
                    notes: true,
                    convStatus: true,
                    assignedToId: true,
                    createdAt: true,
                    updatedAt: true,
                    channel: {
                        select: { id: true, name: true, type: true, status: true },
                    },
                    tags: {
                        select: {
                            tag: { select: { id: true, name: true, color: true } },
                        },
                    },
                    assignedTo: {
                        select: { id: true, name: true, image: true },
                    },
                },
            }),
        ])

        return { total, page, limit, contacts }
    })

    // POST /contacts/sync/:channelId — importa contatos da instância WhatsApp
    app.post('/sync/:channelId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Importa contatos de uma instância WhatsApp (Evolution API)',
            params: { type: 'object', properties: { channelId: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { channelId } = request.params as { channelId: string }
        const userId = request.session.user.id

        const channel = await prisma.channel.findUnique({ where: { id: channelId } })
        if (!channel || channel.type !== 'whatsapp') {
            return reply.status(404).send({ error: 'Canal WhatsApp não encontrado.' })
        }

        const isMember = await prisma.member.findFirst({
            where: { organizationId: channel.organizationId, userId },
        })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const cfg = channel.config as WaConfig

        // Busca contatos na Evolution API
        const result = await evolutionFetch(
            cfg,
            `/chat/findContacts/${cfg.instanceName}`,
            { method: 'POST', body: JSON.stringify({ where: {} }) }
        )

        if (!result.ok) {
            return reply.status(502).send({
                error: 'Não foi possível obter contatos da Evolution API.',
                detail: result.data,
            })
        }

        type WaContact = {
            id?: string
            remoteJid?: string
            pushName?: string
            name?: string
            number?: string
            profilePictureUrl?: string
            isGroup?: boolean
        }

        // A Evolution API pode retornar array direto ou { contacts: [...] }
        const rawList: unknown = Array.isArray(result.data)
            ? result.data
            : (result.data as Record<string, unknown>)?.contacts ?? []

        if (!Array.isArray(rawList)) {
            return reply.status(502).send({
                error: 'Formato de resposta inesperado da Evolution API.',
                detail: result.data,
            })
        }

        // Filtra apenas contatos individuais com número de telefone real
        // - Aceita apenas @s.whatsapp.net e @c.us (têm número direto)
        // - Descarta @g.us (grupos) e @lid (IDs internos criptografados)
        const waContacts = (rawList as WaContact[]).filter((c) => {
            const jid = c.remoteJid
            if (!jid) return false
            if (c.isGroup) return false
            if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) return false
            return true
        })

        let synced = 0
        let updated = 0

        for (const c of waContacts) {
            const jid = c.remoteJid!
            const externalId = jid

            // Extrai número apenas de JIDs com sufixo @s.whatsapp.net ou @c.us
            // JIDs @lid são IDs internos do WhatsApp e não correspondem ao número direto
            let phone: string | undefined
            if (jid.includes('@s.whatsapp.net') || jid.includes('@c.us')) {
                const rawNumber = c.number || jid.split('@')[0] || ''
                if (rawNumber) phone = `+${rawNumber}`
            }

            const contactName = c.name || c.pushName || phone || 'Desconhecido'
            // Evolution API v2 usa profilePicUrl (não profilePictureUrl)
            const avatarUrl = (c as Record<string, unknown>).profilePicUrl as string | undefined

            const existing = await prisma.contact.findFirst({
                where: { organizationId: channel.organizationId, externalId },
            })

            if (existing) {
                await prisma.contact.update({
                    where: { id: existing.id },
                    data: { name: contactName, phone, avatarUrl, channelId },
                })
                updated++
            } else {
                await prisma.contact.create({
                    data: {
                        organizationId: channel.organizationId,
                        name: contactName,
                        phone,
                        avatarUrl,
                        channelId,
                        externalId,
                    },
                })
                synced++
            }
        }

        return {
            synced,
            updated,
            total: synced + updated,
            _debug: {
                rawTotal: rawList.length,
                filteredTotal: waContacts.length,
            },
        }
    })

    // POST /contacts — cria contato manual
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Cria um novo contato',
            body: {
                type: 'object',
                required: ['name'],
                properties: {
                    name:       { type: 'string', minLength: 1 },
                    phone:      { type: 'string' },
                    email:      { type: 'string' },
                    avatarUrl:  { type: 'string' },
                    channelId:  { type: 'string' },
                    externalId: { type: 'string' },
                    notes:      { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as {
            name: string
            phone?: string
            email?: string
            avatarUrl?: string
            channelId?: string
            externalId?: string
            notes?: string
        }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const contact = await prisma.contact.create({
            data: {
                organizationId: orgId,
                name:       body.name,
                phone:      body.phone,
                email:      body.email,
                avatarUrl:  body.avatarUrl,
                channelId:  body.channelId,
                externalId: body.externalId,
                notes:      body.notes,
            },
        })

        return reply.status(201).send(contact)
    })

    // PATCH /contacts/:id — atualiza contato
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Atualiza um contato',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:      { type: 'string', minLength: 1 },
                    phone:     { type: 'string' },
                    email:     { type: 'string' },
                    avatarUrl: { type: 'string' },
                    notes:     { type: 'string' },
                    channelId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const body = request.body as {
            name?: string
            phone?: string
            email?: string
            avatarUrl?: string
            notes?: string
            channelId?: string
        }
        const userId = request.session.user.id

        const contact = await prisma.contact.findUnique({ where: { id } })
        if (!contact) return reply.status(404).send({ error: 'Contato não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: contact.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const updated = await prisma.contact.update({
            where: { id },
            data: {
                ...(body.name      !== undefined && { name:      body.name }),
                ...(body.phone     !== undefined && { phone:     body.phone }),
                ...(body.email     !== undefined && { email:     body.email }),
                ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
                ...(body.notes     !== undefined && { notes:     body.notes }),
                ...(body.channelId !== undefined && { channelId: body.channelId }),
            },
        })

        return updated
    })

    // PATCH /contacts/:id/assign — atribui ou desatribui agente à conversa
    app.patch('/:id/assign', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Atribui agente a uma conversa',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    assignedToId: { type: 'string', nullable: true },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { assignedToId } = request.body as { assignedToId: string | null }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const contact = await prisma.contact.update({
            where: { id },
            data: { assignedToId: assignedToId ?? null },
            select: {
                id: true, convStatus: true, assignedToId: true,
                assignedTo: { select: { id: true, name: true, image: true } },
            },
        })

        publishToOrg(orgId, {
            type: 'conv_updated',
            contactId: id,
            convStatus: contact.convStatus,
            assignedToId: contact.assignedToId,
            assignedToName: contact.assignedTo?.name ?? null,
        })

        return contact
    })

    // PATCH /contacts/:id/resolve — marca conversa como resolvida e limpa atribuição
    app.patch('/:id/resolve', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Resolve uma conversa (libera agente)',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const contact = await prisma.contact.update({
            where: { id },
            data: { convStatus: 'resolved', assignedToId: null },
            select: { id: true, convStatus: true, assignedToId: true },
        })

        publishToOrg(orgId, {
            type: 'conv_updated',
            contactId: id,
            convStatus: 'resolved',
            assignedToId: null,
            assignedToName: null,
        })

        return contact
    })

    // PATCH /contacts/:id/open — marca conversa como aberta (agente abriu a conversa)
    app.patch('/:id/open', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Marca conversa como aberta/em andamento',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        // ─── MULTI-TENANT: Usa organizationId detectado automaticamente pelo requireAuth ───
        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const contact = await prisma.contact.update({
            where: { id },
            data: { convStatus: 'open' },
            select: { id: true, convStatus: true, assignedToId: true },
        })

        publishToOrg(orgId, {
            type: 'conv_updated',
            contactId: id,
            convStatus: 'open',
            assignedToId: contact.assignedToId,
            assignedToName: null,
        })

        return contact
    })

    // DELETE /contacts/:id
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Remove um contato',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const contact = await prisma.contact.findUnique({ where: { id } })
        if (!contact) return reply.status(404).send({ error: 'Contato não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: contact.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.contact.delete({ where: { id } })
        return reply.status(204).send()
    })
}
