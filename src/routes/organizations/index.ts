import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { auth } from '../../lib/auth.js'
import { sendEmail } from '../../lib/mail.js'
import { log } from '../../lib/logger.js'

export default async function (app: FastifyInstance) {
    // GET /organizations/check-domain?domain=empresa.com.br — público, sem autenticação
    app.get('/check-domain', {
        schema: {
            tags: ['Organizations'],
            summary: 'Verifica se existe uma organização cadastrada para o domínio',
            querystring: {
                type: 'object',
                required: ['domain'],
                properties: { domain: { type: 'string' } },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        exists: { type: 'boolean' },
                        organization: {
                            type: 'object',
                            nullable: true,
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                slug: { type: 'string', nullable: true },
                                logo: { type: 'string', nullable: true },
                            },
                        },
                    },
                },
            },
        },
    }, async (request) => {
        const { domain } = request.query as { domain: string }

        const org = await prisma.organization.findUnique({
            where: { domain: domain.toLowerCase().trim() },
            select: { id: true, name: true, slug: true, logo: true },
        })

        return { exists: !!org, organization: org ?? null }
    })

    // POST /organizations/public - cadastro público de organização (onboarding, sem login)
    app.post('/public', {
        schema: {
            tags: ['Organizations'],
            summary: 'Cadastra uma nova organização (onboarding público)',
            body: {
                type: 'object',
                required: ['name', 'domain'],
                properties: {
                    name: { type: 'string', minLength: 2 },
                    domain: { type: 'string', minLength: 3 },
                },
            },
        },
    }, async (request, reply) => {
        const { name, domain } = request.body as { name: string; domain: string }
        const cleanDomain = domain.toLowerCase().trim()

        const existing = await prisma.organization.findUnique({ where: { domain: cleanDomain } })
        if (existing) {
            return reply.status(409).send({ error: 'Já existe uma organização com este domínio.' })
        }

        const org = await prisma.organization.create({
            data: {
                name,
                domain: cleanDomain,
                slug: cleanDomain.replace(/\./g, '-'),
            },
        })

        return reply.status(201).send(org)
    })

    // GET /organizations/check-member?email=X&orgId=Y — público
    // Verifica se um e-mail já é membro da organização
    app.get('/check-member', {
        schema: {
            tags: ['Organizations'],
            summary: 'Verifica se um e-mail já é membro de uma organização',
            querystring: {
                type: 'object',
                required: ['email', 'orgId'],
                properties: {
                    email: { type: 'string' },
                    orgId: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        isMember: { type: 'boolean' },
                        userExists: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request) => {
        const { email, orgId } = request.query as { email: string; orgId: string }

        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } })
        if (!user) return { isMember: false, userExists: false }

        const member = await prisma.member.findFirst({
            where: { organizationId: orgId, userId: user.id },
        })

        return { isMember: !!member, userExists: true }
    })

    // POST /organizations/:id/join — requer autenticação
    // Vincula o usuário autenticado à organização (idempotente)
    app.post('/:id/join', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Vincula o usuário autenticado à organização',
            params: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const org = await prisma.organization.findUnique({ where: { id } })
        if (!org) return reply.status(404).send({ error: 'Organização não encontrada.' })

        // Idempotente: se já for membro, retorna o membro existente
        const existing = await prisma.member.findFirst({
            where: { organizationId: id, userId },
        })
        if (existing) return reply.send({ member: existing })

        const member = await prisma.member.create({
            data: { organizationId: id, userId, role: 'member' },
        })

        return reply.status(201).send({ member })
    })

    // GET /organizations - lista as organizações do usuário
    app.get('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Lista as organizações do usuário autenticado',
        },
    }, async (request) => {
        const userId = request.session.user.id

        return prisma.organization.findMany({
            where: { members: { some: { userId } } },
            include: { members: { select: { role: true, user: { select: { id: true, name: true, email: true } } } } },
        })
    })

    // POST /organizations - criar organização
    app.post('/', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Cria uma nova organização',
            body: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', minLength: 2 },
                    slug: { type: 'string' },
                    logo: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { name, slug, logo } = request.body as { name: string; slug?: string; logo?: string }
        const userId = request.session.user.id

        const org = await prisma.organization.create({
            data: {
                name,
                slug: slug ?? name.toLowerCase().replace(/\s+/g, '-'),
                logo,
                members: {
                    create: { userId, role: 'owner' },
                },
            },
        })

        return reply.status(201).send(org)
    })

    // GET /organizations/:id - detalhes de uma organização
    app.get('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Retorna os detalhes de uma organização',
            params: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const org = await prisma.organization.findFirst({
            where: { id, members: { some: { userId } } },
            include: {
                members: {
                    select: {
                        id: true,
                        role: true,
                        user: { select: { id: true, name: true, email: true, image: true } },
                    },
                },
            },
        })

        if (!org) return reply.status(404).send({ error: 'Organização não encontrada.' })

        return org
    })

    // PATCH /organizations/:id - atualizar organização (owner/admin)
    app.patch('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Atualiza uma organização',
            params: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
            body: {
                type: 'object',
                properties: {
                    name:         { type: 'string' },
                    logo:         { type: 'string' },
                    fbAppId:      { type: 'string', nullable: true },
                    fbAppSecret:  { type: 'string', nullable: true },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const member = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })

        if (!member) return reply.status(403).send({ error: 'Sem permissão.' })

        const { name, logo, fbAppId, fbAppSecret } = request.body as {
            name?: string
            logo?: string
            fbAppId?: string | null
            fbAppSecret?: string | null
        }

        return prisma.organization.update({
            where: { id },
            data: {
                ...(name        !== undefined && { name }),
                ...(logo        !== undefined && { logo }),
                ...(fbAppId     !== undefined && { fbAppId }),
                ...(fbAppSecret !== undefined && { fbAppSecret }),
            },
        })
    })

    // DELETE /organizations/:id - deletar organização (owner)
    app.delete('/:id', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Deleta uma organização',
            params: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const member = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: 'owner' },
        })

        if (!member) return reply.status(403).send({ error: 'Apenas o owner pode deletar a organização.' })

        await prisma.organization.delete({ where: { id } })

        return reply.status(204).send()
    })

    // GET /organizations/:id/members - listar membros
    app.get('/:id/members', {
        preHandler: requireAuth,
        schema: {
            tags: ['Organizations'],
            summary: 'Lista os membros de uma organização',
            params: {
                type: 'object',
                properties: { id: { type: 'string' } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const isMember = await prisma.member.findFirst({ where: { organizationId: id, userId } })
        if (!isMember) return reply.status(403).send({ error: 'Sem permissão.' })

        return prisma.member.findMany({
            where: { organizationId: id },
            select: {
                id: true,
                role: true,
                createdAt: true,
                user: { select: { id: true, name: true, email: true, image: true } },
            },
        })
    })

    // DELETE /organizations/:id/members/:memberId - remover membro
    app.delete('/:id/members/:memberId', {
        preHandler: requireAuth,
        schema: {
            summary: 'Remove um membro da organização',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    memberId: { type: 'string' },
                },
            },
        } as never,
    }, async (request, reply) => {
        const { id, memberId } = request.params as { id: string; memberId: string }
        const userId = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const target = await prisma.member.findUnique({ where: { id: memberId } })
        if (!target) return reply.status(404).send({ error: 'Membro não encontrado.' })
        if (target.role === 'owner') return reply.status(403).send({ error: 'Não é possível remover o owner.' })

        await prisma.member.delete({ where: { id: memberId, organizationId: id } })
        log.info(`Membro ${memberId} removido da org ${id} por ${userId}`)
        return reply.status(204).send()
    })

    // PATCH /organizations/:id/members/:memberId — alterar role / papel personalizado
    app.patch('/:id/members/:memberId', {
        preHandler: requireAuth,
        schema: {
            summary: 'Altera o papel de um membro',
            params: { type: 'object', properties: { id: { type: 'string' }, memberId: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    role:         { type: 'string', enum: ['admin', 'agent', 'member'] },
                    customRoleId: { type: 'string', nullable: true },
                },
            },
        } as never,
    }, async (request, reply) => {
        const { id, memberId } = request.params as { id: string; memberId: string }
        const body             = request.body as { role?: string; customRoleId?: string | null }
        const userId           = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const target = await prisma.member.findUnique({ where: { id: memberId } })
        if (!target) return reply.status(404).send({ error: 'Membro não encontrado.' })
        if (target.role === 'owner') return reply.status(403).send({ error: 'Não é possível alterar o role do owner.' })

        // Admin não pode promover para admin (somente owner pode)
        if (requester.role === 'admin' && body.role === 'admin') {
            return reply.status(403).send({ error: 'Apenas o owner pode promover para admin.' })
        }

        const updateData: Record<string, unknown> = {}
        if (body.role         !== undefined) updateData.role         = body.role
        if (body.customRoleId !== undefined) updateData.customRoleId = body.customRoleId ?? null

        const updated = await (prisma as any).member.update({ where: { id: memberId }, data: updateData })
        log.info(`Papel de ${memberId} atualizado na org ${id}`)
        return reply.send(updated)
    })

    // POST /organizations/:id/invite — convidar membro por e-mail
    app.post('/:id/invite', {
        preHandler: requireAuth,
        schema: {
            summary: 'Convida um usuário para a organização',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['email'],
                properties: {
                    email: { type: 'string' },
                    name:  { type: 'string' },
                    role:  { type: 'string', enum: ['admin', 'agent', 'member'], default: 'agent' },
                },
            },
        } as never,
    }, async (request, reply) => {
        const { id }                           = request.params as { id: string }
        const { email, name, role = 'agent' }  = request.body as { email: string; name?: string; role?: string }
        const userId                  = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const org = await prisma.organization.findUnique({ where: { id }, select: { name: true } })
        if (!org) return reply.status(404).send({ error: 'Organização não encontrada.' })

        const cleanEmail = email.toLowerCase().trim()

        // Busca usuário existente
        let user = await prisma.user.findUnique({ where: { email: cleanEmail } })

        if (user) {
            // Verifica se já é membro
            const existing = await prisma.member.findFirst({ where: { organizationId: id, userId: user.id } })
            if (existing) return reply.status(409).send({ error: 'Usuário já é membro desta organização.' })

            // Adiciona como membro
            const member = await prisma.member.create({ data: { organizationId: id, userId: user.id, role } })

            // Envia e-mail de boas-vindas
            const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '')
            await sendEmail({
                to: cleanEmail,
                subject: `Você foi adicionado a ${org.name} — Matra Chat`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                        <h2>Olá, ${user.name}!</h2>
                        <p>Você foi adicionado à organização <strong>${org.name}</strong> no <strong>Matra Chat</strong>.</p>
                        <a href="${frontendUrl}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
                            Acessar agora
                        </a>
                    </div>
                `,
            }).catch(() => null)

            log.ok(`Membro existente ${cleanEmail} adicionado à org ${id} com role="${role}"`)
            return reply.status(201).send({ member, isNewUser: false })
        }

        // Usuário não existe — cria conta com senha temporária aleatória
        const tempPassword = crypto.randomBytes(16).toString('hex')
        const frontendUrl  = (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '')

        // Cria via betterAuth para garantir hashing e verificação
        const signUpRes = await auth.api.signUpEmail({
            body: {
                name:     name?.trim() || cleanEmail.split('@')[0],
                email:    cleanEmail,
                password: tempPassword,
            },
        }).catch(() => null)

        if (!signUpRes) {
            return reply.status(502).send({ error: 'Falha ao criar conta do usuário convidado.' })
        }

        user = await prisma.user.findUnique({ where: { email: cleanEmail } })
        if (!user) return reply.status(502).send({ error: 'Usuário não encontrado após criação.' })

        const member = await prisma.member.create({ data: { organizationId: id, userId: user.id, role } })

        // Envia e-mail de convite com link de redefinição de senha
        await auth.api.requestPasswordReset({
            body: { email: cleanEmail, redirectTo: `${frontendUrl}/reset-password` },
        }).catch(() => null)

        log.ok(`Novo usuário ${cleanEmail} criado e adicionado à org ${id} com role="${role}"`)
        return reply.status(201).send({ member, isNewUser: true })
    })

    // POST /organizations/:id/members/:memberId/send-reset-password
    app.post('/:id/members/:memberId/send-reset-password', {
        preHandler: requireAuth,
        schema: {
            summary: 'Envia e-mail de redefinição de senha para um membro',
            params: { type: 'object', properties: { id: { type: 'string' }, memberId: { type: 'string' } } },
        } as never,
    }, async (request, reply) => {
        const { id, memberId } = request.params as { id: string; memberId: string }
        const userId           = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const target = await prisma.member.findUnique({
            where: { id: memberId },
            include: { user: { select: { email: true } } },
        })
        if (!target) return reply.status(404).send({ error: 'Membro não encontrado.' })

        const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '')
        await auth.api.requestPasswordReset({
            body: { email: target.user.email, redirectTo: `${frontendUrl}/reset-password` },
        }).catch(() => null)

        log.info(`Reset password enviado para ${target.user.email}`)
        return reply.send({ ok: true })
    })

    // POST /organizations/:id/members/:memberId/send-verification
    app.post('/:id/members/:memberId/send-verification', {
        preHandler: requireAuth,
        schema: {
            summary: 'Reenvia e-mail de verificação para um membro',
            params: { type: 'object', properties: { id: { type: 'string' }, memberId: { type: 'string' } } },
        } as never,
    }, async (request, reply) => {
        const { id, memberId } = request.params as { id: string; memberId: string }
        const userId           = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const target = await prisma.member.findUnique({
            where: { id: memberId },
            include: { user: { select: { email: true, emailVerified: true } } },
        })
        if (!target) return reply.status(404).send({ error: 'Membro não encontrado.' })
        if (target.user.emailVerified) return reply.status(409).send({ error: 'E-mail já verificado.' })

        await auth.api.sendVerificationEmail({
            body: { email: target.user.email },
        }).catch(() => null)

        log.info(`Verificação de e-mail reenviada para ${target.user.email}`)
        return reply.send({ ok: true })
    })

    // ─── CUSTOM ROLES ─────────────────────────────────────────────────────────

    // GET /organizations/:id/roles — lista papéis personalizados
    app.get('/:id/roles', {
        preHandler: requireAuth,
        schema: {
            summary: 'Lista papéis personalizados da organização',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        } as never,
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const member = await prisma.member.findFirst({ where: { organizationId: id, userId } })
        if (!member) return reply.status(403).send({ error: 'Sem permissão.' })

        const roles = await (prisma as any).customRole.findMany({
            where: { organizationId: id },
            orderBy: { createdAt: 'asc' },
            include: { _count: { select: { members: true } } },
        })

        return reply.send(roles)
    })

    // POST /organizations/:id/roles — cria papel personalizado
    app.post('/:id/roles', {
        preHandler: requireAuth,
        schema: {
            summary: 'Cria papel personalizado',
            params: { type: 'object', properties: { id: { type: 'string' } } },
            body: {
                type: 'object',
                required: ['name', 'permissions'],
                properties: {
                    name:        { type: 'string', minLength: 1 },
                    description: { type: 'string' },
                    color:       { type: 'string' },
                    permissions: { type: 'object' },
                },
            },
        } as never,
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id
        const body   = request.body as {
            name: string; description?: string; color?: string
            permissions: Record<string, boolean>
        }

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const role = await (prisma as any).customRole.create({
            data: {
                organizationId: id,
                name:        body.name,
                description: body.description ?? null,
                color:       body.color ?? '#6366f1',
                permissions: body.permissions,
            },
        })

        log.ok(`Papel "${body.name}" criado na org ${id}`)
        return reply.status(201).send(role)
    })

    // PATCH /organizations/:id/roles/:roleId — atualiza papel personalizado
    app.patch('/:id/roles/:roleId', {
        preHandler: requireAuth,
        schema: {
            summary: 'Atualiza papel personalizado',
            params: { type: 'object', properties: { id: { type: 'string' }, roleId: { type: 'string' } } },
            body: {
                type: 'object',
                properties: {
                    name:        { type: 'string', minLength: 1 },
                    description: { type: 'string' },
                    color:       { type: 'string' },
                    permissions: { type: 'object' },
                },
            },
        } as never,
    }, async (request, reply) => {
        const { id, roleId } = request.params as { id: string; roleId: string }
        const userId         = request.session.user.id
        const body           = request.body as {
            name?: string; description?: string; color?: string
            permissions?: Record<string, boolean>
        }

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const existing = await (prisma as any).customRole.findFirst({ where: { id: roleId, organizationId: id } })
        if (!existing) return reply.status(404).send({ error: 'Papel não encontrado.' })

        const updated = await (prisma as any).customRole.update({
            where: { id: roleId },
            data: {
                ...(body.name        !== undefined && { name:        body.name }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.color       !== undefined && { color:       body.color }),
                ...(body.permissions !== undefined && { permissions: body.permissions }),
            },
        })

        log.ok(`Papel ${roleId} atualizado na org ${id}`)
        return reply.send(updated)
    })

    // DELETE /organizations/:id/roles/:roleId — remove papel personalizado
    app.delete('/:id/roles/:roleId', {
        preHandler: requireAuth,
        schema: {
            summary: 'Remove papel personalizado',
            params: { type: 'object', properties: { id: { type: 'string' }, roleId: { type: 'string' } } },
        } as never,
    }, async (request, reply) => {
        const { id, roleId } = request.params as { id: string; roleId: string }
        const userId         = request.session.user.id

        const requester = await prisma.member.findFirst({
            where: { organizationId: id, userId, role: { in: ['owner', 'admin'] } },
        })
        if (!requester) return reply.status(403).send({ error: 'Sem permissão.' })

        const existing = await (prisma as any).customRole.findFirst({ where: { id: roleId, organizationId: id } })
        if (!existing) return reply.status(404).send({ error: 'Papel não encontrado.' })

        // Desassocia membros antes de deletar (customRoleId → null já é feito pelo onDelete: SetNull do prisma)
        await (prisma as any).customRole.delete({ where: { id: roleId } })

        log.ok(`Papel ${roleId} removido da org ${id}`)
        return reply.send({ ok: true })
    })

    // GET /organizations/:id/my-permissions — permissões efetivas do usuário logado
    app.get('/:id/my-permissions', {
        preHandler: requireAuth,
        schema: {
            summary: 'Retorna as permissões efetivas do usuário na organização',
            params: { type: 'object', properties: { id: { type: 'string' } } },
        } as never,
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const userId = request.session.user.id

        const member = await (prisma as any).member.findFirst({
            where: { organizationId: id, userId },
            include: { customRole: true },
        }) as any
        if (!member) return reply.status(403).send({ error: 'Não é membro desta organização.' })

        // Se tem papel personalizado, retorna as permissões dele
        if (member.customRole) {
            return reply.send({
                role:         member.role,
                customRoleId: member.customRoleId,
                customRole:   member.customRole.name,
                permissions:  member.customRole.permissions,
            })
        }

        // Permissões padrão por role built-in
        const DEFAULT_PERMISSIONS: Record<string, Record<string, boolean>> = {
            owner: {
                canViewConversations:        true,
                canSendMessages:             true,
                canViewOwnConversationsOnly: false,
                canViewDashboard:            true,
                canManageContacts:           true,
                canManageSettings:           true,
                canManageMembers:            true,
                canManageTags:               true,
                canManageCampaigns:          true,
                canManageChannels:           true,
                canManageAgents:             true,
            },
            admin: {
                canViewConversations:        true,
                canSendMessages:             true,
                canViewOwnConversationsOnly: false,
                canViewDashboard:            true,
                canManageContacts:           true,
                canManageSettings:           false,
                canManageMembers:            true,
                canManageTags:               true,
                canManageCampaigns:          true,
                canManageChannels:           true,
                canManageAgents:             true,
            },
            agent: {
                canViewConversations:        true,
                canSendMessages:             true,
                canViewOwnConversationsOnly: false,
                canViewDashboard:            false,
                canManageContacts:           true,
                canManageSettings:           false,
                canManageMembers:            false,
                canManageTags:               false,
                canManageCampaigns:          false,
                canManageChannels:           false,
                canManageAgents:             false,
            },
            member: {
                canViewConversations:        true,
                canSendMessages:             false,
                canViewOwnConversationsOnly: true,
                canViewDashboard:            false,
                canManageContacts:           false,
                canManageSettings:           false,
                canManageMembers:            false,
                canManageTags:               false,
                canManageCampaigns:          false,
                canManageChannels:           false,
                canManageAgents:             false,
            },
        }

        const permissions = DEFAULT_PERMISSIONS[member.role] ?? DEFAULT_PERMISSIONS.member

        return reply.send({
            role:         member.role,
            customRoleId: null,
            customRole:   null,
            permissions,
        })
    })
}
