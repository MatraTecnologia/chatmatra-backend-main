// ─── Sistema de Presença em Tempo Real com Socket.io ─────────────────────────
// Sistema completo de rastreamento de usuários online com WebSocket bidirecional

import type { Server as SocketServer, Socket } from 'socket.io'
import type { Server as HTTPServer } from 'http'

export type UserPresence = {
    userId: string
    userName: string
    userEmail: string
    userImage: string | null
    userRole: string
    organizationId: string
    status: 'online' | 'away' | 'offline'
    currentContactId: string | null
    currentRoute: string | null
    lastActivity: Date
    connectedAt: Date
    socketId: string
}

export type PresenceEvent =
    | { type: 'user_online'; user: UserPresence }
    | { type: 'user_offline'; userId: string; organizationId: string }
    | { type: 'user_away'; userId: string; organizationId: string }
    | { type: 'user_active'; userId: string; organizationId: string }
    | { type: 'user_viewing'; userId: string; contactId: string; organizationId: string }
    | { type: 'user_typing'; userId: string; contactId: string; isTyping: boolean; organizationId: string }
    | { type: 'presence_update'; users: UserPresence[]; organizationId: string }

// Map: organizationId -> userId -> UserPresence
const presenceMap = new Map<string, Map<string, UserPresence>>()

// Map: socketId -> { userId, organizationId }
const socketMap = new Map<string, { userId: string; organizationId: string }>()

let io: SocketServer | null = null

/**
 * Inicializa o Socket.io server
 */
export function initializePresenceSystem(httpServer: HTTPServer): SocketServer {
    io = new SocketServer(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:3000',
            credentials: true,
        },
        pingInterval: 20000, // Heartbeat a cada 20s
        pingTimeout: 10000,  // Timeout após 10s sem resposta
    })

    io.on('connection', handleConnection)

    // Cleanup de usuários inativos a cada minuto
    setInterval(cleanupInactiveUsers, 60000)

    console.log('✅ Sistema de Presença WebSocket inicializado')

    return io
}

/**
 * Handler de nova conexão WebSocket
 */
function handleConnection(socket: Socket) {
    console.log(`🔌 Nova conexão WebSocket: ${socket.id}`)

    // Autenticação e registro de presença
    socket.on('register', (data: {
        userId: string
        userName: string
        userEmail: string
        userImage: string | null
        userRole: string
        organizationId: string
    }) => {
        registerUser(socket, data)
    })

    // Heartbeat (manter online)
    socket.on('heartbeat', () => {
        updateUserActivity(socket.id)
    })

    // Visualizando conversa
    socket.on('viewing', (data: { contactId: string | null }) => {
        updateUserViewing(socket.id, data.contactId)
    })

    // Navegando para rota
    socket.on('navigate', (data: { route: string }) => {
        updateUserRoute(socket.id, data.route)
    })

    // Digitando
    socket.on('typing', (data: { contactId: string; isTyping: boolean }) => {
        handleTyping(socket.id, data.contactId, data.isTyping)
    })

    // Status manual (online, away)
    socket.on('status', (data: { status: 'online' | 'away' }) => {
        updateUserStatus(socket.id, data.status)
    })

    // Desconexão
    socket.on('disconnect', () => {
        handleDisconnect(socket.id)
    })
}

/**
 * Registra usuário como online
 */
function registerUser(
    socket: Socket,
    data: {
        userId: string
        userName: string
        userEmail: string
        userImage: string | null
        userRole: string
        organizationId: string
    }
) {
    const { userId, userName, userEmail, userImage, userRole, organizationId } = data

    // Cria estrutura de presença
    if (!presenceMap.has(organizationId)) {
        presenceMap.set(organizationId, new Map())
    }

    const orgPresence = presenceMap.get(organizationId)!

    // Remove presença anterior se existir (reconexão)
    const existingPresence = orgPresence.get(userId)
    if (existingPresence) {
        socketMap.delete(existingPresence.socketId)
    }

    // Cria nova presença
    const presence: UserPresence = {
        userId,
        userName,
        userEmail,
        userImage,
        userRole,
        organizationId,
        status: 'online',
        currentContactId: null,
        currentRoute: null,
        lastActivity: new Date(),
        connectedAt: existingPresence?.connectedAt || new Date(),
        socketId: socket.id,
    }

    orgPresence.set(userId, presence)
    socketMap.set(socket.id, { userId, organizationId })

    // Entra na sala da organização
    socket.join(`org:${organizationId}`)

    // Notifica todos da organização
    broadcastToOrganization(organizationId, {
        type: 'user_online',
        user: presence,
    })

    // Envia lista atual para o novo usuário
    socket.emit('presence_update', {
        users: Array.from(orgPresence.values()).filter(u => u.userId !== userId),
    })

    console.log(`✅ Usuário registrado: ${userName} (${organizationId})`)
}

