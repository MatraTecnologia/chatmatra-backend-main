// ─── Queue Routes ─────────────────────────────────────────────────────────────
// Expõe stats e listagem de jobs das filas BullMQ para o dashboard de monitoramento.
// Protegido por requireAuth + verificação de role admin/owner.

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../lib/session.js'
import { prisma } from '../../lib/prisma.js'
import { messageQueue, syncQueue } from '../../lib/queue.js'

async function getQueueStats(queue: typeof messageQueue) {
    const [counts, waiting, active, failed, completed] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
        queue.getJobs(['waiting'], 0, 19),
        queue.getJobs(['active'], 0, 19),
        queue.getJobs(['failed'], 0, 29),
        queue.getJobs(['completed'], 0, 19),
    ])
    return { counts, waiting, active, failed, completed }
}

function serializeJob(job: Awaited<ReturnType<typeof messageQueue.getJobs>>[number]) {
    return {
        id:           job.id,
        name:         job.name,
        data:         job.data,
        progress:     job.progress,
        attemptsMade: job.attemptsMade,
        timestamp:    job.timestamp,
        processedOn:  job.processedOn,
        finishedOn:   job.finishedOn,
        failedReason: job.failedReason,
        returnvalue:  job.returnvalue,
    }
}

export default async function (app: FastifyInstance) {

    // GET /queue/stats — contagens de waiting/active/completed/failed por fila
    app.get('/stats', { preHandler: requireAuth }, async (request, reply) => {
        const userId = request.session.user.id
        const orgId  = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Organização não detectada.' })

        const member = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!member || !['admin', 'owner'].includes(member.role)) {
            return reply.status(403).send({ error: 'Apenas admin/owner pode acessar o monitor de filas.' })
        }

        const [msgStats, syncStats] = await Promise.all([
            getQueueStats(messageQueue as unknown as typeof messageQueue),
            getQueueStats(syncQueue as unknown as typeof messageQueue),
        ])

        return {
            messageQueue: {
                name:   'webhook-messages',
                label:  'Mensagens (Webhook)',
                counts: msgStats.counts,
                waiting:   msgStats.waiting.map(serializeJob),
                active:    msgStats.active.map(serializeJob),
                failed:    msgStats.failed.map(serializeJob),
                completed: msgStats.completed.map(serializeJob),
            },
            syncQueue: {
                name:   'sync-history',
                label:  'Sincronizações',
                counts: syncStats.counts,
                waiting:   syncStats.waiting.map(serializeJob),
                active:    syncStats.active.map(serializeJob),
                failed:    syncStats.failed.map(serializeJob),
                completed: syncStats.completed.map(serializeJob),
            },
        }
    })

    // POST /queue/jobs/:jobId/retry — reprocessa um job com falha
    app.post('/jobs/:jobId/retry', { preHandler: requireAuth }, async (request, reply) => {
        const { jobId } = request.params as { jobId: string }
        const userId = request.session.user.id
        const orgId  = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Organização não detectada.' })

        const member = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!member || !['admin', 'owner'].includes(member.role)) {
            return reply.status(403).send({ error: 'Sem permissão.' })
        }

        // Tenta nas duas filas
        let job = await messageQueue.getJob(jobId)
        if (!job) job = await syncQueue.getJob(jobId) as unknown as typeof job

        if (!job) return reply.status(404).send({ error: 'Job não encontrado.' })

        await job.retry()
        return { ok: true }
    })

    // DELETE /queue/jobs/:jobId — remove um job
    app.delete('/jobs/:jobId', { preHandler: requireAuth }, async (request, reply) => {
        const { jobId } = request.params as { jobId: string }
        const userId = request.session.user.id
        const orgId  = request.organizationId
        if (!orgId) return reply.status(400).send({ error: 'Organização não detectada.' })

        const member = await prisma.member.findFirst({ where: { organizationId: orgId, userId } })
        if (!member || !['admin', 'owner'].includes(member.role)) {
            return reply.status(403).send({ error: 'Sem permissão.' })
        }

        let job = await messageQueue.getJob(jobId)
        if (!job) job = await syncQueue.getJob(jobId) as unknown as typeof job

        if (!job) return reply.status(404).send({ error: 'Job não encontrado.' })

        await job.remove()
        return { ok: true }
    })
}
