import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function fixOrganizationDomains() {
    console.log('🔧 Script para atualizar domínios das organizações\n')

    // Lista todas as organizações
    const organizations = await prisma.organization.findMany({
        select: {
            id: true,
            name: true,
            domain: true,
        },
    })

    if (organizations.length === 0) {
        console.log('⚠️  Nenhuma organização encontrada!')
        await prisma.$disconnect()
        return
    }

    console.log(`📊 Total de organizações: ${organizations.length}\n`)

    // Mostra as organizações atuais
    organizations.forEach((org, index) => {
        console.log(`${index + 1}. ${org.name}`)
        console.log(`   ID: ${org.id}`)
        console.log(`   Domain atual: ${org.domain || '(null/vazio)'}`)
        console.log('')
    })

    console.log('─'.repeat(60))
    console.log('\n💡 INSTRUÇÕES:\n')
    console.log('Para atualizar os domínios, edite este arquivo e adicione as')
    console.log('atualizações no objeto "updates" abaixo:\n')
    console.log('const updates = [')
    console.log('  { id: "org-id-1", domain: "chatmatra.matratecnologia.com" },')
    console.log('  { id: "org-id-2", domain: "teste.matratecnologia.com" },')
    console.log(']')
    console.log('\nDepois execute novamente: npm run fix-org-domains\n')
    console.log('─'.repeat(60))
    console.log('')

    // ⚠️ ADICIONE AS ATUALIZAÇÕES AQUI:
    const updates = [
        // Exemplo:
        // { id: 'clzxxx...', domain: 'chatmatra.matratecnologia.com' },
        // { id: 'clzyyy...', domain: 'teste.matratecnologia.com' },
    ]

    if (updates.length === 0) {
        console.log('ℹ️  Nenhuma atualização definida. Edite o arquivo para adicionar updates.')
        await prisma.$disconnect()
        return
    }

    console.log(`\n🚀 Aplicando ${updates.length} atualização(ões)...\n`)

    for (const update of updates) {
        try {
            const result = await prisma.organization.update({
                where: { id: update.id },
                data: { domain: update.domain },
                select: { name: true, domain: true },
            })

            console.log(`✅ ${result.name} → domain: ${result.domain}`)
        } catch (error) {
            console.error(`❌ Erro ao atualizar ID ${update.id}:`, error.message)
        }
    }

    console.log('\n✅ Atualização concluída!')

    await prisma.$disconnect()
}

fixOrganizationDomains().catch((error) => {
    console.error('❌ Erro:', error)
    process.exit(1)
})
