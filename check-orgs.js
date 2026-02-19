import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function checkOrganizations() {
    console.log('🔍 Verificando organizações no banco de dados...\n')

    const organizations = await prisma.organization.findMany({
        select: {
            id: true,
            name: true,
            domain: true,
            createdAt: true,
        },
        orderBy: {
            createdAt: 'desc',
        },
    })

    if (organizations.length === 0) {
        console.log('⚠️  Nenhuma organização encontrada no banco de dados!')
        return
    }

    console.log(`✅ Total de organizações: ${organizations.length}\n`)

    organizations.forEach((org, index) => {
        console.log(`${index + 1}. ${org.name}`)
        console.log(`   ID: ${org.id}`)
        console.log(`   Domain: ${org.domain || '(null/vazio)'}`)
        console.log(`   Criado em: ${org.createdAt}`)
        console.log('')
    })

    await prisma.$disconnect()
}

checkOrganizations().catch((error) => {
    console.error('❌ Erro ao verificar organizações:', error)
    process.exit(1)
})
