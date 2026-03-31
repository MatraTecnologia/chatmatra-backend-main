// ─── BullMQ Queue Definitions ─────────────────────────────────────────────────
// Centraliza a criação das filas e a conexão Redis compartilhada.
// Os workers são inicializados em server.ts após o app subir.

import { Queue } from 'bullmq'
import IORedis from 'ioredis'

// ─── Conexão Redis ─────────────────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

export const redisConnection = new IORedis(redisUrl, {
    // BullMQ exige maxRetriesPerRequest: null para funcionar corretamente
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
})

redisConnection.on('connect', () => console.log('✅ Redis conectado'))
redisConnection.on('error', (err) => console.error('❌ Erro Redis:', err.message))

// ─── Tipos dos jobs ────────────────────────────────────────────────────────────

/** Job de processamento de mensagem recebida via webhook UAZAPI */
export type MessageJobData = {
    channelId: string
    organizationId: string
    channelName: string
    chatId: string            // "554398414904@s.whatsapp.net"
    fromMe: boolean
    messageId: string         // "554391834229:3B353D3AAB6C140AB3FD"
    type: string              // "text" | "media"
    mediaType: string         // "" | "image" | "video" | "document" | "ptt" | "vcard"
    messageType: string       // "Conversation" | "ImageMessage" | etc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any              // string for text, object for media
    text: string              // text content or caption
    senderName: string
    messageTimestamp: number   // milissegundos
    chatImage?: string         // avatar URL do chat object
    quoted?: string            // msg.quoted — ID curto da mensagem citada
    quotedText?: string        // extraído de msg.content.contextInfo.quotedMessage.conversation
}

/** Job de processamento de mensagem recebida via WhatsApp Business API (Meta) */
export type WaBusinessMessageJobData = {
    source: 'whatsapp-business'
    channelId: string
    organizationId: string
    from: string           // wa_id / phone number do remetente
    msgId: string          // message ID único do Meta
    timestamp: string      // unix timestamp como string
    msgType: 'text' | 'image' | 'video' | 'audio' | 'document'
    content: string
    contactName: string
}

/** Job de sincronização de histórico de todos os canais da org */
export type SyncAllHistoryJobData = {
    orgId: string
    userId: string
}

/** Job de sincronização de mensagens de um contato específico */
export type SyncContactJobData = {
    contactId: string
    orgId: string
}

// ─── Filas ─────────────────────────────────────────────────────────────────────

const queueOptions = {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 200,  // mantém últimos 200 completados para histórico
        removeOnFail: 100,      // mantém últimos 100 falhos para depuração
    },
}

/** Fila para processamento de mensagens do webhook (UAZAPI + WA Business) */
export const messageQueue = new Queue<MessageJobData | WaBusinessMessageJobData>('webhook-messages', queueOptions)

/** Fila para sincronizações de histórico */
export const syncQueue = new Queue<SyncAllHistoryJobData | SyncContactJobData>('sync-history', queueOptions)
