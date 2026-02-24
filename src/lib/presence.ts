// ─── Sistema de Presença em Tempo Real com Socket.io ─────────────────────────
// Sistema completo de rastreamento de usuários online com WebSocket bidirecional

import { Server as SocketServer, type Socket } from 'socket.io'
import type { Server as HTTPServer } from 'http'
import { prisma } from './prisma.js'

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
    // Estado da tela para supervisão
    screenState?: {
        messages?: any[]
        inputText?: string
        scrollPosition?: number
        lastAction?: string
        // Novos campos para supervisão completa
        pageState?: any  // Estado completo da página
        clicks?: Array<{ x: number; y: number; timestamp: string; element: string }>
        currentScroll?: { x: number; y: number }
        formData?: Record<string, any>
    }
}

export type PresenceEvent =
    | { type: 'user_online'; user: UserPresence }
    | { type: 'user_offline'; userId: string; organizationId: string }
    | { type: 'user_away'; userId: string; organizationId: string }
    | { type: 'user_active'; userId: string; organizationId: string }
    | { type: 'user_viewing'; userId: string; contactId: string; organizationId: string }
    | { type: 'user_typing'; userId: string; contactId: string; isTyping: boolean; organizationId: string }
    | { type: 'presence_update'; users: UserPresence[]; organizationId: string }
    // Eventos de supervisão em conversas
    | { type: 'screen_update'; userId: string; contactId: string; messages: any[]; organizationId: string }
    | { type: 'input_update'; userId: string; contactId: string; text: string; organizationId: string }
    | { type: 'scroll_update'; userId: string; contactId: string; position: number; organizationId: string }
    | { type: 'action_performed'; userId: string; contactId: string; action: string; organizationId: string }
    // Novos eventos para supervisão global (todas as páginas)
    | { type: 'page_loaded'; userId: string; route: string; state: any; organizationId: string }
    | { type: 'page_state'; userId: string; route: string; state: any; organizationId: string }
    | { type: 'user_click'; userId: string; x: number; y: number; element: string; route: string; organizationId: string; timestamp: string }
    | { type: 'user_scroll_global'; userId: string; x: number; y: number; route: string; organizationId: string; timestamp: string }
    | { type: 'user_input_global'; userId: string; field: string; value: string; route: string; organizationId: string; timestamp: string }

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
            // Reflete a origem da request — permite dashboard (com cookies) e widget embarcado (qualquer site)
            origin: true,
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

    // ═══════════════════════════════════════════════════════════════════════════
    // Eventos de Supervisão - Estado da Tela em Tempo Real
    // ═══════════════════════════════════════════════════════════════════════════

    // Atualização de mensagens visualizadas
    socket.on('screen_update', (data: { contactId: string; messages: any[] }) => {
        handleScreenUpdate(socket.id, data.contactId, data.messages)
    })

    // Atualização de texto sendo digitado (preview para supervisor)
    socket.on('input_update', (data: { contactId: string; text: string }) => {
        handleInputUpdate(socket.id, data.contactId, data.text)
    })

    // Atualização de posição de scroll
    socket.on('scroll_update', (data: { contactId: string; position: number }) => {
        handleScrollUpdate(socket.id, data.contactId, data.position)
    })

    // Ação realizada (enviar mensagem, mudar status, etc)
    socket.on('action_performed', (data: { contactId: string; action: string }) => {
        handleActionPerformed(socket.id, data.contactId, data.action)
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // Novos Eventos de Supervisão Global - Todas as Páginas
    // ═══════════════════════════════════════════════════════════════════════════

    // Página carregada
    socket.on('page_loaded', (data: { route: string; state: any }) => {
        handlePageLoaded(socket.id, data.route, data.state)
    })

    // Estado completo da página atualizado
    socket.on('page_state', (data: { route: string; state: any }) => {
        handlePageState(socket.id, data.route, data.state)
    })

    // Clique do usuário
    socket.on('user_click', (data: { x: number; y: number; element: string; className: string; text: string; route: string; timestamp: string }) => {
        handleUserClick(socket.id, data)
    })

    // Scroll do usuário
    socket.on('user_scroll', (data: { x: number; y: number; route: string; timestamp: string }) => {
        handleUserScrollGlobal(socket.id, data)
    })

    // Input do usuário
    socket.on('user_input', (data: { field: string; value: string; type: string; route: string; timestamp: string }) => {
        handleUserInputGlobal(socket.id, data)
    })

    // ── Widget (chat embarcado em sites externos) ────────────────────────────
    // Autentica o widget via apiKey e entra na sala do contato.
    socket.on('widget_connect', async (data: { key: string; contactId: string }) => {
        try {
            const channel = await prisma.channel.findFirst({
                where: { apiKey: data.key, type: 'api' },
                select: { id: true },
            })
            if (!channel) { socket.disconnect(); return }
            socket.join(`widget:${data.contactId}`)
        } catch { socket.disconnect() }
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
 * Atualiza mensagens visualizadas (para supervisão)
 */
function handleScreenUpdate(socketId: string, contactId: string, messages: any[]) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza estado da tela
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.messages = messages
    presence.lastActivity = new Date()

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'screen_update',
        userId,
        contactId,
        messages,
        organizationId,
    })
}

/**
 * Atualiza texto sendo digitado (para supervisão)
 */
function handleInputUpdate(socketId: string, contactId: string, text: string) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza estado da tela
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.inputText = text
    presence.lastActivity = new Date()

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'input_update',
        userId,
        contactId,
        text,
        organizationId,
    })
}

