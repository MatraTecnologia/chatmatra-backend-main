// ─── Sync Worker ──────────────────────────────────────────────────────────────
// Processa jobs de sincronização de histórico do UAZAPI.
// Dois tipos: sync-all-history (todos os canais da org) e sync-contact (contato específico).

import { Worker } from 'bullmq'
import { redisConnection, type SyncAllHistoryJobData, type SyncContactJobData } from '../queue.js'
import { prisma } from '../prisma.js'
import { type UazapiConfig, uazapiFetch } from '../uazapi.js'

type UazapiMessage = {
    id?: string
    messageid?: string
    chatid?: string
    fromMe?: boolean
    type?: string       // "text" | "media"
    mediaType?: string  // "" | "image" | "video" | "document" | "ptt" | "vcard"
    messageType?: string
    content?: unknown
    text?: string
    senderName?: string
    messageTimestamp?: number
}

function parseMsgs(raw: unknown): UazapiMessage[] {
    if (Array.isArray(raw)) return raw as UazapiMessage[]
    const m = (raw as { messages?: unknown }).messages
    if (Array.isArray(m)) return m as UazapiMessage[]
    return []
}

async function importMessages(msgs: UazapiMessage[], contact: { id: string }, channelId: string, organizationId: string) {
    type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
    let imported = 0
    for (const msg of msgs) {
        const externalId = msg.id ?? msg.messageid
        if (!externalId) continue

        const fromMe = msg.fromMe ?? false
        let msgType: MsgType = 'text'
        let content = msg.text ?? ''

        if (msg.type === 'text') {
            msgType = 'text'
        } else if (msg.mediaType === 'image')       { msgType = 'image' }
        else if (msg.mediaType === 'video')          { msgType = 'video' }
        else if (msg.mediaType === 'ptt')            { msgType = 'audio'; content = '' }
        else if (msg.mediaType === 'document')       { msgType = 'document' }
        else if (msg.mediaType === 'vcard')          { msgType = 'text' }
        else if (msg.messageType === 'StickerMessage') { msgType = 'sticker'; content = '' }

        const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)
        if (!content && !isMedia) continue

        // UAZAPI timestamps são em milissegundos
        const createdAt = msg.messageTimestamp ? new Date(msg.messageTimestamp) : new Date()

        const existing = await prisma.message.findFirst({ where: { organizationId, externalId } })
        if (!existing) {
            await prisma.message.create({
                data: { organizationId, contactId: contact.id, channelId, direction: fromMe ? 'outbound' : 'inbound', type: msgType, content, status: 'sent', externalId, createdAt },
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

                const cfg = contact.channel.config as UazapiConfig
                if (!cfg.uazapiInstanceToken) return { imported: 0 }

                const msgsResult = await uazapiFetch(cfg.uazapiUrl, '/message/find', { instanceToken: cfg.uazapiInstanceToken }, {
                    method: 'POST',
                    body: JSON.stringify({ chatid: contact.externalId }),
                })
                if (!msgsResult.ok) throw new Error('Erro ao buscar mensagens do UAZAPI')

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
                const cfg = channel.config as UazapiConfig
                if (!cfg.uazapiInstanceToken) continue

                const chatsResult = await uazapiFetch(cfg.uazapiUrl, '/chat/find', { instanceToken: cfg.uazapiInstanceToken }, {
                    method: 'POST', body: JSON.stringify({ wa_isGroup: false }),
                })
                if (!chatsResult.ok) continue

                type UazapiChat = { wa_chatid?: string; phone?: string; name?: string }
                const chats: UazapiChat[] = Array.isArray(chatsResult.data) ? chatsResult.data
                    : Array.isArray(chatsResult.data?.chats) ? chatsResult.data.chats : []
                const individualChats = chats.filter((c) => {
                    const jid = c.wa_chatid ?? ''
                    return jid.includes('@s.whatsapp.net') || jid.includes('@c.us')
                })

                for (let ji = 0; ji < individualChats.length; ji++) {
                    const chat = individualChats[ji]
                    const jid = chat.wa_chatid ?? ''

                    const msgsResult = await uazapiFetch(cfg.uazapiUrl, '/message/find', { instanceToken: cfg.uazapiInstanceToken }, {
                        method: 'POST',
                        body: JSON.stringify({ chatid: jid }),
                    })
                    if (!msgsResult.ok) continue

                    const msgs = parseMsgs(msgsResult.data)
                    if (msgs.length === 0) continue
                    totalChats++

                    let contact = await prisma.contact.findFirst({ where: { organizationId: orgId, externalId: jid } })
                    if (!contact) {
                        const rawNumber = jid.split('@')[0]
                        const firstName = msgs.find((m) => !m.fromMe && m.senderName)?.senderName
                        contact = await prisma.contact.create({
                            data: { organizationId: orgId, channelId: channel.id, externalId: jid, phone: rawNumber ? `+${rawNumber}` : undefined, name: firstName || chat.name || rawNumber || 'Desconhecido' },
                        })
                        totalContacts++
                    }

                    totalMessages += await importMessages(msgs, contact, channel.id, orgId)

                    const progress = Math.round(((ci * individualChats.length + ji + 1) / (channels.length * individualChats.length)) * 100)
                    await job.updateProgress(Math.min(progress, 99))
                }
            }

            await job.updateProgress(100)
            return { channelsSynced: channels.length, chatsProcessed: totalChats, contactsCreated: totalContacts, messagesImported: totalMessages }
        },
        {
            connection: redisConnection,
            concurrency: 2,
        }
    )

    worker.on('failed', (job, err) => {
        console.error(`[SyncWorker] Job ${job?.id} (${job?.name}) falhou:`, err.message)
    })

    console.log('⚙️  SyncWorker iniciado (concurrency=2)')
    return worker
}
