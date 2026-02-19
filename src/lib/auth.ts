import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { organization, magicLink, emailOTP } from 'better-auth/plugins'
import { prisma } from './prisma.js'
import { sendEmail } from './mail.js'

export const auth = betterAuth({
    basePath: '/auth',
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3333',
    database: prismaAdapter(prisma, {
        provider: 'postgresql',
    }),
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
            await sendEmail({
                to: user.email,
                subject: 'Redefinição de senha - Matra Chat',
                html: `
                    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                        <h2>Olá, ${user.name}!</h2>
                        <p>Recebemos uma solicitação para redefinir a senha da sua conta no <strong>Matra Chat</strong>.</p>
                        <p>Clique no botão abaixo para criar uma nova senha. O link expira em 1 hora.</p>
                        <a href="${url}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
                            Redefinir senha
                        </a>
                        <p style="margin-top:16px;color:#666;font-size:12px;">
                            Se você não solicitou a redefinição de senha, ignore este e-mail.
                        </p>
                    </div>
                `,
            })
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
            await sendEmail({
                to: user.email,
                subject: 'Verifique seu e-mail - Matra Chat',
                html: `
                    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                        <h2>Olá, ${user.name}!</h2>
                        <p>Clique no botão abaixo para verificar seu e-mail e ativar sua conta no <strong>Matra Chat</strong>.</p>
                        <a href="${url}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
                            Verificar e-mail
                        </a>
                        <p style="margin-top:16px;color:#666;font-size:12px;">
                            Se você não criou uma conta, ignore este e-mail.
                        </p>
                    </div>
                `,
            })
        },
    },
    trustedOrigins: [
        process.env.BETTER_AUTH_URL ?? 'http://localhost:3333',
        process.env.FRONTEND_URL ?? 'http://localhost:3000',
    ],
    plugins: [
        organization({
            allowUserToCreateOrganization: true,
        }),
        magicLink({
            sendMagicLink: async ({ email, url }) => {
                await sendEmail({
                    to: email,
                    subject: 'Seu link de acesso - Matra Chat',
                    html: `
                        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                            <h2>Acesse o Matra Chat</h2>
                            <p>Clique no botão abaixo para entrar na sua conta. O link expira em 15 minutos.</p>
                            <a href="${url}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
                                Entrar agora
                            </a>
                            <p style="margin-top:16px;color:#666;font-size:12px;">
                                Se você não solicitou este link, ignore este e-mail.
                            </p>
                        </div>
                    `,
                })
            },
        }),
        emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
                const subjects: Record<string, string> = {
                    'sign-in': 'Seu código de acesso - Matra Chat',
                    'email-verification': 'Verifique seu e-mail - Matra Chat',
                    'forget-password': 'Redefinição de senha - Matra Chat',
                }
                await sendEmail({
                    to: email,
                    subject: subjects[type] ?? 'Seu código - Matra Chat',
                    html: `
                        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                            <h2>Seu código de verificação</h2>
                            <p>Use o código abaixo para acessar o <strong>Matra Chat</strong>. Ele expira em 10 minutos.</p>
                            <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:24px;background:#f4f4f5;border-radius:8px;margin:16px 0;">
                                ${otp}
                            </div>
                            <p style="color:#666;font-size:12px;">
                                Se você não solicitou este código, ignore este e-mail.
                            </p>
                        </div>
                    `,
                })
            },
        }),
    ],
})
