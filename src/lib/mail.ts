import 'dotenv/config'
import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
})

export async function sendEmail({
    to,
    subject,
    html,
}: {
    to: string
    subject: string
    html: string
}) {
    await transporter.sendMail({
        from: process.env.SMTP_FROM ?? `"Matra Chat" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html,
    })
}

export async function sendEmailVerificationConfirmation(email: string) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    await sendEmail({
        to: email,
        subject: 'E-mail verificado com sucesso! - MatraChat',
        html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>E-mail Verificado</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px 8px 0 0;">
                            <div style="width: 80px; height: 80px; background: white; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 48px;">
                                ✓
                            </div>
                            <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700;">E-mail Verificado!</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px;">
                            <p style="margin: 0 0 20px; color: #1a202c; font-size: 16px; line-height: 1.6;">
                                Olá!
                            </p>
                            <p style="margin: 0 0 20px; color: #4a5568; font-size: 16px; line-height: 1.6;">
                                Seu e-mail foi verificado com sucesso! Agora você tem acesso completo à sua conta no <strong>MatraChat</strong>.
                            </p>

                            <!-- Success Box -->
                            <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 16px; border-radius: 4px; margin: 24px 0;">
                                <p style="margin: 0; color: #065f46; font-size: 14px; line-height: 1.6;">
                                    <strong>✓ Conta ativada</strong><br>
                                    Você já pode fazer login e aproveitar todos os recursos da plataforma.
                                </p>
                            </div>

                            <p style="margin: 24px 0; text-align: center;">
                                <a href="${frontendUrl}/login" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                                    Acessar MatraChat
                                </a>
                            </p>

                            <p style="margin: 24px 0 0; color: #718096; font-size: 14px; line-height: 1.6;">
                                Se você não solicitou esta verificação, por favor ignore este e-mail ou entre em contato com nosso suporte.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px 40px; background: #f7fafc; border-top: 1px solid #e2e8f0; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0; color: #718096; font-size: 14px; text-align: center;">
                                <strong>MatraChat</strong> - Comunicação inteligente<br>
                                <span style="font-size: 12px;">Este é um e-mail automático, por favor não responda.</span>
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `,
    })
}