/**
 * Atualiza atividade do usuário (heartbeat)
 */
function updateUserActivity(socketId: string) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    presence.lastActivity = new Date()

    // Se estava away, volta para online
    if (presence.status === 'away') {
        presence.status = 'online'
        broadcastToOrganization(organizationId, {
            type: 'user_active',
            userId,
            organizationId,
        })
    }
}

/**
 * Atualiza conversa que o usuário está visualizando
 */
function updateUserViewing(socketId: string, contactId: string | null) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    presence.currentContactId = contactId
    presence.lastActivity = new Date()

    broadcastToOrganization(organizationId, {
        type: 'user_viewing',
        userId,
        contactId: contactId || '',
        organizationId,
    })
}

/**
 * Atualiza rota atual do usuário
 */
function updateUserRoute(socketId: string, route: string) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    presence.currentRoute = route
    presence.lastActivity = new Date()
}

/**
 * Handler de digitação
 */
function handleTyping(socketId: string, contactId: string, isTyping: boolean) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo

    broadcastToOrganization(organizationId, {
        type: 'user_typing',
        userId,
        contactId,
        isTyping,
        organizationId,
    })
}

/**
 * Atualiza status do usuário
 */
function updateUserStatus(socketId: string, status: 'online' | 'away') {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    presence.status = status
    presence.lastActivity = new Date()

    const event: PresenceEvent = status === 'away'
        ? { type: 'user_away', userId, organizationId }
        : { type: 'user_active', userId, organizationId }

    broadcastToOrganization(organizationId, event)
}

/**
 * Handler de desconexão
 */
function handleDisconnect(socketId: string) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo

    // Remove presença
    const orgPresence = presenceMap.get(organizationId)
    if (orgPresence) {
        orgPresence.delete(userId)
        if (orgPresence.size === 0) {
            presenceMap.delete(organizationId)
        }
    }

    socketMap.delete(socketId)

    // Notifica todos
    broadcastToOrganization(organizationId, {
        type: 'user_offline',
        userId,
        organizationId,
    })

    console.log(`❌ Usuário desconectado: ${userId} (${organizationId})`)
}

/**
 * Limpa usuários inativos (sem heartbeat há >3 minutos)
 */
function cleanupInactiveUsers() {
    const now = new Date()
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000)

    for (const [orgId, orgPresence] of presenceMap.entries()) {
        for (const [userId, presence] of orgPresence.entries()) {
            if (presence.lastActivity < threeMinutesAgo) {
                orgPresence.delete(userId)
                socketMap.delete(presence.socketId)

                broadcastToOrganization(orgId, {
                    type: 'user_offline',
                    userId,
                    organizationId: orgId,
                })

                console.log(`🧹 Usuário inativo removido: ${userId}`)
            }
        }

        if (orgPresence.size === 0) {
            presenceMap.delete(orgId)
        }
    }
}

/**
 * Broadcast evento para toda a organização
 */
function broadcastToOrganization(organizationId: string, event: PresenceEvent) {
    if (!io) return
    io.to(`org:${organizationId}`).emit('presence_event', event)
}

/**
 * Retorna usuários online de uma organização
 */
export function getOnlineUsers(organizationId: string): UserPresence[] {
    const orgPresence = presenceMap.get(organizationId)
    return orgPresence ? Array.from(orgPresence.values()) : []
}

/**
 * Retorna presença de um usuário específico
 */
export function getUserPresence(organizationId: string, userId: string): UserPresence | null {
    return presenceMap.get(organizationId)?.get(userId) || null
}

/**
 * Força desconexão de um usuário
 */
export function disconnectUser(organizationId: string, userId: string) {
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence || !io) return

    const socket = io.sockets.sockets.get(presence.socketId)
    if (socket) {
        socket.disconnect(true)
    }
}
