// ─── Message Worker ────────────────────────────────────────────────────────────
// Processa jobs de mensagens recebidas via webhook da Evolution API.
// Executa a mesma lógica que antes rodava inline no webhook handler.

import { Worker } from 'bullmq'
import { redisConnection, type MessageJobData, type WaBusinessMessageJobData } from '../queue.js'
import { prisma } from '../prisma.js'
import { publishToOrg } from '../agentSse.js'

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
            return
        }

        // ── Evolution API ───────────────────────────────────────────────────────
            const { channelId, organizationId, key, message, pushName } = job.data as MessageJobData
            const remoteJid = key.remoteJid ?? ''
            const fromMe    = key.fromMe ?? false

            // Só processa mensagens individuais (não grupos)
            if (!remoteJid.includes('@s.whatsapp.net') && !remoteJid.includes('@c.us')) return

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = message as any

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
            if (!content && !isMedia) return

            const direction = fromMe ? 'outbound' : 'inbound'

            // Busca ou cria o contato pelo JID — inclui channelId para isolar conversas por instância
            let contact = await prisma.contact.findFirst({
                where: { organizationId, externalId: remoteJid, channelId },
            })

            let isNewContact = false
            if (!contact) {
                const rawNumber = remoteJid.split('@')[0]
                const contactName = fromMe
                    ? (rawNumber || 'Contato')
                    : (pushName || rawNumber || 'Desconhecido')

                contact = await prisma.contact.create({
                    data: {
                        organizationId,
                        channelId,
                        externalId: remoteJid,
                        phone: rawNumber ? `+${rawNumber}` : undefined,
                        name: contactName,
                        convStatus: 'pending',
                    },
                })
                isNewContact = true
            } else if (!fromMe && pushName && pushName !== contact.name) {
                // Atualiza nome se o pushName mudou (dentro da mesma instância)
                await prisma.contact.update({ where: { id: contact.id }, data: { name: pushName } })
                contact = { ...contact, name: pushName }
            }

            // Evita duplicata se a mensagem já foi salva (webhook retried)
            if (key.id) {
                const existing = await prisma.message.findFirst({
                    where: { organizationId, externalId: key.id },
                })
                if (existing) return
            }

            const savedMsg = await prisma.message.create({
                data: {
                    organizationId,
                    contactId:  contact.id,
                    channelId,
                    direction,
                    type:       msgType,
                    content,
                    status:     'sent',
                    externalId: key.id,
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

            // Mensagem inbound → atualiza status e updatedAt do contato
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
        },
        {
            connection: redisConnection,
            concurrency: 10,
        }
    )

    worker.on('failed', (job, err) => {
        console.error(`[MessageWorker] Job ${job?.id} falhou:`, err.message)
    })

    console.log('⚙️  MessageWorker iniciado (concurrency=10)')
    return worker
}
