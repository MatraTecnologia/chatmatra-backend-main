# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Instala dependências do sistema necessárias para pg e módulos nativos
RUN apk add --no-cache libc6-compat openssl

COPY package*.json ./
# Instala TODAS as dependências (incluindo dev — tsx é devDep)
RUN npm ci

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma generate só lê o schema para gerar os tipos — não conecta ao banco.
# Prisma 7 exige que prisma.config.ts resolva a URL, então passamos uma dummy
# apenas para esta etapa de build (a URL real chega em runtime via env var).
RUN DATABASE_URL="postgres://postgres:4a5e9f3e4c802dc9e522@easypanel3.matratecnologia.com:4464/chatmatra?sslmode=disable" npx prisma generate

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

# Copia somente o necessário do builder
COPY --from=builder /app/node_modules    ./node_modules
COPY --from=builder /app/src             ./src
COPY --from=builder /app/prisma          ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/public          ./public
COPY --from=builder /app/package*.json   ./

# Script de inicialização
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Porta padrão 80 — sobrescreva com a env var PORT se precisar
ENV PORT=80
EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
