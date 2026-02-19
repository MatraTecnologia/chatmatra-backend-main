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

type SubscriberCallback = {
    userId: string
    callback: (event: AgentEvent) => void
}

const subscribers = new Map<string, Set<SubscriberCallback>>()

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
