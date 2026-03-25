// ─── Message Worker ────────────────────────────────────────────────────────────
// Processa jobs de mensagens recebidas via webhook do UAZAPI e WhatsApp Business API.

import { Worker } from 'bullmq'
import { redisConnection, type MessageJobData, type WaBusinessMessageJobData } from '../queue.js'
import { prisma } from '../prisma.js'
import { publishToOrg } from '../agentSse.js'
import { processAutoAssignment } from '../assignmentEngine.js'
import { log } from '../logger.js'

/** Salva avatar do contato a partir do chat.image do webhook UAZAPI. */
async function saveAvatarIfAvailable(contactId: string, chatImage?: string): Promise<void> {
    if (!chatImage) return
    try {
        await prisma.contact.update({ where: { id: contactId }, data: { avatarUrl: chatImage } })
    } catch {
        // silencioso — avatar é opcional
    }
}

/** Processa uma mensagem UAZAPI — chamada diretamente do webhook (sem BullMQ). */
export async function processUazapiMessage(data: MessageJobData): Promise<void> {
    const { channelId, organizationId, chatId, fromMe, messageId, type, mediaType, messageType, text, senderName, messageTimestamp, chatImage } = data

    log.info(`📨 Processando mensagem - chatId: ${chatId}, fromMe: ${fromMe}, type: ${type}, mediaType: ${mediaType}, messageId: ${messageId}`)

    // Só processa mensagens individuais (não grupos)
    if (!chatId.includes('@s.whatsapp.net') && !chatId.includes('@c.us')) {
        log.warn(`⏭️ Mensagem descartada - chatId sem @s.whatsapp.net/@c.us: ${chatId}`)
        return
    }

    // Mapeia tipo da mensagem UAZAPI → tipo interno
    type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
    let msgType: MsgType = 'text'
    let content = text ?? ''

    if (type === 'text') {
        msgType = 'text'
    } else if (mediaType === 'image')        { msgType = 'image' }
    else if (mediaType === 'video')          { msgType = 'video' }
    else if (mediaType === 'ptt')            { msgType = 'audio'; content = '' }
    else if (mediaType === 'document')       { msgType = 'document' }
    else if (mediaType === 'vcard')          { msgType = 'text' }
    else if (messageType === 'StickerMessage') { msgType = 'sticker'; content = '' }
    else if (messageType === 'LocationMessage') { content = '[Localização]' }
    else if (messageType === 'ContactMessage') { content = content || '[Contato]' }
    else if (messageType === 'ReactionMessage') { content = `[Reação: ${text ?? ''}]` }

    const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)
    if (!content && !isMedia) {
        log.warn(`⏭️ Mensagem descartada - sem conteúdo. type: ${type}, mediaType: ${mediaType}, messageType: ${messageType}`)
        return
    }

    const direction = fromMe ? 'outbound' : 'inbound'

    // Busca ou cria o contato pelo chatId
    let contact = await prisma.contact.findFirst({
        where: { organizationId, externalId: chatId, channelId },
    })

    let isNewContact = false
    if (!contact) {
        const rawNumber = chatId.split('@')[0]
        const contactName = fromMe
            ? (rawNumber || 'Contato')
            : (senderName || rawNumber || 'Desconhecido')

        try {
            contact = await prisma.contact.create({
                data: {
                    organizationId,
                    channelId,
                    externalId: chatId,
                    phone: rawNumber ? `+${rawNumber}` : undefined,
                    name: contactName,
                    convStatus: 'pending',
                },
            })
            isNewContact = true
            void saveAvatarIfAvailable(contact.id, chatImage)
        } catch {
            // Race condition: outro request já criou o contato
            contact = await prisma.contact.findFirst({
                where: { organizationId, externalId: chatId, channelId },
            })
            if (!contact) throw new Error(`Contato não encontrado após race condition: ${chatId}`)
        }
    } else if (!fromMe && senderName && senderName !== contact.name) {
        await prisma.contact.update({ where: { id: contact.id }, data: { name: senderName } })
        contact = { ...contact, name: senderName }
    }

    // Evita duplicata (webhook pode reenviar)
    if (messageId) {
        const existing = await prisma.message.findFirst({
            where: { organizationId, externalId: messageId },
        })
        if (existing) return
    }

    const createdAt = messageTimestamp ? new Date(messageTimestamp) : new Date()
    const savedMsg = await prisma.message.create({
        data: {
            organizationId,
            contactId:  contact.id,
            channelId,
            direction,
            type:       msgType,
            content,
            status:     'sent',
            externalId: messageId,
            createdAt,
        },
    })

    // Publica em tempo real para os agentes
    publishToOrg(organizationId, {
        type: 'new_message',
        contactId:        contact.id,
        assignedToId:     contact.assignedToId,
        channelId,
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

    // Mensagem inbound → atualiza status do contato
    if (!fromMe && !isNewContact) {
        const needsStatusUpdate = !contact.convStatus || contact.convStatus === 'resolved'
        const newStatus = needsStatusUpdate ? 'pending' : contact.convStatus
        await prisma.contact.update({
            where: { id: contact.id },
            data: { convStatus: newStatus },
        })
        if (needsStatusUpdate) {
            publishToOrg(organizationId, {
                type: 'conv_updated',
                contactId: contact.id,
                convStatus: 'pending',
                assignedToId: contact.assignedToId,
                assignedToName: null,
            })
        }
    }

    // Auto-atribuição: só para inbound sem agente atribuído
    if (!fromMe && !contact.assignedToId) {
        void processAutoAssignment(contact.id, organizationId)
    }

    log.info(`✅ Mensagem processada - messageId: ${messageId}, contactId: ${contact.id}, direction: ${direction}`)
}

export function startMessageWorker() {
    const worker = new Worker<MessageJobData | WaBusinessMessageJobData>(
        'webhook-messages',
        async (job) => {

        // ── WhatsApp Business API (Meta) ────────────────────────────────────────
        if (job.name === 'process-wa-business-message') {
            const { channelId, organizationId, from, msgId, timestamp, msgType, content, contactName } = job.data as WaBusinessMessageJobData

            // Evita duplicata
            if (msgId) {
                const existing = await prisma.message.findFirst({ where: { organizationId, externalId: msgId } })
                if (existing) return
            }

            // Busca ou cria contato — inclui channelId na busca para isolar conversas por instância
            let contact = await prisma.contact.findFirst({ where: { organizationId, externalId: from, channelId } })
            let isNewContact = false
            if (!contact) {
                contact = await prisma.contact.create({
                    data: {
                        organizationId,
                        channelId,
                        externalId: from,
                        phone: `+${from}`,
                        name: contactName,
                        convStatus: 'pending',
                    },
                })
                isNewContact = true
                // Avatar será atualizado quando disponível via webhook
            }

            const createdAt = timestamp ? new Date(Number(timestamp) * 1000) : new Date()
            const savedMsg = await prisma.message.create({
                data: {
                    organizationId,
                    contactId:  contact.id,
                    channelId,
                    direction:  'inbound',
                    type:       msgType,
                    content,
                    status:     'sent',
                    externalId: msgId,
                    createdAt,
                },
            })

            publishToOrg(organizationId, {
                type: 'new_message',
                contactId:        contact.id,
                assignedToId:     contact.assignedToId,
                channelId,
                externalId:       contact.externalId,
                contactName:      contact.name,
                contactAvatarUrl: contact.avatarUrl,
                message: {
                    id:        savedMsg.id,
                    direction: 'inbound',
                    type:      msgType,
                    content,
                    status:    'sent',
                    createdAt: savedMsg.createdAt.toISOString(),
                },
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

            if (!isNewContact) {
                const needsStatusUpdate = !contact.convStatus || contact.convStatus === 'resolved'
                const newStatus = needsStatusUpdate ? 'pending' : contact.convStatus
                await prisma.contact.update({ where: { id: contact.id }, data: { convStatus: newStatus } })
                if (needsStatusUpdate) {
                    publishToOrg(organizationId, {
                        type: 'conv_updated',
                        contactId:      contact.id,
                        convStatus:     'pending',
                        assignedToId:   contact.assignedToId,
                        assignedToName: null,
                    })
                }
            }

            // Auto-atribuição: só para inbound sem agente atribuído
            if (!contact.assignedToId) {
                void processAutoAssignment(contact.id, organizationId)
            }
            return
        }

        // ── UAZAPI (fallback para jobs já na fila) ───────────────────────────
            await processUazapiMessage(job.data as MessageJobData)
        },
        {
            connection: redisConnection,
            concurrency: 10,
            lockDuration: 30000,       // 30s lock antes de considerar stalled
            stalledInterval: 15000,    // verifica stalled jobs a cada 15s
            maxStalledCount: 2,        // permite 2 stalls antes de falhar o job
        }
    )

    worker.on('failed', (job, err) => {
        log.error(`[MessageWorker] Job ${job?.id} (${job?.name}) falhou: ${err.message}`)
    })

    worker.on('stalled', (jobId) => {
        log.warn(`[MessageWorker] Job ${jobId} ficou stalled — será reprocessado`)
    })

    worker.on('error', (err) => {
        log.error(`[MessageWorker] Erro no worker: ${err.message}`)
    })

    console.log('⚙️  MessageWorker iniciado (concurrency=10)')
    return worker
}
