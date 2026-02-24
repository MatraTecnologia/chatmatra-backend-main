// ─── Sync Worker ──────────────────────────────────────────────────────────────
// Processa jobs de sincronização de histórico da Evolution API.
// Dois tipos: sync-all-history (todos os canais da org) e sync-contact (contato específico).

import { Worker } from 'bullmq'
import { redisConnection, type SyncAllHistoryJobData, type SyncContactJobData } from '../queue.js'
import { prisma } from '../prisma.js'

type WhatsAppConfig = { evolutionUrl: string; evolutionApiKey: string; instanceName: string }

type WaMessage = {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string }
    message?: {
        conversation?: string
        extendedTextMessage?: { text?: string }
        imageMessage?: { caption?: string }
        videoMessage?: { caption?: string }
        documentMessage?: { title?: string; caption?: string; fileName?: string }
        audioMessage?: Record<string, unknown>
        stickerMessage?: Record<string, unknown>
    }
    messageType?: string
    pushName?: string
    messageTimestamp?: number
}

async function evolutionFetch(cfg: Pick<WhatsAppConfig, 'evolutionUrl' | 'evolutionApiKey'>, path: string, options: RequestInit = {}) {
    const url = `${cfg.evolutionUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'apikey': cfg.evolutionApiKey, ...options.headers },
    })
    const text = await res.text()
    try { return { ok: res.ok, data: JSON.parse(text) } } catch { return { ok: res.ok, data: text } }
}

function parseMsgs(raw: unknown): WaMessage[] {
    if (Array.isArray(raw)) return raw as WaMessage[]
    const m = (raw as { messages?: unknown }).messages
    if (Array.isArray(m)) return m as WaMessage[]
    if (m && Array.isArray((m as { records?: unknown }).records)) return (m as { records: WaMessage[] }).records
    if (Array.isArray((raw as { records?: unknown }).records)) return (raw as { records: WaMessage[] }).records
    return []
}

async function importMessages(msgs: WaMessage[], contact: { id: string }, channelId: string, organizationId: string) {
    type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
    let imported = 0
    for (const msg of msgs) {
        if (!msg.key?.id) continue
        const fromMe = msg.key.fromMe ?? false
        let msgType: MsgType = 'text'
        let content = ''
        if (msg.message?.conversation)                   { content = msg.message.conversation;                    msgType = 'text' }
        else if (msg.message?.extendedTextMessage?.text) { content = msg.message.extendedTextMessage.text;         msgType = 'text' }
        else if (msg.message?.imageMessage != null)      { content = msg.message.imageMessage?.caption ?? '';      msgType = 'image' }
        else if (msg.message?.videoMessage != null)      { content = msg.message.videoMessage?.caption ?? '';      msgType = 'video' }
        else if (msg.message?.audioMessage != null)      { content = '';                                           msgType = 'audio' }
        else if (msg.message?.documentMessage != null)   { content = msg.message.documentMessage?.caption ?? '';   msgType = 'document' }
        else if (msg.message?.stickerMessage != null)    { content = '';                                           msgType = 'sticker' }
        const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)
        if (!content && !isMedia) continue
        const createdAt = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
        const existing = await prisma.message.findFirst({ where: { organizationId, externalId: msg.key.id } })
        if (!existing) {
            await prisma.message.create({
                data: { organizationId, contactId: contact.id, channelId, direction: fromMe ? 'outbound' : 'inbound', type: msgType, content, status: 'sent', externalId: msg.key.id, createdAt },
            })
            imported++
        }
    }
    return imported
}

export function startSyncWorker() {
    const worker = new Worker<SyncAllHistoryJobData | SyncContactJobData>(
        'sync-history',
        async (job) => {
            const data = job.data as Record<string, string>

            // ── sync-contact: sincroniza mensagens de um contato específico ──
            if ('contactId' in data) {
                const { contactId, orgId } = data as SyncContactJobData

                const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { channel: true } })
                if (!contact?.channel || contact.channel.type !== 'whatsapp') return { imported: 0 }

                const cfg = contact.channel.config as WhatsAppConfig
                const msgsResult = await evolutionFetch(cfg, `/chat/findMessages/${cfg.instanceName}`, {
                    method: 'POST',
                    body: JSON.stringify({ where: { key: { remoteJid: contact.externalId } } }),
                })
                if (!msgsResult.ok) throw new Error('Erro ao buscar mensagens da Evolution API')

                const msgs = parseMsgs(msgsResult.data)
                const imported = await importMessages(msgs, contact, contact.channelId!, orgId)
                await job.updateProgress(100)
                return { imported, total: msgs.length }
            }

            // ── sync-all-history: sincroniza todos os canais da org ──
            const { orgId } = data as SyncAllHistoryJobData

            const channels = await prisma.channel.findMany({
                where: { organizationId: orgId, type: 'whatsapp', status: 'connected' },
            })

            let totalMessages = 0
            let totalContacts = 0
            let totalChats = 0

            for (let ci = 0; ci < channels.length; ci++) {
                const channel = channels[ci]
                const cfg = channel.config as WhatsAppConfig

                const chatsResult = await evolutionFetch(cfg, `/chat/findChats/${cfg.instanceName}`, {
                    method: 'POST', body: JSON.stringify({}),
                })
                if (!chatsResult.ok) continue

                type WaChat = { remoteJid?: string; id?: { remote?: string } }
                const chats: WaChat[] = Array.isArray(chatsResult.data) ? chatsResult.data : []
                const individualChats = chats.filter((c) => {
                    const jid = c.remoteJid ?? c.id?.remote ?? ''
                    return jid.includes('@s.whatsapp.net') || jid.includes('@c.us')
                })

                for (let ji = 0; ji < individualChats.length; ji++) {
                    const chat = individualChats[ji]
                    const jid = chat.remoteJid ?? chat.id?.remote ?? ''

                    const msgsResult = await evolutionFetch(cfg, `/chat/findMessages/${cfg.instanceName}`, {
                        method: 'POST',
                        body: JSON.stringify({ where: { key: { remoteJid: jid } } }),
                    })
                    if (!msgsResult.ok) continue

                    const msgs = parseMsgs(msgsResult.data)
                    if (msgs.length === 0) continue
                    totalChats++

                    let contact = await prisma.contact.findFirst({ where: { organizationId: orgId, externalId: jid } })
                    if (!contact) {
                        const rawNumber = jid.split('@')[0]
                        const firstName = msgs.find((m) => !m.key?.fromMe && m.pushName)?.pushName
                        contact = await prisma.contact.create({
                            data: { organizationId: orgId, channelId: channel.id, externalId: jid, phone: rawNumber ? `+${rawNumber}` : undefined, name: firstName || rawNumber || 'Desconhecido' },
                        })
                        totalContacts++
                    }

                    totalMessages += await importMessages(msgs, contact, channel.id, orgId)

                    // Atualiza progresso: % dos chats processados no canal atual
                    const progress = Math.round(((ci * individualChats.length + ji + 1) / (channels.length * individualChats.length)) * 100)
                    await job.updateProgress(Math.min(progress, 99))
                }
            }

            await job.updateProgress(100)
            return { channelsSynced: channels.length, chatsProcessed: totalChats, contactsCreated: totalContacts, messagesImported: totalMessages }
        },
        {
            connection: redisConnection,
            concurrency: 2,   // sync é pesado — limitamos para não sobrecarregar o banco
        }
    )

    worker.on('failed', (job, err) => {
        console.error(`[SyncWorker] Job ${job?.id} (${job?.name}) falhou:`, err.message)
    })

    console.log('⚙️  SyncWorker iniciado (concurrency=2)')
    return worker
}
