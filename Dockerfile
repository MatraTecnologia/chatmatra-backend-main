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

# Gera o Prisma Client para a plataforma linux/alpine
RUN npx prisma generate

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Usuário não-root para segurança
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 fastify

RUN apk add --no-cache openssl

# Copia somente o necessário do builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src         ./src
COPY --from=builder /app/prisma      ./prisma
COPY --from=builder /app/public      ./public
COPY --from=builder /app/package*.json ./

# Script de inicialização
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER fastify

EXPOSE 3333

ENTRYPOINT ["./docker-entrypoint.sh"]
