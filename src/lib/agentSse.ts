// ─── Agent Event Pub/Sub ──────────────────────────────────────────────────────
// Publishes real-time events to all agent dashboard connections of an org.
// Events are keyed by organizationId so each agent only receives events for
// their own org. Delivery is exclusively via Socket.io (WebSocket).

import { emitAgentEvent } from './presence.js'

export type AgentEvent =
    | {
          type: 'new_message'
          contactId: string
          /** ID do agente atribuído ao contato — usado para filtrar notificações */
          assignedToId?: string | null
          /** Canal pelo qual a mensagem chegou (necessário para enviar resposta) */
          channelId?: string | null
          /** JID / externalId do contato (necessário para enviar resposta via WhatsApp) */
          externalId?: string | null
          /** Nome do contato — sempre presente para exibir na notificação */
          contactName?: string | null
          /** URL do avatar do contato — sempre presente para exibir na notificação */
          contactAvatarUrl?: string | null
          message: {
              id: string
              direction: 'outbound' | 'inbound'
              type: string
              content: string
              status: string
              createdAt: string
          }
          /** Preenchido quando o contato foi criado agora (primeiro contato) */
          contact?: {
              id: string
              name: string
              phone?: string | null
              avatarUrl?: string | null
              externalId?: string | null
              channelId?: string | null
              convStatus: string
              createdAt: string
          }
      }
    | {
          type: 'conv_updated'
          contactId: string
          convStatus: string
          assignedToId: string | null
          assignedToName: string | null
          assignedToImage?: string | null
          teamId?: string | null
          teamName?: string | null
          /** Novo canal do contato — preenchido quando a instância mudou */
          channelId?: string | null
      }
    | {
          type: 'user_viewing'
          contactId: string
          userId: string
          userName: string
          userImage: string | null
          timestamp: string
      }
    | {
          type: 'user_left'
          contactId: string
          userId: string
      }
    | {
          type: 'user_typing'
          contactId: string
          userId: string
          userName: string
          isTyping: boolean
      }
    | {
          type: 'user_online'
          userId: string
          userName: string
          userImage: string | null
          timestamp: string
      }
    | {
          type: 'user_offline'
          userId: string
          timestamp: string
      }
    | {
          type: 'presence_update'
          users: OnlineUser[]
      }

type OnlineUser = {
    userId: string
    userName: string
    userImage: string | null
    currentContactId: string | null
    lastActivity: Date
    connectedAt: Date
}

const onlineUsers = new Map<string, Map<string, OnlineUser>>() // orgId -> userId -> OnlineUser

/** Publica um evento para todos os agentes da org via WebSocket (Socket.io). */
export function publishToOrg(orgId: string, event: AgentEvent): void {
    emitAgentEvent(orgId, event)
}

/** Adiciona ou atualiza usuário online */
export function setUserOnline(orgId: string, userId: string, userName: string, userImage: string | null, contactId: string | null = null): void {
    if (!onlineUsers.has(orgId)) {
        onlineUsers.set(orgId, new Map())
    }

    const orgUsers = onlineUsers.get(orgId)!
    const existing = orgUsers.get(userId)

    if (existing) {
        existing.currentContactId = contactId
        existing.lastActivity = new Date()
    } else {
        orgUsers.set(userId, {
            userId,
            userName,
            userImage,
            currentContactId: contactId,
            lastActivity: new Date(),
            connectedAt: new Date(),
        })
    }

    publishToOrg(orgId, {
        type: 'user_viewing',
        contactId: contactId ?? '',
        userId,
        userName,
        userImage,
        timestamp: new Date().toISOString(),
    })
}

/** Remove usuário online */
export function setUserOffline(orgId: string, userId: string): void {
    const orgUsers = onlineUsers.get(orgId)
    if (orgUsers) {
        orgUsers.delete(userId)
        if (orgUsers.size === 0) {
            onlineUsers.delete(orgId)
        }
    }
}

/** Retorna lista de usuários online da organização */
export function getOnlineUsers(orgId: string): OnlineUser[] {
    const orgUsers = onlineUsers.get(orgId)
    if (!orgUsers) return []

    // Remove usuários inativos há mais de 5 minutos
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)

    for (const [userId, user] of orgUsers.entries()) {
        if (user.lastActivity < fiveMinutesAgo) {
            orgUsers.delete(userId)
        }
    }

    return Array.from(orgUsers.values())
}
