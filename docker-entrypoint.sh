#!/bin/sh
set -e

echo "⏳ Rodando migrations do Prisma..."
npx prisma migrate deploy

echo "🚀 Iniciando servidor..."
exec npx tsx src/server.ts
