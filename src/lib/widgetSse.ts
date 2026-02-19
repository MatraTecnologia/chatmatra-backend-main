// ─── Widget SSE Pub/Sub ───────────────────────────────────────────────────────
// In-memory store that maps contactId → set of callbacks.
// Messages route calls publish() when an outbound message is saved for a widget
// (api-channel) contact, fanning out to all active SSE connections for that contact.

export type SseMessage = {
    id: string
    contactId: string
    direction: 'outbound' | 'inbound'
    type: 'text' | 'note'
    content: string
    status: string
    createdAt: string
}

const subscribers = new Map<string, Set<(msg: SseMessage) => void>>()

/** Register a callback for a contactId. Returns an unsubscribe function. */
export function subscribe(contactId: string, cb: (msg: SseMessage) => void): () => void {
    if (!subscribers.has(contactId)) {
        subscribers.set(contactId, new Set())
    }
    subscribers.get(contactId)!.add(cb)

    return () => {
        const set = subscribers.get(contactId)
        if (!set) return
        set.delete(cb)
        if (set.size === 0) subscribers.delete(contactId)
    }
}

/** Fan out a message to all active SSE connections for this contactId. */
export function publish(contactId: string, msg: SseMessage): void {
    subscribers.get(contactId)?.forEach((cb) => cb(msg))
}
