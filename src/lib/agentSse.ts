// ─── Agent SSE Pub/Sub ────────────────────────────────────────────────────────
// Publishes real-time events to all agent dashboard connections of an org.
// Events are keyed by organizationId so each agent only receives events for
// their own org. The widget inbound message handler and the messages route call
// publishToOrg() after saving a message to fan-out to all watching agents.

export type AgentEvent =
    | {
          type: 'new_message'
          contactId: string
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

type SubscriberCallback = {
    userId: string
    callback: (event: AgentEvent) => void
}

type OnlineUser = {
    userId: string
    userName: string
    userImage: string | null
    currentContactId: string | null
    lastActivity: Date
    connectedAt: Date
}

const subscribers = new Map<string, Set<SubscriberCallback>>()
const onlineUsers = new Map<string, Map<string, OnlineUser>>() // orgId -> userId -> OnlineUser

/** Subscribe to all events for an org. Returns an unsubscribe function. */
export function subscribeOrg(orgId: string, userId: string, cb: (event: AgentEvent) => void): () => void {
    if (!subscribers.has(orgId)) subscribers.set(orgId, new Set())
    const subscriber: SubscriberCallback = { userId, callback: cb }
    subscribers.get(orgId)!.add(subscriber)
    return () => {
        const set = subscribers.get(orgId)
        if (!set) return
        set.delete(subscriber)
        if (set.size === 0) subscribers.delete(orgId)
    }
}

/** Publish an event to all active SSE connections for this org. */
export function publishToOrg(orgId: string, event: AgentEvent): void {
    subscribers.get(orgId)?.forEach((subscriber) => subscriber.callback(event))
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

    // Broadcast evento de presença atualizada
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
