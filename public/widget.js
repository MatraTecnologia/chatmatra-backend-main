/* MatraChat Widget v1.0 — self-contained, no dependencies */
;(function () {
    'use strict'

    // ── Read config from <script> attributes ────────────────────────────────
    const script = document.currentScript
    if (!script) return

    const apiKey      = script.getAttribute('data-api-key')
    const apiBase     = (script.getAttribute('data-api-base') || script.src.replace(/\/static\/widget\.js.*$/, '')).replace(/\/$/, '')

    if (!apiKey) { console.warn('[MatraChat] data-api-key is required'); return }

    const scriptAttrs = {
        primaryColor:   script.getAttribute('data-primary-color'),
        agentName:      script.getAttribute('data-agent-name'),
        welcomeText:    script.getAttribute('data-welcome-text'),
        agentAvatarUrl: script.getAttribute('data-avatar-url'),
        position:       script.getAttribute('data-position'),   // 'left' | 'right'
    }

    // ── State ────────────────────────────────────────────────────────────────
    let state      = 'closed'   // 'closed' | 'form' | 'chat'
    let contactId  = null
    let contactName = null
    let contactPhone = null
    let eventSource = null
    let messagesEl  = null
    let cfg = {
        primaryColor:   '#6366f1',
        agentName:      'Suporte',
        welcomeText:    'Olá! Como posso ajudar?',
        agentAvatarUrl: null,
        position:       'right',
    }

    const storageKey = 'matrachat_v1_' + apiKey

    // ── Helpers ──────────────────────────────────────────────────────────────

    function h(tag, attrs, ...children) {
        const el = document.createElement(tag)
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                if (k === 'style' && typeof v === 'object') {
                    Object.assign(el.style, v)
                } else if (k.startsWith('on') && typeof v === 'function') {
                    el.addEventListener(k.slice(2).toLowerCase(), v)
                } else {
                    el.setAttribute(k, v)
                }
            }
        }
        for (const child of children) {
            if (child == null) continue
            el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
        }
        return el
    }

    function fmtTime(iso) {
        const d = new Date(iso)
        return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0')
    }

    // ── Phone helpers ────────────────────────────────────────────────────────

    const COUNTRIES = [
        { code: '+55',  flag: '🇧🇷', label: 'Brasil',    ph: '(11) 99999-9999' },
        { code: '+1',   flag: '🇺🇸', label: 'EUA / CA',  ph: '(555) 555-5555'  },
        { code: '+351', flag: '🇵🇹', label: 'Portugal',  ph: '912 345 678'     },
        { code: '+54',  flag: '🇦🇷', label: 'Argentina', ph: '11 1234-5678'    },
        { code: '+34',  flag: '🇪🇸', label: 'Espanha',   ph: '612 345 678'     },
        { code: '+44',  flag: '🇬🇧', label: 'UK',        ph: '07700 900000'    },
        { code: '+33',  flag: '🇫🇷', label: 'França',    ph: '06 12 34 56 78'  },
        { code: '+49',  flag: '🇩🇪', label: 'Alemanha',  ph: '0171 1234567'    },
        { code: '+52',  flag: '🇲🇽', label: 'México',    ph: '55 1234 5678'    },
        { code: '+57',  flag: '🇨🇴', label: 'Colômbia',  ph: '321 123 4567'    },
        { code: '+56',  flag: '🇨🇱', label: 'Chile',     ph: '9 1234 5678'     },
    ]

    function maskPhone(raw, countryCode) {
        const d = raw.replace(/\D/g, '')
        if (countryCode === '+55') {
            if (d.length <= 2)  return d
            if (d.length <= 6)  return '(' + d.slice(0,2) + ') ' + d.slice(2)
            if (d.length <= 10) return '(' + d.slice(0,2) + ') ' + d.slice(2,6) + '-' + d.slice(6)
            return               '(' + d.slice(0,2) + ') ' + d.slice(2,7) + '-' + d.slice(7,11)
        }
        if (countryCode === '+1') {
            if (d.length <= 3)  return d
            if (d.length <= 6)  return '(' + d.slice(0,3) + ') ' + d.slice(3)
            return               '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6,10)
        }
        return d
    }

    // ── Fetch config from backend (data-* attrs take priority) ───────────────

    async function fetchConfig() {
        try {
            const res = await fetch(apiBase + '/widget/config', {
                headers: { 'X-Widget-Key': apiKey },
            })
            if (res.ok) {
                const data = await res.json()
                cfg = { ...cfg, ...data }
            }
        } catch (_) { /* use defaults */ }
        // script data-* attributes override backend config
        for (const [k, v] of Object.entries(scriptAttrs)) {
            if (v) cfg[k] = v
        }
    }

    // ── CSS ──────────────────────────────────────────────────────────────────

    function injectStyles() {
        const pos = cfg.position === 'left' ? 'left: 20px' : 'right: 20px'
        const css = `
:root { --mc-primary: ${cfg.primaryColor}; }
#mc-bubble {
    position: fixed; bottom: 20px; ${pos}; z-index: 9999;
    width: 56px; height: 56px; border-radius: 50%;
    background: var(--mc-primary); color: #fff; border: none; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.25); display: flex; align-items: center;
    justify-content: center; transition: transform .15s, box-shadow .15s;
}
#mc-bubble:hover { transform: scale(1.07); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
#mc-widget {
    position: fixed; bottom: 88px; ${pos}; z-index: 9998;
    width: 360px; max-height: 520px;
    background: #fff; border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0,0,0,.18);
    display: flex; flex-direction: column; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; line-height: 1.4;
    animation: mc-fadein .15s ease;
}
@keyframes mc-fadein { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
@media (max-width: 420px) {
    #mc-widget { width: calc(100vw - 24px); bottom: 80px; left: 12px !important; right: 12px !important; }
}
#mc-header {
    background: var(--mc-primary); color: #fff;
    padding: 14px 16px; display: flex; align-items: center; gap: 10px;
}
#mc-header img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: rgba(255,255,255,.3); }
#mc-header .mc-agent-info { flex: 1 }
#mc-header .mc-agent-name { font-weight: 600; font-size: 15px }
#mc-header .mc-agent-status { font-size: 11px; opacity: .8 }
#mc-close {
    background: none; border: none; color: #fff; cursor: pointer;
    font-size: 18px; padding: 4px; opacity: .8; line-height: 1;
}
#mc-close:hover { opacity: 1 }
#mc-messages {
    flex: 1; overflow-y: auto; padding: 12px 14px;
    background: #f8f8fb; display: flex; flex-direction: column; gap: 6px;
}
#mc-messages::-webkit-scrollbar { width: 4px }
#mc-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px }
.mc-msg {
    max-width: 75%; padding: 8px 12px; border-radius: 14px; word-break: break-word;
    display: flex; flex-direction: column; gap: 2px;
}
.mc-msg-inbound {
    background: #fff; color: #222; border-bottom-left-radius: 4px;
    align-self: flex-start; box-shadow: 0 1px 3px rgba(0,0,0,.08);
}
.mc-msg-outbound {
    background: var(--mc-primary); color: #fff; border-bottom-right-radius: 4px;
    align-self: flex-end;
}
.mc-msg-time { font-size: 10px; opacity: .55; align-self: flex-end; }
.mc-welcome {
    text-align: center; color: #999; font-size: 12px; margin: 8px 0 4px;
}
#mc-input-area {
    padding: 10px 12px; border-top: 1px solid #eee;
    display: flex; gap: 8px; align-items: flex-end; background: #fff;
}
#mc-input {
    flex: 1; border: 1px solid #e0e0e0; border-radius: 20px;
    padding: 8px 14px; font-size: 14px; outline: none; resize: none;
    font-family: inherit; line-height: 1.4; max-height: 80px; overflow-y: auto;
}
#mc-input:focus { border-color: var(--mc-primary); }
#mc-send {
    width: 36px; height: 36px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--mc-primary); color: #fff; display: flex; align-items: center;
    justify-content: center; flex-shrink: 0; transition: opacity .15s;
}
#mc-send:hover { opacity: .85 }
#mc-form { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
#mc-form p { margin: 0 0 4px; color: #555; font-size: 13px; }
.mc-input-wrap label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
.mc-input-wrap input {
    width: 100%; box-sizing: border-box; border: 1px solid #ddd; border-radius: 8px;
    padding: 9px 12px; font-size: 14px; outline: none; font-family: inherit;
}
.mc-input-wrap input:focus { border-color: var(--mc-primary); }
#mc-form-submit {
    background: var(--mc-primary); color: #fff; border: none; border-radius: 8px;
    padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 4px;
    transition: opacity .15s;
}
#mc-form-submit:hover { opacity: .88 }
#mc-form-error { color: #e53e3e; font-size: 12px; text-align: center; display: none; }
.mc-phone-row { display: flex; gap: 6px; align-items: center; }
.mc-phone-row input { width: auto; flex: 1; }
select.mc-phone-country {
    border: 1px solid #ddd; border-radius: 8px; padding: 9px 6px;
    font-size: 13px; background: #fff; cursor: pointer; outline: none;
    font-family: inherit; color: #333; flex-shrink: 0;
}
select.mc-phone-country:focus { border-color: var(--mc-primary); }
`
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
    }

    // ── Bubble ───────────────────────────────────────────────────────────────

    function renderBubble() {
        if (document.getElementById('mc-bubble')) return
        const bubble = h('button', {
            id: 'mc-bubble',
            'aria-label': 'Abrir chat',
            onClick: onBubbleClick,
        }, svgChat())
        document.body.appendChild(bubble)
    }

    function onBubbleClick() {
        if (state === 'closed') {
            if (contactId) { openChat() } else { openForm() }
        } else {
            closeWidget()
        }
        updateBubbleIcon()
    }

    function updateBubbleIcon() {
        const b = document.getElementById('mc-bubble')
        if (!b) return
        b.innerHTML = state === 'closed' ? svgChat().outerHTML : svgX().outerHTML
    }

    // ── Form ─────────────────────────────────────────────────────────────────

    function openForm() {
        removeWidget()
        state = 'form'

        const nameInput  = h('input', { type: 'text',  placeholder: 'João Silva',       id: 'mc-fname'  })
        const emailInput = h('input', { type: 'email', placeholder: 'joao@email.com',   id: 'mc-femail' })

        // Country selector
        const countrySelect = document.createElement('select')
        countrySelect.id = 'mc-fcountry'
        countrySelect.className = 'mc-phone-country'
        COUNTRIES.forEach(c => {
            const opt = document.createElement('option')
            opt.value = c.code
            opt.textContent = c.flag + ' ' + c.code
            countrySelect.appendChild(opt)
        })

        const phoneInput = h('input', { type: 'tel', placeholder: COUNTRIES[0].ph, id: 'mc-fphone' })

        // Auto-mask while typing
        phoneInput.addEventListener('input', () => {
            const masked = maskPhone(phoneInput.value, countrySelect.value)
            if (phoneInput.value !== masked) phoneInput.value = masked
        })

        // Update placeholder and reformat when country changes
        countrySelect.addEventListener('change', () => {
            const c = COUNTRIES.find(x => x.code === countrySelect.value)
            if (c) phoneInput.placeholder = c.ph
            if (phoneInput.value) phoneInput.value = maskPhone(phoneInput.value, countrySelect.value)
        })

        const errEl     = h('div', { id: 'mc-form-error' })
        const submitBtn = h('button', { id: 'mc-form-submit', type: 'submit' }, 'Iniciar conversa')

        const form = h('form', { id: 'mc-form' },
            h('p', null, cfg.welcomeText),
            h('div', { class: 'mc-input-wrap' }, h('label', { for: 'mc-fname'  }, 'Seu nome'), nameInput),
            h('div', { class: 'mc-input-wrap' }, h('label', { for: 'mc-femail' }, 'E-mail'),   emailInput),
            h('div', { class: 'mc-input-wrap' },
                h('label', { for: 'mc-fphone' }, 'Telefone (opcional)'),
                h('div', { class: 'mc-phone-row' }, countrySelect, phoneInput),
            ),
            errEl,
            submitBtn,
        )

        form.addEventListener('submit', async (e) => {
            e.preventDefault()
            const name  = nameInput.value.trim()
            const email = emailInput.value.trim()
            if (!name || !email) { showFormError('Preencha nome e e-mail.'); return }
            const digits = phoneInput.value.replace(/\D/g, '')
            const phone  = digits ? countrySelect.value + ' ' + phoneInput.value.trim() : ''
            submitBtn.disabled = true
            submitBtn.textContent = 'Aguarde...'
            errEl.style.display = 'none'
            try {
                await startSession(name, email, phone)
            } catch (_) {
                submitBtn.disabled = false
                submitBtn.textContent = 'Iniciar conversa'
                showFormError('Erro ao conectar. Tente novamente.')
            }
        })

        const widget = h('div', { id: 'mc-widget' }, renderHeader(), form)
        document.body.appendChild(widget)
    }

    function showFormError(msg) {
        const el = document.getElementById('mc-form-error')
        if (el) { el.textContent = msg; el.style.display = 'block' }
    }

    // ── Session ──────────────────────────────────────────────────────────────

    async function startSession(name, email, phone) {
        const body = { name, email }
        if (phone) body.phone = phone
        const res = await fetch(apiBase + '/widget/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Widget-Key': apiKey },
            body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('session error')
        const data = await res.json()
        contactId    = data.contactId
        contactName  = data.name
        contactPhone = phone || null
        localStorage.setItem(storageKey, JSON.stringify({ contactId, name: contactName, phone: contactPhone }))
        openChat()
    }

    // ── Chat ─────────────────────────────────────────────────────────────────

    function openChat() {
        removeWidget()
        state = 'chat'

        messagesEl = h('div', { id: 'mc-messages' })

        const input = h('textarea', {
            id: 'mc-input',
            placeholder: 'Escreva uma mensagem...',
            rows: '1',
        })
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                doSend()
            }
        })
        input.addEventListener('input', () => {
            input.style.height = 'auto'
            input.style.height = Math.min(input.scrollHeight, 80) + 'px'
        })

        const sendBtn = h('button', { id: 'mc-send', 'aria-label': 'Enviar', onClick: doSend }, svgSend())

        const inputArea = h('div', { id: 'mc-input-area' }, input, sendBtn)
        const widget = h('div', { id: 'mc-widget' }, renderHeader(), messagesEl, inputArea)
        document.body.appendChild(widget)

        loadHistory()
        connectSse()
    }

    function doSend() {
        const input = document.getElementById('mc-input')
        if (!input) return
        const content = input.value.trim()
        if (!content) return
        input.value = ''
        input.style.height = 'auto'
        sendMessage(content)
    }

    async function loadHistory() {
        try {
            const res = await fetch(apiBase + '/widget/messages', {
                headers: { 'X-Widget-Key': apiKey, 'X-Contact-Id': contactId },
            })
            if (!res.ok) return
            const data = await res.json()
            if (!messagesEl) return
            messagesEl.innerHTML = ''
            if (data.messages.length === 0) {
                messagesEl.appendChild(h('div', { class: 'mc-welcome' }, cfg.welcomeText))
            }
            data.messages.forEach(appendMessage)
        } catch (_) { /* ignore */ }
    }

    function connectSse() {
        if (eventSource) eventSource.close()
        const url = apiBase + '/widget/sse/' + contactId + '?key=' + encodeURIComponent(apiKey)
        eventSource = new EventSource(url)
        eventSource.addEventListener('message', (e) => {
            try {
                const msg = JSON.parse(e.data)
                // SSE só entrega respostas do agente (outbound) — não duplicar mensagens do visitante
                if (msg.direction === 'outbound') appendMessage(msg)
            } catch (_) { /* ignore */ }
        })
        eventSource.onerror = () => {
            // EventSource auto-reconnects; nothing to do
        }
    }

    async function sendMessage(content) {
        // Optimistic UI — mensagem do visitante é 'inbound' no banco, mas exibida à direita no widget
        appendMessage({ direction: 'inbound', content, createdAt: new Date().toISOString(), id: '_tmp_' + Date.now() })
        try {
            await fetch(apiBase + '/widget/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Widget-Key': apiKey,
                    'X-Contact-Id': contactId,
                },
                body: JSON.stringify({ content }),
            })
        } catch (_) { /* ignore — optimistic message stays */ }
    }

    function appendMessage(msg) {
        if (!messagesEl) return
        // No widget, da perspectiva do VISITANTE:
        //   inbound  = mensagem do próprio visitante → direita (roxo)
        //   outbound = resposta do agente            → esquerda (cinza)
        const isVisitor = msg.direction === 'inbound'
        const bubble = h('div', { class: 'mc-msg ' + (isVisitor ? 'mc-msg-outbound' : 'mc-msg-inbound') },
            document.createTextNode(msg.content),
            h('span', { class: 'mc-msg-time' }, fmtTime(msg.createdAt))
        )
        messagesEl.appendChild(bubble)
        messagesEl.scrollTop = messagesEl.scrollHeight
    }

    // ── Close ────────────────────────────────────────────────────────────────

    function closeWidget() {
        if (eventSource) { eventSource.close(); eventSource = null }
        removeWidget()
        state = 'closed'
        messagesEl = null
    }

    function removeWidget() {
        document.getElementById('mc-widget')?.remove()
    }

    // ── Header ───────────────────────────────────────────────────────────────

    function renderHeader() {
        const avatarSrc = cfg.agentAvatarUrl || ''
        const avatarEl = avatarSrc
            ? h('img', { src: avatarSrc, alt: cfg.agentName })
            : h('div', {
                style: {
                    width: '36px', height: '36px', borderRadius: '50%',
                    background: 'rgba(255,255,255,.3)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontWeight: '700', fontSize: '16px',
                }
            }, cfg.agentName.charAt(0).toUpperCase())

        return h('div', { id: 'mc-header' },
            avatarEl,
            h('div', { class: 'mc-agent-info' },
                h('div', { class: 'mc-agent-name' }, cfg.agentName),
                h('div', { class: 'mc-agent-status' }, 'Online'),
            ),
            h('button', { id: 'mc-close', 'aria-label': 'Fechar', onClick: () => { closeWidget(); updateBubbleIcon() } }, '✕'),
        )
    }

    // ── SVG icons ────────────────────────────────────────────────────────────

    function svgChat() {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        s.setAttribute('width', '24'); s.setAttribute('height', '24')
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none')
        s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2')
        s.innerHTML = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
        return s
    }

    function svgX() {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        s.setAttribute('width', '20'); s.setAttribute('height', '20')
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none')
        s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.5')
        s.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
        return s
    }

    function svgSend() {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        s.setAttribute('width', '18'); s.setAttribute('height', '18')
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none')
        s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2')
        s.innerHTML = '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'
        return s
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    async function init() {
        // Restore persisted session
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || 'null')
            if (stored?.contactId) {
                contactId    = stored.contactId
                contactName  = stored.name
                contactPhone = stored.phone || null
            }
        } catch (_) { /* ignore */ }

        await fetchConfig()
        injectStyles()
        renderBubble()

        // Visitante retornando: sessão restaurada, mas não abre automaticamente.
        // O histórico carrega quando o visitante clicar no botão flutuante.
        // (contactId já está definido — onBubbleClick vai direto para openChat)
    }

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init)
    } else {
        init()
    }
})()
