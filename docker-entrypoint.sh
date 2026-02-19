#!/bin/sh
set -e

echo "⏳ Sincronizando schema com o banco (db push)..."
npx prisma db push

npx prisma generate

echo "🚀 Iniciando servidor..."
exec npx tsx src/server.ts
