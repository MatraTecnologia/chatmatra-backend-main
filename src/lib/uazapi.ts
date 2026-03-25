// ─── UAZAPI WhatsApp Provider ─────────────────────────────────────────────────
// Tipo de configuração e helper HTTP compartilhados por routes e workers.

export type UazapiConfig = {
    uazapiUrl: string
    uazapiAdminToken: string
    uazapiInstanceToken?: string  // preenchido após POST /instance/init
    instanceName: string
    phone?: string
    profilePictureUrl?: string
}

/**
 * Helper para chamadas à API UAZAPI.
 * Suporta dois modos de autenticação:
 *   - adminToken: header `admintoken` (gestão de instâncias)
 *   - instanceToken: header `token` (operações por instância)
 */
export async function uazapiFetch(
    baseUrl: string,
    path: string,
    auth: { adminToken?: string; instanceToken?: string },
    options: RequestInit = {}
) {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
    }
    if (auth.adminToken) headers['admintoken'] = auth.adminToken
    if (auth.instanceToken) headers['token'] = auth.instanceToken

    const res = await fetch(url, { ...options, headers })
    const text = await res.text()
    try {
        return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
        return { ok: res.ok, status: res.status, data: text }
    }
}
