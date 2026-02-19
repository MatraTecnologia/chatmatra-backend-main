// ── Logger colorido com ANSI escape codes ─────────────────────────────────────
// Sem dependências externas. Funciona em qualquer terminal que suporte ANSI.

const R  = '\x1b[0m'   // reset
const B  = '\x1b[1m'   // bold
const DM = '\x1b[2m'   // dim

const c = {
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
    gray:    '\x1b[90m',
    white:   '\x1b[97m',
}

function timestamp() {
    const now = new Date()
    const hh  = String(now.getHours()).padStart(2, '0')
    const mm  = String(now.getMinutes()).padStart(2, '0')
    const ss  = String(now.getSeconds()).padStart(2, '0')
    const ms  = String(now.getMilliseconds()).padStart(3, '0')
    return `${DM}${hh}:${mm}:${ss}.${ms}${R}`
}

function label(color: string, text: string) {
    return `${B}${color}[${text}]${R}`
}

function fmt(...args: unknown[]): string {
    return args.map((a) =>
        typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)
    ).join(' ')
}

export const log = {
    /** Informação geral — ciano */
    info: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.cyan, 'INFO')}    ${fmt(...args)}`),

    /** Sucesso / operação OK — verde */
    ok: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.green, 'OK')}      ${c.green}${fmt(...args)}${R}`),

    /** Aviso — amarelo */
    warn: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.yellow, 'WARN')}   ${c.yellow}${fmt(...args)}${R}`),

    /** Erro — vermelho */
    error: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.red, 'ERROR')}  ${c.red}${fmt(...args)}${R}`),

    /** Evento de mensagem — amarelo */
    msg: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.yellow, 'MSG')}    ${fmt(...args)}`),

    /** Operação de tag / etiqueta — magenta */
    tag: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.magenta, 'TAG')}    ${c.magenta}${fmt(...args)}${R}`),

    /** Sync WhatsApp — verde brilhante */
    wa: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.green, 'WA')}      ${fmt(...args)}`),

    /** Webhook recebido — azul */
    webhook: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.blue, 'WEBHOOK')} ${fmt(...args)}`),

    /** SSE event — ciano */
    sse: (...args: unknown[]) =>
        console.log(`${timestamp()} ${label(c.cyan, 'SSE')}    ${DM}${fmt(...args)}${R}`),

    /** Divisor visual */
    divider: (title?: string) => {
        const bar = '─'.repeat(60)
        if (title) {
            console.log(`${c.gray}${bar}${R} ${B}${title}${R}`)
        } else {
            console.log(`${c.gray}${bar}${R}`)
        }
    },
}
