import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { publishToOrg } from '../../lib/agentSse.js'
import { processAutoAssignment } from '../../lib/assignmentEngine.js'
import { syncQueue } from '../../lib/queue.js'

import { type UazapiConfig, uazapiFetch } from '../../lib/uazapi.js'

export default async function (app: FastifyInstance) {

    // GET /contacts/no-channel — lista contatos sem canal (apenas admin/owner)
    app.get('/no-channel', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Lista contatos sem canal (apenas admin/owner)',
            querystring: {
                type: 'object',
                properties: {
                    search: { type: 'string' },
                    page:   { type: 'integer', minimum: 1, default: 1 },
                    limit:  { type: 'integer', minimum: 1, maximum: 500, default: 30 },
                },
            },
        },
    }, async (request, reply) => {
        const { search, page = 1, limit = 30 } = request.query as {
            search?: string
            page?: number
            limit?: number
        }
        const userId = request.session.user.id

        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // ─── APENAS ADMIN/OWNER podem ver contatos sem canal ───
        const isAdminOrOwner = isMember.role === 'admin' || isMember.role === 'owner'
        if (!isAdminOrOwner) {
            return reply.status(403).send({ error: 'Apenas administradores podem acessar contatos sem canal.' })
        }

        const where = {
            organizationId: orgId,
            channelId: null,  // Apenas contatos SEM canal
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

    // GET /contacts?search=&page=&limit=&teamId=&mine=
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Lista contatos da organização',
            querystring: {
                type: 'object',
                properties: {
                    search:             { type: 'string' },
                    tagId:              { type: 'string' },
                    teamId:             { type: 'string' },
                    mine:               { type: 'boolean' },
                    hasMessages:        { type: 'boolean' },
                    assignedToUserId:   { type: 'string' },
                    dateFrom:           { type: 'string' },
                    dateTo:             { type: 'string' },
                    page:               { type: 'integer', minimum: 1, default: 1 },
                    limit:              { type: 'integer', minimum: 1, maximum: 500, default: 30 },
                },
            },
        },
    }, async (request, reply) => {
        const { search, tagId, teamId, mine, hasMessages, assignedToUserId, dateFrom, dateTo, page = 1, limit = 30 } = request.query as {
            search?: string
            tagId?: string
            teamId?: string
            mine?: boolean
            hasMessages?: boolean
            assignedToUserId?: string
            dateFrom?: string
            dateTo?: string
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

        // ─── PERMISSÃO POR ROLE: Membros normais só veem contatos atribuídos a eles ou não atribuídos ───
        const isAdminOrOwner = isMember.role === 'admin' || isMember.role === 'owner'

        const where = {
            organizationId: orgId,
            // Se não é admin/owner, filtra apenas contatos atribuídos ao usuário ou não atribuídos
            ...(!isAdminOrOwner ? {
                OR: [
                    { assignedToId: userId },
                    { assignedToId: null },
                ],
            } : {}),
            // Se não é admin/owner, ESCONDE contatos sem canal (channelId null)
            ...(!isAdminOrOwner ? {
                channelId: { not: null },
            } : {}),
            // Filtro "mine": apenas atribuídos ao usuário logado
            ...(mine ? { assignedToId: userId } : {}),
            // Filtro por usuário específico atribuído
            ...(assignedToUserId ? { assignedToId: assignedToUserId } : {}),
            // Filtro por time
            ...(teamId ? { teamId } : {}),
            // lastMessageAt IS NOT NULL é equivalente a "tem mensagens" e usa o index diretamente
            ...(hasMessages ? { lastMessageAt: { not: null } } : {}),
            ...(tagId ? { tags: { some: { tagId } } } : {}),
            ...(dateFrom || dateTo ? {
                updatedAt: {
                    ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                    ...(dateTo ? { lte: new Date(dateTo) } : {}),
                },
            } : {}),
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
                orderBy: [
                    { lastMessageAt: { sort: 'desc', nulls: 'last' } },
                    { createdAt: 'desc' },
                ],
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
                    teamId: true,
                    createdAt: true,
                    updatedAt: true,
                    lastMessageAt: true,
                    lastMessageDirection: true,
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
                    team: {
                        select: { id: true, name: true, color: true },
                    },
                },
            }),
        ])

        const contactIds = contacts.map((c: { id: string }) => c.id)

        const [readStatuses, unreadCountsRaw] = contactIds.length > 0
            ? await Promise.all([
                prisma.contactReadStatus.findMany({
                    where: { userId, contactId: { in: contactIds } },
                    select: { contactId: true, lastReadAt: true, markedUnreadAt: true },
                }),
                prisma.$queryRawUnsafe<Array<{ contactId: string; count: bigint }>>(
                    `SELECT m."contactId", COUNT(*)::bigint as count
                     FROM messages m
                     LEFT JOIN contact_read_statuses crs
                       ON crs."contactId" = m."contactId" AND crs."userId" = $2
                     WHERE m."contactId" = ANY($1)
                       AND m.direction = 'inbound'
                       AND (
                         crs."contactId" IS NULL
                         OR m."createdAt" > crs."lastReadAt"
                       )
                     GROUP BY m."contactId"`,
                    contactIds,
                    userId,
                ),
            ])
            : [[], []]

        const readMap = new Map(readStatuses.map((rs) => [rs.contactId, rs]))
        const unreadCountMap = new Map(unreadCountsRaw.map((r) => [r.contactId, Number(r.count)]))

        const enrichedContacts = contacts.map((c: { id: string }) => {
            const rs = readMap.get(c.id)
            const count = unreadCountMap.get(c.id) ?? 0
            const isUnread = (rs?.markedUnreadAt != null) || count > 0
            const unreadCount = rs?.markedUnreadAt ? Math.max(count, 1) : count
            return { ...c, isUnread, unreadCount }
        })

        return { total, page, limit, contacts: enrichedContacts }
    })

    // GET /contacts/unread-count
    app.get('/unread-count', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Total de conversas nao lidas',
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organizacao detectada.' })
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissao.' })

        const isAdminOrOwner = isMember.role === 'admin' || isMember.role === 'owner'

        const permissionFilter = isAdminOrOwner
            ? ''
            : `AND (c."assignedToId" = $2 OR c."assignedToId" IS NULL)`

        const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT COUNT(DISTINCT c.id)::bigint as count
             FROM contacts c
             WHERE c."organizationId" = $1
               AND c."channelId" IS NOT NULL
               ${permissionFilter}
               AND (
                 EXISTS (
                   SELECT 1 FROM contact_read_statuses crs
                   WHERE crs."contactId" = c.id AND crs."userId" = $2 AND crs."markedUnreadAt" IS NOT NULL
                 )
                 OR
                 EXISTS (
                   SELECT 1 FROM messages m
                   WHERE m."contactId" = c.id AND m.direction = 'inbound'
                   AND (
                     NOT EXISTS (
                       SELECT 1 FROM contact_read_statuses crs2
                       WHERE crs2."contactId" = c.id AND crs2."userId" = $2
                     )
                     OR m."createdAt" > (
                       SELECT crs3."lastReadAt" FROM contact_read_statuses crs3
                       WHERE crs3."contactId" = c.id AND crs3."userId" = $2
                     )
                   )
                 )
               )`,
            orgId,
            userId,
        )

        return { count: Number(result[0]?.count ?? 0) }
    })

    // GET /contacts/:id — retorna um contato pelo ID
    app.get('/:id', {
        preHandler: requireAuth,
        schema: {
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id
        const orgId  = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organização detectada para este domínio.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const contact = await prisma.contact.findUnique({
            where: { id },
            select: {
                id: true, name: true, phone: true, email: true, avatarUrl: true,
                channelId: true, externalId: true, notes: true,
                convStatus: true, assignedToId: true, teamId: true, createdAt: true,
                channel:    { select: { id: true, name: true, type: true, status: true } },
                tags:       { select: { tag: { select: { id: true, name: true, color: true } } } },
                assignedTo: { select: { id: true, name: true, image: true } },
                team:       { select: { id: true, name: true, color: true } },
            },
        })
        if (!contact) return reply.status(404).send({ error: 'Contato não encontrado.' })
        if (contact.channelId) {
            const ch = await prisma.channel.findUnique({ where: { id: contact.channelId }, select: { organizationId: true } })
            if (ch && ch.organizationId !== orgId) return reply.status(403).send({ error: 'Sem permissão.' })
        }
        return contact
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

        const cfg = channel.config as UazapiConfig
        if (!cfg.uazapiInstanceToken) {
            return reply.status(400).send({ error: 'Canal sem token de instância UAZAPI.' })
        }

        // Busca chats no UAZAPI (não há endpoint de contatos separado)
        const result = await uazapiFetch(cfg.uazapiUrl, '/chat/find', { instanceToken: cfg.uazapiInstanceToken }, {
            method: 'POST',
            body: JSON.stringify({ wa_isGroup: false }),
        })

        if (!result.ok) {
            return reply.status(502).send({
                error: 'Não foi possível obter contatos do UAZAPI.',
                detail: result.data,
            })
        }

        type UazapiChat = {
            wa_chatid?: string
            phone?: string
            name?: string
            wa_name?: string
            wa_contactName?: string
            image?: string
            wa_isGroup?: boolean
        }

        const rawList: unknown = Array.isArray(result.data)
            ? result.data
            : Array.isArray(result.data?.chats) ? result.data.chats : []

        if (!Array.isArray(rawList)) {
            return reply.status(502).send({
                error: 'Formato de resposta inesperado do UAZAPI.',
                detail: result.data,
            })
        }

        // Filtra apenas chats individuais
        const waChats = (rawList as UazapiChat[]).filter((c) => {
            const jid = c.wa_chatid ?? ''
            if (c.wa_isGroup) return false
            if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) return false
            return true
        })

        let synced = 0
        let updated = 0

        for (const c of waChats) {
            const jid = c.wa_chatid!
            const externalId = jid
            const rawNumber = c.phone || jid.split('@')[0] || ''
            const phone = rawNumber ? `+${rawNumber}` : undefined
            const contactName = c.wa_name || c.wa_contactName || c.name || phone || 'Desconhecido'
            const avatarUrl = c.image || undefined

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
                rawTotal: (rawList as unknown[]).length,
                filteredTotal: waChats.length,
            },
        }
    })

    // POST /contacts/:id/sync-messages — enfileira sincronização de mensagens de um contato
    app.post('/:id/sync-messages', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Enfileira importação de histórico de mensagens de um contato via Evolution API',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const contact = await prisma.contact.findUnique({ where: { id }, include: { channel: true } })
        if (!contact) return reply.status(404).send({ error: 'Contato não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: contact.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        if (!contact.channelId || !contact.channel) return reply.status(400).send({ error: 'Contato não possui canal WhatsApp vinculado.' })
        if (contact.channel.type !== 'whatsapp') return reply.status(400).send({ error: 'Sincronização disponível apenas para canais WhatsApp.' })
        if (!contact.externalId) return reply.status(400).send({ error: 'Contato não possui JID para sincronizar.' })

        const job = await syncQueue.add('sync-contact', { contactId: contact.id, orgId: contact.organizationId })
        return { jobId: job.id, queued: true }
    })

    // POST /contacts/unify — unifica contatos duplicados pelo telefone
    // O contato com channelId é o master; os sem canal são absorvidos
    app.post('/unify', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Unifica contatos duplicados pelo número de telefone',
        },
    }, async (request, reply) => {
        const userId = request.session.user.id

        const orgId = request.organizationId
        if (!orgId) {
            return reply.status(400).send({ error: 'Nenhuma organização detectada.' })
        }

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // Busca todos os contatos com telefone preenchido
        const allContacts = await prisma.contact.findMany({
            where: { organizationId: orgId, phone: { not: null } },
            orderBy: { createdAt: 'asc' },
        })

        // Normaliza telefone: remove espaços, traços, parênteses
        function normalizePhone(phone: string) {
            return phone.replace(/[\s\-().+]/g, '').replace(/^0+/, '')
        }

        // Agrupa por telefone normalizado
        const groups = new Map<string, typeof allContacts>()
        for (const contact of allContacts) {
            const key = normalizePhone(contact.phone!)
            if (!key) continue
            const group = groups.get(key) ?? []
            group.push(contact)
            groups.set(key, group)
        }

        let mergedGroups = 0
        let removedContacts = 0

        for (const [, group] of groups) {
            if (group.length < 2) continue

            // Master = contato com channelId (mais antigo com canal)
            // Se nenhum do grupo tem canal, pula — só unifica quando há um com channelId
            const master = group.find((c) => c.channelId)
            if (!master) continue

            const duplicates = group.filter((c) => c.id !== master.id)

            // Mescla campos: preenche no master o que estiver vazio
            const updateData: Record<string, unknown> = {}
            for (const dup of duplicates) {
                if (!master.email && dup.email)       updateData.email     = dup.email
                if (!master.avatarUrl && dup.avatarUrl) updateData.avatarUrl = dup.avatarUrl
                if (!master.notes && dup.notes)       updateData.notes     = dup.notes
                else if (master.notes && dup.notes && master.notes !== dup.notes) {
                    updateData.notes = `${master.notes}\n---\n${dup.notes}`
                }
                if (!master.channelId && dup.channelId)     updateData.channelId  = dup.channelId
                if (!master.externalId && dup.externalId)   updateData.externalId = dup.externalId
                if (!master.assignedToId && dup.assignedToId) updateData.assignedToId = dup.assignedToId
            }

            if (Object.keys(updateData).length > 0) {
                await prisma.contact.update({ where: { id: master.id }, data: updateData })
            }

            for (const dup of duplicates) {
                // Migra mensagens
                await prisma.message.updateMany({
                    where: { contactId: dup.id },
                    data:  { contactId: master.id },
                })

                // Migra tags (evita duplicatas via upsert)
                const dupTags = await prisma.contactTag.findMany({ where: { contactId: dup.id } })
                for (const tag of dupTags) {
                    await prisma.contactTag.upsert({
                        where:  { contactId_tagId: { contactId: master.id, tagId: tag.tagId } },
                        update: {},
                        create: { contactId: master.id, tagId: tag.tagId },
                    })
                }

                // Migra campaign leads
                await prisma.campaignLead.updateMany({
                    where: { contactId: dup.id },
                    data:  { contactId: master.id },
                })

                // Remove o duplicado
                await prisma.contact.delete({ where: { id: dup.id } })
                removedContacts++
            }

            mergedGroups++
        }

        return { mergedGroups, removedContacts }
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

        const normalizedPhone = body.phone?.replace(/[\s\-\(\)\.]/g, '') || undefined

        if (normalizedPhone) {
            const existing = await prisma.contact.findFirst({
                where: { organizationId: orgId, phone: normalizedPhone },
            })
            if (existing) return reply.status(409).send({ error: 'Já existe um contato com este telefone.' })
        }

        const contact = await prisma.contact.create({
            data: {
                organizationId: orgId,
                name:       body.name,
                phone:      normalizedPhone,
                email:      body.email,
                avatarUrl:  body.avatarUrl,
                channelId:  body.channelId,
                externalId: body.externalId,
                notes:      body.notes,
            },
        })

        // Process auto-assignment if enabled
        processAutoAssignment(contact.id, orgId).catch(err => {
            console.error('Auto-assignment error:', err)
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
                    name:         { type: 'string', minLength: 1 },
                    phone:        { type: 'string' },
                    email:        { type: 'string' },
                    avatarUrl:    { type: 'string' },
                    notes:        { type: 'string' },
                    channelId:    { type: 'string' },
                    assignedToId: { type: 'string', nullable: true },
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
            assignedToId?: string | null
        }
        const userId = request.session.user.id

        const contact = await prisma.contact.findUnique({ where: { id } })
        if (!contact) return reply.status(404).send({ error: 'Contato não encontrado.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: contact.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const updated = await prisma.contact.update({
            where: { id },
            data: {
                ...(body.name         !== undefined && { name:         body.name }),
                ...(body.phone        !== undefined && { phone:        body.phone }),
                ...(body.email        !== undefined && { email:        body.email }),
                ...(body.avatarUrl    !== undefined && { avatarUrl:    body.avatarUrl }),
                ...(body.notes        !== undefined && { notes:        body.notes }),
                ...(body.channelId    !== undefined && { channelId:    body.channelId }),
                ...(body.assignedToId !== undefined && { assignedToId: body.assignedToId ?? null }),
            },
            include: {
                assignedTo: { select: { name: true, image: true } },
            },
        })

        if (body.assignedToId !== undefined) {
            publishToOrg(contact.organizationId, {
                type: 'conv_updated',
                contactId: id,
                convStatus: updated.convStatus,
                assignedToId: updated.assignedToId,
                assignedToName: updated.assignedTo?.name ?? null,
                assignedToImage: updated.assignedTo?.image ?? null,
            })
        }

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

        // Apenas admin/owner ou membros com canAssign podem atribuir conversas
        const canAssignPerms = isMember.role === 'admin' || isMember.role === 'owner' || isMember.canAssign
        if (!canAssignPerms) return reply.status(403).send({ error: 'Sem permissão para atribuir conversas.' })

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
            assignedToImage: contact.assignedTo?.image ?? null,
        })

        return contact
    })

    // PATCH /contacts/:id/assign-team — atribui ou desatribui time à conversa
    app.patch('/:id/assign-team', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Atribui time a uma conversa',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    teamId: { type: 'string', nullable: true },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { teamId } = request.body as { teamId: string | null }
        const userId = request.session.user.id

        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organização detectada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const canAssignPerms = isMember.role === 'admin' || isMember.role === 'owner' || isMember.canAssign
        if (!canAssignPerms) return reply.status(403).send({ error: 'Sem permissão para atribuir conversas.' })

        const contact = await prisma.contact.update({
            where: { id },
            data: { teamId: teamId ?? null },
            select: {
                id: true, convStatus: true, assignedToId: true, teamId: true,
                assignedTo: { select: { id: true, name: true, image: true } },
                team: { select: { id: true, name: true, color: true } },
            },
        })

        publishToOrg(orgId, {
            type: 'conv_updated',
            contactId: id,
            convStatus: contact.convStatus,
            assignedToId: contact.assignedToId,
            assignedToName: contact.assignedTo?.name ?? null,
            assignedToImage: contact.assignedTo?.image ?? null,
            teamId: contact.teamId,
            teamName: contact.team?.name ?? null,
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

    // POST /contacts/:id/read — marca conversa como lida
    app.post('/:id/read', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Marca conversa como lida',
            params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organizacao detectada.' })
        const { id: contactId } = request.params as { id: string }
        const userId = request.session.user.id

        await prisma.contactReadStatus.upsert({
            where: { contactId_userId: { contactId, userId } },
            create: { contactId, userId, organizationId: orgId, lastReadAt: new Date(), markedUnreadAt: null },
            update: { lastReadAt: new Date(), markedUnreadAt: null },
        })

        publishToOrg(orgId, {
            type: 'conv_read_status',
            contactId,
            userId,
            isUnread: false,
        })

        return { success: true }
    })

    // POST /contacts/:id/unread — marca conversa como nao lida
    app.post('/:id/unread', {
        preHandler: requireAuth,
        schema: {
            tags: ['Contacts'],
            summary: 'Marca conversa como nao lida',
            params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
    }, async (request, reply) => {
        const orgId = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Nenhuma organizacao detectada.' })
        const { id: contactId } = request.params as { id: string }
        const userId = request.session.user.id

        await prisma.contactReadStatus.upsert({
            where: { contactId_userId: { contactId, userId } },
            create: { contactId, userId, organizationId: orgId, markedUnreadAt: new Date() },
            update: { markedUnreadAt: new Date() },
        })

        publishToOrg(orgId, {
            type: 'conv_read_status',
            contactId,
            userId,
            isUnread: true,
        })

        return { success: true }
    })
}