/**
 * Atualiza posição de scroll (para supervisão)
 */
function handleScrollUpdate(socketId: string, contactId: string, position: number) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza estado da tela
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.scrollPosition = position
    presence.lastActivity = new Date()

    // Broadcast para supervisores (com throttle, não enviar toda mudança)
    broadcastToOrganization(organizationId, {
        type: 'scroll_update',
        userId,
        contactId,
        position,
        organizationId,
    })
}

/**
 * Registra ação realizada (para supervisão)
 */
function handleActionPerformed(socketId: string, contactId: string, action: string) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza estado da tela
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.lastAction = action
    presence.lastActivity = new Date()

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'action_performed',
        userId,
        contactId,
        action,
        organizationId,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Novos Handlers para Supervisão Global - Todas as Páginas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handler de página carregada
 */
function handlePageLoaded(socketId: string, route: string, state: any) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza rota e estado
    presence.currentRoute = route
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.pageState = state
    presence.lastActivity = new Date()

    console.log(`📄 [SUPERVISÃO] ${userId} carregou página: ${route}`)

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'page_loaded',
        userId,
        route,
        state,
        organizationId,
    })
}

/**
 * Handler de estado da página atualizado
 */
function handlePageState(socketId: string, route: string, state: any) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza estado da página
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.pageState = state
    presence.lastActivity = new Date()

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'page_state',
        userId,
        route,
        state,
        organizationId,
    })
}

/**
 * Handler de clique do usuário
 */
function handleUserClick(socketId: string, data: { x: number; y: number; element: string; className: string; text: string; route: string; timestamp: string }) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza lista de cliques (mantém últimos 5)
    if (!presence.screenState) presence.screenState = {}
    if (!presence.screenState.clicks) presence.screenState.clicks = []

    presence.screenState.clicks = [
        ...presence.screenState.clicks.slice(-4), // Mantém últimos 4
        { x: data.x, y: data.y, timestamp: data.timestamp, element: data.element }
    ]
    presence.lastActivity = new Date()

    console.log(`🖱️ [SUPERVISÃO] ${userId} clicou em ${data.element} em ${data.route}`)

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'user_click',
        userId,
        x: data.x,
        y: data.y,
        element: data.element,
        route: data.route,
        organizationId,
        timestamp: data.timestamp,
    })
}

/**
 * Handler de scroll global do usuário
 */
function handleUserScrollGlobal(socketId: string, data: { x: number; y: number; route: string; timestamp: string }) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza posição atual de scroll
    if (!presence.screenState) presence.screenState = {}
    presence.screenState.currentScroll = { x: data.x, y: data.y }
    presence.lastActivity = new Date()

    // Broadcast para supervisores (throttled no frontend)
    broadcastToOrganization(organizationId, {
        type: 'user_scroll_global',
        userId,
        x: data.x,
        y: data.y,
        route: data.route,
        organizationId,
        timestamp: data.timestamp,
    })
}

/**
 * Handler de input global do usuário
 */
function handleUserInputGlobal(socketId: string, data: { field: string; value: string; type: string; route: string; timestamp: string }) {
    const socketInfo = socketMap.get(socketId)
    if (!socketInfo) return

    const { userId, organizationId } = socketInfo
    const presence = presenceMap.get(organizationId)?.get(userId)
    if (!presence) return

    // Atualiza form data
    if (!presence.screenState) presence.screenState = {}
    if (!presence.screenState.formData) presence.screenState.formData = {}
    presence.screenState.formData[data.field] = data.value
    presence.lastActivity = new Date()

    console.log(`⌨️ [SUPERVISÃO] ${userId} digitou em ${data.field} em ${data.route}`)

    // Broadcast para supervisores
    broadcastToOrganization(organizationId, {
        type: 'user_input_global',
        userId,
        field: data.field,
        value: data.value,
        route: data.route,
        organizationId,
        timestamp: data.timestamp,
    })
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
 * Emite um evento de agente (new_message, conv_updated) para toda a organização via Socket.io.
 * Substitui o sistema SSE in-memory para entrega em tempo real.
 */
export function emitAgentEvent(organizationId: string, event: unknown): void {
    if (!io) return
    io.to(`org:${organizationId}`).emit('agent_event', event)
}

/**
 * Emite uma mensagem para o widget de chat do contato via Socket.io.
 * Substitui o sistema SSE widgetSse para entrega em tempo real.
 */
export function emitWidgetMessage(contactId: string, msg: unknown): void {
    if (!io) return
    io.to(`widget:${contactId}`).emit('widget_message', msg)
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
