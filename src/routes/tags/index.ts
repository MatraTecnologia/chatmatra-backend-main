import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { log } from '../../lib/logger.js'

// ── Sincroniza etiqueta no WhatsApp via Evolution API ────────────────────────
// Chamado em background ao atribuir / remover tag de um contato.
// Não bloqueia o fluxo principal: erros são logados mas não propagados.
async function syncWaLabel(contactId: string, tagId: string, action: 'add' | 'remove') {
    log.tag(`syncWaLabel ➜ action=${action} contactId=${contactId} tagId=${tagId}`)

    // ── 1. Carrega contato + tag ──────────────────────────────────────────────
    const [contact, tag] = await Promise.all([
        prisma.contact.findUnique({
            where: { id: contactId },
            select: { externalId: true, channelId: true, name: true },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (prisma as any).tag.findUnique({
            where: { id: tagId },
            select: { name: true },
        }),
    ])

    if (!contact) {
        log.warn(`syncWaLabel: contato não encontrado (${contactId})`)
        return
    }
    if (!contact.externalId || !contact.channelId) {
        log.warn(`syncWaLabel: contato "${contact.name}" não tem JID ou canal — pulando`)
        return
    }
    if (!contact.externalId.includes('@s.whatsapp.net') && !contact.externalId.includes('@c.us')) {
        log.warn(`syncWaLabel: JID "${contact.externalId}" não é WA individual — pulando`)
        return
    }
    if (!tag) {
        log.warn(`syncWaLabel: tag não encontrada (${tagId})`)
        return
    }

    log.tag(`syncWaLabel: contato="${contact.name}" (${contact.externalId})  tag="${tag.name}"`)

    // ── 2. Carrega canal ──────────────────────────────────────────────────────
    const channel = await prisma.channel.findUnique({ where: { id: contact.channelId } })
    if (!channel || channel.type !== 'whatsapp') {
        log.warn(`syncWaLabel: canal não é WhatsApp ou não encontrado`)
        return
    }
    if (channel.status !== 'connected') {
        log.warn(`syncWaLabel: canal "${channel.name}" não está conectado (status=${channel.status})`)
        return
    }

    const cfg = channel.config as { evolutionUrl?: string; evolutionApiKey?: string; instanceName?: string }
    if (!cfg.evolutionUrl || !cfg.instanceName) {
        log.warn(`syncWaLabel: canal sem evolutionUrl ou instanceName`)
        return
    }

    const baseUrl = cfg.evolutionUrl.replace(/\/$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.evolutionApiKey) headers['apikey'] = cfg.evolutionApiKey

    // ── 3. Descobre o labelId na Evolution API ────────────────────────────────
    log.wa(`syncWaLabel: buscando labels em ${baseUrl}/label/findLabels/${cfg.instanceName}`)

    const labelsRes = await fetch(`${baseUrl}/label/findLabels/${cfg.instanceName}`, { headers }).catch((err) => {
        log.error(`syncWaLabel: falha ao buscar labels —`, err)
        return null
    })
    if (!labelsRes?.ok) {
        log.error(`syncWaLabel: findLabels retornou status ${labelsRes?.status}`)
        return
    }

    type WaLabel = { id?: string; name?: string; color?: number }
    const labels: WaLabel[] = await labelsRes.json().catch(() => [])
    log.wa(`syncWaLabel: ${labels.length} label(s) encontrada(s) no WA:`, labels.map((l) => `"${l.name}"(${l.id})`).join(', '))

    const match = labels.find((l) => (l.name ?? '').toLowerCase() === (tag.name ?? '').toLowerCase())
    if (!match?.id) {
        log.warn(`syncWaLabel: label "${tag.name}" não encontrada no WhatsApp — crie a etiqueta lá primeiro`)
        return
    }

    const labelId = match.id
    log.wa(`syncWaLabel: label encontrada id="${labelId}" — enviando ${action.toUpperCase()} para WA`)

    // ── 4. Aplica a etiqueta no chat via Evolution API ────────────────────────
    // Evolution API espera apenas o número, sem o sufixo @s.whatsapp.net
    const cleanNumber = contact.externalId.includes('@')
        ? contact.externalId.split('@')[0]
        : contact.externalId

    log.tag(`syncWaLabel: número limpo = "${cleanNumber}"`)

    // Formato correto: { number, labelId, action }
    const payload = { number: cleanNumber, labelId: labelId, action: action }
    const body = JSON.stringify(payload)

    log.wa(`syncWaLabel: enviando para handleLabel — body: ${body}`)

    const res = await fetch(`${baseUrl}/label/handleLabel/${cfg.instanceName}`, {
        method:  'POST',
        headers,
        body,
    }).catch((err) => {
        log.error(`syncWaLabel: erro de rede em handleLabel —`, err)
        return null
    })

    if (!res) return

    const text = await res.text().catch(() => '')
    if (res.ok) {
        log.ok(`syncWaLabel ✓ label "${tag.name}" ${action === 'add' ? 'adicionada' : 'removida'} no WA para ${contact.name} — resposta: ${text}`)
    } else {
        log.error(`syncWaLabel: handleLabel retornou ${res.status} — body: ${text}`)
    }
}

export default async function (app: FastifyInstance) {

    // GET /tags?orgId=xxx — lista tags da organização
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Lista tags da organização',
            querystring: {
                type: 'object',
                required: ['orgId'],
                properties: { orgId: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { orgId } = request.query as { orgId: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        return prisma.tag.findMany({
            where: { organizationId: orgId },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, color: true, createdAt: true },
        })
    })

    // POST /tags — cria tag
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Cria uma nova tag',
            body: {
                type: 'object',
                required: ['orgId', 'name'],
                properties: {
                    orgId: { type: 'string' },
                    name:  { type: 'string', minLength: 1 },
                    color: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { orgId, name, color } = request.body as { orgId: string; name: string; color?: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        const tag = await prisma.tag.create({
            data: {
                organizationId: orgId,
                name: name.trim(),
                color: color ?? '#6366f1',
            },
        })

        return reply.status(201).send(tag)
    })

    // PATCH /tags/:id — renomeia ou muda cor
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Atualiza uma tag',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:  { type: 'string', minLength: 1 },
                    color: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const { name, color } = request.body as { name?: string; color?: string }
        const userId = request.session.user.id

        const tag = await prisma.tag.findUnique({ where: { id } })
        if (!tag) return reply.status(404).send({ error: 'Tag não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: tag.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        return prisma.tag.update({
            where: { id },
            data: {
                ...(name  !== undefined && { name: name.trim() }),
                ...(color !== undefined && { color }),
            },
        })
    })

    // DELETE /tags/:id — apaga tag
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Remove uma tag',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const tag = await prisma.tag.findUnique({ where: { id } })
        if (!tag) return reply.status(404).send({ error: 'Tag não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: tag.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.tag.delete({ where: { id } })
        return reply.status(204).send()
    })

    // POST /tags/:id/contacts — vincula tag a um contato
    app.post('/:id/contacts', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Vincula uma tag a um contato',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['contactId'],
                properties: { contactId: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id: tagId } = request.params as { id: string }
        const { contactId } = request.body as { contactId: string }
        const userId = request.session.user.id

        const tag = await prisma.tag.findUnique({ where: { id: tagId } })
        if (!tag) return reply.status(404).send({ error: 'Tag não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: tag.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        // idempotente: upsert
        await prisma.contactTag.upsert({
            where: { contactId_tagId: { contactId, tagId } },
            create: { contactId, tagId },
            update: {},
        })

        log.tag(`Tag atribuída: tagId=${tagId} → contactId=${contactId}  (tag="${tag.name}")`)

        // Sincroniza com WhatsApp em background (erros logados dentro da função)
        syncWaLabel(contactId, tagId, 'add').catch((err) => log.error('syncWaLabel unexpect:', err))

        return reply.status(201).send({ ok: true })
    })

    // DELETE /tags/:id/contacts/:contactId — desvincula tag de contato
    app.delete('/:id/contacts/:contactId', {
        preHandler: requireAuth,
        schema: {
            tags: ['Tags'],
            summary: 'Remove vínculo de tag com contato',
            params: {
                type: 'object',
                properties: { id: { type: 'string' }, contactId: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id: tagId, contactId } = request.params as { id: string; contactId: string }
        const userId = request.session.user.id

        const tag = await prisma.tag.findUnique({ where: { id: tagId } })
        if (!tag) return reply.status(404).send({ error: 'Tag não encontrada.' })

        const isMember = await prisma.member.findFirst({ where: { organizationId: tag.organizationId, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        await prisma.contactTag.deleteMany({ where: { contactId, tagId } })

        log.tag(`Tag removida: tagId=${tagId} ← contactId=${contactId}  (tag="${tag.name}")`)

        // Sincroniza remoção com WhatsApp em background (erros logados dentro da função)
        syncWaLabel(contactId, tagId, 'remove').catch((err) => log.error('syncWaLabel unexpect:', err))

        return reply.status(204).send()
    })
}
