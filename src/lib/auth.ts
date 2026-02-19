import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { organization, magicLink, emailOTP } from 'better-auth/plugins'
import { prisma } from './prisma.js'
import { sendEmail } from './mail.js'

// Busca template customizado da organização do usuário.
// Substitui {{name}}, {{url}}, {{otp}} pelo valor real.
async function resolveTemplate(
    userId: string | null,
    type: string,
    vars: Record<string, string>,
    defaultSubject: string,
    defaultHtml: string,
): Promise<{ subject: string; html: string }> {
    let html = defaultHtml
    let subject = defaultSubject

    // Tenta buscar template customizado da organização
    if (userId) {
        const member = await prisma.member.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } })
        if (member) {
            const tpl = await prisma.emailTemplate.findUnique({
                where: { organizationId_type: { organizationId: member.organizationId, type } },
            })
            if (tpl) {
                html = tpl.html
                subject = tpl.subject
            }
        }
    }

    // SEMPRE substitui as variáveis, mesmo nos templates padrão
    for (const [key, value] of Object.entries(vars)) {
        html    = html.replaceAll(key, value)
        subject = subject.replaceAll(key, value)
    }

    return { subject, html }
}

export const auth = betterAuth({
    basePath: '/auth',
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3333',
    database: prismaAdapter(prisma, {
        provider: 'postgresql',
    }),
    advanced: {
        // Seta o cookie no domínio pai (ex: .matratecnologia.com) para que
        // tanto o frontend quanto o backend possam ler a sessão
        crossSubDomainCookies: {
            enabled: !!process.env.COOKIE_DOMAIN,
            domain: process.env.COOKIE_DOMAIN,
        },
    },
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
            const defaultHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2>Olá, {{name}}!</h2><p>Recebemos uma solicitação para redefinir a senha da sua conta no <strong>Matra Chat</strong>.</p><p>Clique no botão abaixo para criar uma nova senha. O link expira em 1 hora.</p><a href="{{url}}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Redefinir senha</a><p style="margin-top:16px;color:#666;font-size:12px;">Se você não solicitou a redefinição de senha, ignore este e-mail.</p></div>`
            const { subject, html } = await resolveTemplate(user.id, 'reset-password', { '{{name}}': user.name, '{{url}}': url }, 'Redefinição de senha - Matra Chat', defaultHtml)
            await sendEmail({ to: user.email, subject, html })
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
            const defaultHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2>Olá, {{name}}!</h2><p>Clique no botão abaixo para verificar seu e-mail e ativar sua conta no <strong>Matra Chat</strong>.</p><a href="{{url}}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Verificar e-mail</a><p style="margin-top:16px;color:#666;font-size:12px;">Se você não criou uma conta, ignore este e-mail.</p></div>`
            const { subject, html } = await resolveTemplate(user.id, 'verification', { '{{name}}': user.name, '{{url}}': url }, 'Verifique seu e-mail - Matra Chat', defaultHtml)
            await sendEmail({ to: user.email, subject, html })
        },
    },
    // Em multi-tenant, cada subdomínio (a.matratecnologia.com, b.matratecnologia.com)
    // faz chamadas à API. A função recebe o Request e retorna a lista de origens
    // confiáveis — se a origem da request bater com BASE_DOMAIN, é adicionada
    // dinamicamente sem precisar listar cada tenant.
    trustedOrigins: async (request) => {
        const defaults = [
            process.env.BETTER_AUTH_URL ?? 'http://localhost:3333',
            process.env.FRONTEND_URL    ?? 'http://localhost:3000',
        ]
        const baseDomain = process.env.BASE_DOMAIN
        const origin     = request?.headers?.get('origin')
        if (origin && baseDomain) {
            try {
                const { hostname } = new URL(origin)
                if (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)) {
                    return [...defaults, origin]
                }
            } catch { /* origin inválida */ }
        }
        return defaults
    },
    plugins: [
        organization({
            allowUserToCreateOrganization: true,
        }),
        magicLink({
            sendMagicLink: async ({ email, url }) => {
                // Magic link não tem userId direto — busca pelo email
                const user = await prisma.user.findUnique({ where: { email } })
                const defaultHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2>Acesse o Matra Chat</h2><p>Clique no botão abaixo para entrar na sua conta. O link expira em 15 minutos.</p><a href="{{url}}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Entrar agora</a><p style="margin-top:16px;color:#666;font-size:12px;">Se você não solicitou este link, ignore este e-mail.</p></div>`
                const { subject, html } = await resolveTemplate(user?.id ?? null, 'magic-link', { '{{url}}': url }, 'Seu link de acesso - Matra Chat', defaultHtml)
                await sendEmail({ to: email, subject, html })
            },
        }),
        emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
                const user = await prisma.user.findUnique({ where: { email } })
                const templateTypeMap: Record<string, string> = {
                    'sign-in':            'otp-sign-in',
                    'email-verification': 'otp-verification',
                    'forget-password':    'otp-forget-password',
                }
                const defaultSubjects: Record<string, string> = {
                    'sign-in':            'Seu código de acesso - Matra Chat',
                    'email-verification': 'Verifique seu e-mail - Matra Chat',
                    'forget-password':    'Redefinição de senha - Matra Chat',
                }
                const defaultHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2>Seu código de verificação</h2><p>Use o código abaixo para acessar o <strong>Matra Chat</strong>. Ele expira em 10 minutos.</p><div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:24px;background:#f4f4f5;border-radius:8px;margin:16px 0;">{{otp}}</div><p style="color:#666;font-size:12px;">Se você não solicitou este código, ignore este e-mail.</p></div>`
                const { subject, html } = await resolveTemplate(user?.id ?? null, templateTypeMap[type] ?? 'otp-sign-in', { '{{otp}}': otp }, defaultSubjects[type] ?? 'Seu código - Matra Chat', defaultHtml)
                await sendEmail({
                    to: email,
                    subject,
                    html,
                })
            },
        }),
    ],
})
