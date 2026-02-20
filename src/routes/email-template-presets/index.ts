import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../lib/session.js';
import { log } from '../../lib/logger.js';

/**
 * Rotas para gerenciamento de presets de templates de e-mail
 */
export default async function (app: FastifyInstance) {

  // ─── GET /email-template-presets ─────────────────────────────────────────────
  // Lista todos os presets da organização
  app.get('/', {
    preHandler: requireAuth,
    schema: {
      tags: ['email-template-presets'],
      summary: 'Lista presets de templates de e-mail da organização',
    },
  }, async (req, reply) => {
    const orgId = req.organizationId;
    if (!orgId) {
      return reply.status(400).send({ error: 'Nenhuma organização detectada' });
    }

    const userId = req.session.user.id;
    const isMember = await prisma.member.findFirst({
      where: { organizationId: orgId, userId }
    });

    if (!isMember) {
      return reply.status(403).send({ error: 'Sem permissão' });
    }

    try {
      const presets = await prisma.emailTemplatePreset.findMany({
        where: {
          organizationId: orgId,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      log.info(`Listed ${presets.length} email template presets for org ${orgId}`);

      return reply.send({ presets });
    } catch (error) {
      log.error('Error listing email template presets:', error);
      return reply.status(500).send({ error: 'Failed to list presets' });
    }
  });

  // ─── POST /email-template-presets ────────────────────────────────────────────
  // Cria um novo preset
  app.post('/', {
    preHandler: requireAuth,
    schema: {
      description: 'Cria novo preset de template de e-mail',
      tags: ['email-template-presets'],
      body: {
        type: 'object',
        required: ['name', 'design'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          thumbnail: { type: 'string' },
          design: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.organizationId;
    if (!orgId) {
      return reply.status(400).send({ error: 'Nenhuma organização detectada' });
    }

    const userId = req.session.user.id;
    const isMember = await prisma.member.findFirst({
      where: { organizationId: orgId, userId }
    });

    if (!isMember) {
      return reply.status(403).send({ error: 'Sem permissão' });
    }

    const { name, description, thumbnail, design } = req.body as {
      name: string;
      description?: string;
      thumbnail?: string;
      design: object;
    };

    try {
      const preset = await prisma.emailTemplatePreset.create({
        data: {
          organizationId: orgId,
          name,
          description: description || null,
          thumbnail: thumbnail || null,
          design,
        },
      });

      log.ok(`Created email template preset "${name}" for org ${orgId}`);

      return reply.status(201).send({ preset });
    } catch (error) {
      log.error('Error creating email template preset:', error);
      return reply.status(500).send({ error: 'Failed to create preset' });
    }
  });

  // ─── DELETE /email-template-presets/:id ──────────────────────────────────────
  // Remove um preset
  app.delete('/:id', {
    preHandler: requireAuth,
    schema: {
      description: 'Remove preset de template de e-mail',
      tags: ['email-template-presets'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.organizationId;
    if (!orgId) {
      return reply.status(400).send({ error: 'Nenhuma organização detectada' });
    }

    const userId = req.session.user.id;
    const isMember = await prisma.member.findFirst({
      where: { organizationId: orgId, userId }
    });

    if (!isMember) {
      return reply.status(403).send({ error: 'Sem permissão' });
    }

    const { id } = req.params as { id: string };

    try {
      // Verifica se o preset pertence à organização
      const preset = await prisma.emailTemplatePreset.findUnique({
        where: { id },
        select: { organizationId: true, name: true },
      });

      if (!preset) {
        return reply.status(404).send({ error: 'Preset not found' });
      }

      if (preset.organizationId !== orgId) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      await prisma.emailTemplatePreset.delete({
        where: { id },
      });

      log.ok(`Deleted email template preset "${preset.name}" (${id})`);

      return reply.send({ success: true });
    } catch (error) {
      log.error('Error deleting email template preset:', error);
      return reply.status(500).send({ error: 'Failed to delete preset' });
    }
  });

  // ─── GET /email-template-presets/:id ─────────────────────────────────────────
  // Busca um preset específico
  app.get('/:id', {
    preHandler: requireAuth,
    schema: {
      description: 'Busca preset de template de e-mail por ID',
      tags: ['email-template-presets'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.organizationId;
    if (!orgId) {
      return reply.status(400).send({ error: 'Nenhuma organização detectada' });
    }

    const userId = req.session.user.id;
    const isMember = await prisma.member.findFirst({
      where: { organizationId: orgId, userId }
    });

    if (!isMember) {
      return reply.status(403).send({ error: 'Sem permissão' });
    }

    const { id } = req.params as { id: string };

    try {
      const preset = await prisma.emailTemplatePreset.findUnique({
        where: { id },
      });

      if (!preset) {
        return reply.status(404).send({ error: 'Preset not found' });
      }

      if (preset.organizationId !== orgId) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      return reply.send({ preset });
    } catch (error) {
      log.error('Error fetching email template preset:', error);
      return reply.status(500).send({ error: 'Failed to fetch preset' });
    }
  });
}
