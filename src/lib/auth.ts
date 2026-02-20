import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { organization, magicLink, emailOTP } from 'better-auth/plugins'
import { prisma } from './prisma.js'
import { sendEmail } from './mail.js'

// Busca template customizado da organização do usuário.
// Substitui {{name}}, {{url}}, {{otp}}, {{logo}}, {{orgName}}, {{domain}} pelo valor real.
async function resolveTemplate(
    userId: string | null,
    type: string,
    vars: Record<string, string>,
    defaultSubject: string,
    defaultHtml: string,
): Promise<{ subject: string; html: string }> {
    let html = defaultHtml
    let subject = defaultSubject
    let organization: { name: string; logo: string | null; domain: string | null } | null = null

    // Tenta buscar template customizado e dados da organização
    if (userId) {
        const member = await prisma.member.findFirst({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            include: { organization: { select: { name: true, logo: true, domain: true } } }
        })
        if (member) {
            organization = member.organization

            const tpl = await prisma.emailTemplate.findUnique({
                where: { organizationId_type: { organizationId: member.organizationId, type } },
            })
            if (tpl) {
                html = tpl.html
                subject = tpl.subject
            }
        }
    }

    // Adiciona variáveis da organização
    const allVars = {
        ...vars,
        '{{orgName}}': organization?.name ?? 'Matra Chat',
        '{{domain}}': organization?.domain ?? process.env.FRONTEND_URL ?? 'matrachat.com',
        '{{logo}}': organization?.logo ?? '',
        '{{logoDisplay}}': organization?.logo ? '' : 'display:none;',
    }

    // SEMPRE substitui as variáveis, mesmo nos templates padrão
    for (const [key, value] of Object.entries(allVars)) {
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
            const defaultHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redefinição de senha</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px 32px;text-align:center;">
            <div style="margin-bottom:16px;{{logoDisplay}}">
                <img src="{{logo}}" alt="{{orgName}}" style="max-width:120px;max-height:60px;border-radius:8px;background:#ffffff;padding:8px;">
            </div>
            <h1 style="margin:16px 0 8px;color:#ffffff;font-size:28px;font-weight:700;">Redefinição de senha</h1>
            <p style="margin:0;color:#e0e7ff;font-size:14px;">{{orgName}}</p>
        </div>
        <div style="padding:40px 32px;">
            <p style="margin:0 0 16px;color:#1a202c;font-size:16px;line-height:1.6;">Olá, <strong>{{name}}</strong>!</p>
            <p style="margin:0 0 24px;color:#4a5568;font-size:16px;line-height:1.6;">Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha.</p>
            <div style="text-align:center;margin:32px 0;">
                <a href="{{url}}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Redefinir senha</a>
            </div>
            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:8px;margin:24px 0;">
                <p style="margin:0;color:#92400e;font-size:14px;line-height:1.6;"><strong>⚠️ Importante:</strong> Este link expira em 1 hora por segurança.</p>
            </div>
            <p style="margin:24px 0 0;color:#718096;font-size:14px;line-height:1.6;">Se você não solicitou a redefinição de senha, ignore este e-mail com segurança. Sua senha permanecerá inalterada.</p>
        </div>
        <div style="padding:24px 32px;background:#f9fafb;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#718096;font-size:12px;">© {{orgName}} · {{domain}}</p>
        </div>
    </div>
</body>
</html>`
            const { subject, html } = await resolveTemplate(user.id, 'reset-password', { '{{name}}': user.name, '{{url}}': url }, 'Redefinição de senha - {{orgName}}', defaultHtml)
            await sendEmail({ to: user.email, subject, html })
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
            const defaultHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verificação de e-mail</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#10b981 0%,#059669 100%);padding:40px 32px;text-align:center;">
            <div style="margin-bottom:16px;{{logoDisplay}}">
                <img src="{{logo}}" alt="{{orgName}}" style="max-width:120px;max-height:60px;border-radius:8px;background:#ffffff;padding:8px;">
            </div>
            <h1 style="margin:16px 0 8px;color:#ffffff;font-size:28px;font-weight:700;">Bem-vindo!</h1>
            <p style="margin:0;color:#d1fae5;font-size:14px;">{{orgName}}</p>
        </div>
        <div style="padding:40px 32px;">
            <p style="margin:0 0 16px;color:#1a202c;font-size:16px;line-height:1.6;">Olá, <strong>{{name}}</strong>!</p>
            <p style="margin:0 0 24px;color:#4a5568;font-size:16px;line-height:1.6;">Obrigado por se cadastrar! Para começar a usar sua conta, precisamos verificar seu endereço de e-mail.</p>
            <div style="text-align:center;margin:32px 0;">
                <a href="{{url}}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Verificar e-mail</a>
            </div>
            <div style="background:#dbeafe;border-left:4px solid #3b82f6;padding:16px;border-radius:8px;margin:24px 0;">
                <p style="margin:0;color:#1e40af;font-size:14px;line-height:1.6;"><strong>💡 Dica:</strong> Ao verificar seu e-mail, você terá acesso completo a todos os recursos da plataforma.</p>
            </div>
            <p style="margin:24px 0 0;color:#718096;font-size:14px;line-height:1.6;">Se você não criou uma conta, ignore este e-mail com segurança.</p>
        </div>
        <div style="padding:24px 32px;background:#f9fafb;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#718096;font-size:12px;">© {{orgName}} · {{domain}}</p>
        </div>
    </div>
</body>
</html>`
            const { subject, html } = await resolveTemplate(user.id, 'verification', { '{{name}}': user.name, '{{url}}': url }, 'Verifique seu e-mail - {{orgName}}', defaultHtml)
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
                const defaultHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Link de acesso</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:40px 32px;text-align:center;">
            <div style="margin-bottom:16px;{{logoDisplay}}">
                <img src="{{logo}}" alt="{{orgName}}" style="max-width:120px;max-height:60px;border-radius:8px;background:#ffffff;padding:8px;">
            </div>
            <h1 style="margin:16px 0 8px;color:#ffffff;font-size:28px;font-weight:700;">Link de acesso rápido</h1>
            <p style="margin:0;color:#e0e7ff;font-size:14px;">{{orgName}}</p>
        </div>
        <div style="padding:40px 32px;">
            <p style="margin:0 0 24px;color:#4a5568;font-size:16px;line-height:1.6;">Clique no botão abaixo para acessar sua conta de forma segura e rápida, sem precisar de senha.</p>
            <div style="text-align:center;margin:32px 0;">
                <a href="{{url}}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Entrar agora</a>
            </div>
            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:8px;margin:24px 0;">
                <p style="margin:0;color:#92400e;font-size:14px;line-height:1.6;"><strong>⏱️ Atenção:</strong> Este link expira em 15 minutos por segurança.</p>
            </div>
            <p style="margin:24px 0 0;color:#718096;font-size:14px;line-height:1.6;">Se você não solicitou este link, ignore este e-mail com segurança.</p>
        </div>
        <div style="padding:24px 32px;background:#f9fafb;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#718096;font-size:12px;">© {{orgName}} · {{domain}}</p>
        </div>
    </div>
</body>
</html>`
                const { subject, html } = await resolveTemplate(user?.id ?? null, 'magic-link', { '{{url}}': url }, 'Seu link de acesso - {{orgName}}', defaultHtml)
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
                    'sign-in':            'Seu código de acesso - {{orgName}}',
                    'email-verification': 'Verifique seu e-mail - {{orgName}}',
                    'forget-password':    'Redefinição de senha - {{orgName}}',
                }
                const defaultHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Código de verificação</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:40px 32px;text-align:center;">
            <div style="margin-bottom:16px;{{logoDisplay}}">
                <img src="{{logo}}" alt="{{orgName}}" style="max-width:120px;max-height:60px;border-radius:8px;background:#ffffff;padding:8px;">
            </div>
            <h1 style="margin:16px 0 8px;color:#ffffff;font-size:28px;font-weight:700;">Código de verificação</h1>
            <p style="margin:0;color:#fef3c7;font-size:14px;">{{orgName}}</p>
        </div>
        <div style="padding:40px 32px;">
            <p style="margin:0 0 24px;color:#4a5568;font-size:16px;line-height:1.6;">Use o código abaixo para continuar. Ele expira em 10 minutos por segurança.</p>
            <div style="text-align:center;margin:32px 0;">
                <div style="display:inline-block;background:linear-gradient(135deg,#f4f4f5 0%,#e5e7eb 100%);padding:24px 32px;border-radius:12px;border:2px solid #d1d5db;">
                    <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#1a202c;font-family:'Courier New',monospace;">{{otp}}</div>
                </div>
            </div>
            <div style="background:#dbeafe;border-left:4px solid #3b82f6;padding:16px;border-radius:8px;margin:24px 0;">
                <p style="margin:0;color:#1e40af;font-size:14px;line-height:1.6;"><strong>🔐 Segurança:</strong> Nunca compartilhe este código com ninguém. Nossa equipe nunca solicitará este código.</p>
            </div>
            <p style="margin:24px 0 0;color:#718096;font-size:14px;line-height:1.6;">Se você não solicitou este código, ignore este e-mail com segurança.</p>
        </div>
        <div style="padding:24px 32px;background:#f9fafb;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#718096;font-size:12px;">© {{orgName}} · {{domain}}</p>
        </div>
    </div>
</body>
</html>`
                const { subject, html } = await resolveTemplate(user?.id ?? null, templateTypeMap[type] ?? 'otp-sign-in', { '{{otp}}': otp }, defaultSubjects[type] ?? 'Seu código - {{orgName}}', defaultHtml)
                await sendEmail({
                    to: email,
                    subject,
                    html,
                })
            },
        }),
    ],
})
