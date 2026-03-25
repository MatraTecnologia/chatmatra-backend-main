/**
 * Script de migração: Evolution API → UAZAPI
 *
 * Atualiza canais WhatsApp existentes que usavam a Evolution API
 * para o novo formato de config do UAZAPI.
 *
 * Uso: npx tsx scripts/migrate-to-uazapi.ts
 *
 * Variáveis de ambiente necessárias:
 *   DATABASE_URL  — conexão PostgreSQL
 *   UAZAPI_URL    — URL base do UAZAPI (ex: https://suaempresa.uazapi.com)
 *   UAZAPI_ADMIN_TOKEN — admin token do UAZAPI
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    const uazapiUrl = process.env.UAZAPI_URL
    const uazapiAdminToken = process.env.UAZAPI_ADMIN_TOKEN

    if (!uazapiUrl || !uazapiAdminToken) {
        console.error('❌ UAZAPI_URL e UAZAPI_ADMIN_TOKEN são obrigatórios.')
        process.exit(1)
    }

    const channels = await prisma.channel.findMany({
        where: { type: 'whatsapp' },
    })

    console.log(`📋 Encontrados ${channels.length} canais WhatsApp para migrar.`)

    let migrated = 0
    let skipped = 0

    for (const channel of channels) {
        const config = channel.config as Record<string, unknown> | null
        if (!config) {
            console.log(`  ⏭️  Canal "${channel.name}" (${channel.id}) — sem config, pulando.`)
            skipped++
            continue
        }

        // Já migrado?
        if (config.uazapiUrl) {
            console.log(`  ⏭️  Canal "${channel.name}" (${channel.id}) — já migrado.`)
            skipped++
            continue
        }

        const instanceName = (config.instanceName as string) ?? ''

        const newConfig = {
            uazapiUrl,
            uazapiAdminToken,
            instanceName,
            phone: config.phone as string | undefined,
            profilePictureUrl: config.profilePictureUrl as string | undefined,
            // uazapiInstanceToken será preenchido ao reconectar
        }

        await prisma.channel.update({
            where: { id: channel.id },
            data: {
                status: 'disconnected',
                config: newConfig as any,
            },
        })

        console.log(`  ✅ Canal "${channel.name}" (${channel.id}) — migrado. Status: disconnected (reconexão necessária).`)
        migrated++
    }

    console.log(`\n📊 Resultado: ${migrated} migrados, ${skipped} pulados.`)
    console.log('⚠️  Canais migrados precisam ser reconectados manualmente (novo QR code).')
}

main()
    .catch((err) => {
        console.error('❌ Erro na migração:', err)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
