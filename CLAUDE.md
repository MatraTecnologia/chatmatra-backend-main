# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Dev server at http://localhost:3333 (tsx watch, hot reload)
npm run build         # Compile TypeScript (tsc)
npm run check-orgs    # List all organizations and their domains
npm run fix-org-domains  # Update organization domains
```

No test suite or linter configured.

Environment: copy `.env.example` to `.env`. Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — 32-char secret (`openssl rand -base64 32`)
- `COOKIE_DOMAIN` — with leading dot for cross-subdomain cookies (e.g. `.seudominio.com.br`)
- `BASE_DOMAIN` — without dot, used for multi-tenant detection
- `DEV_ORGANIZATION_ID` — optional; auto-detects "Desenvolvimento"/"Dev" org on localhost

Database (runs automatically in Docker entrypoint, run manually in dev):
```bash
npx prisma db push      # Apply schema changes
npx prisma generate     # Regenerate Prisma client
```

API docs available at `/docs` (Scalar UI) when server is running.

## Architecture

**Fastify 5** modular monolith with Prisma + PostgreSQL, BullMQ + Redis, Socket.io, and SSE.

### Routing
Routes live in `src/routes/` and are autoloaded via `@fastify/autoload`. Each feature is a directory with a single `index.ts` exporting a Fastify plugin. Directory name maps to the URL path (e.g. `routes/contacts/index.ts` → `/contacts/*`).

Protected routes use `preHandler: requireAuth` from `src/lib/session.ts`, which injects `request.organizationId` after validating the session and tenant.

### Multi-Tenancy
Origin header → hostname → domain lookup → `organizationId` injected into every authenticated request. All data queries must be scoped to `request.organizationId`. In development with localhost, the middleware auto-detects an org named "Desenvolvimento" or "Dev" (or uses `DEV_ORGANIZATION_ID`). See `MULTI-TENANT-DEBUG.md` for troubleshooting.

### Authentication
Better Auth (`src/lib/auth.ts`) with magic link, email OTP, and organization plugins. Sessions use HTTP-only cookies scoped to `COOKIE_DOMAIN`. Each organization can have custom email templates stored in the `EmailTemplate` model; these override the defaults with variable substitution (`{{orgName}}`, `{{logo}}`, `{{url}}`, `{{otp}}`, etc.).

### Database
Prisma schema at `prisma/schema.prisma`. Key model groups:
- **Auth**: User, Session, Account, Verification
- **Multi-tenant**: Organization, Member, Invitation, CustomRole, Team
- **Core**: Contact, Channel, Message, Tag
- **Features**: Campaign, AiAgent, AssignmentRule, MessageTemplate, EmailTemplate, Product

Prisma client singleton is in `src/lib/prisma.ts`.

### Real-Time
- **Socket.io** (`src/lib/presence.ts`): Presence system with org-scoped rooms. Tracks online/away/offline status, current contact viewed, and screen state (for supervision).
- **SSE** (`src/lib/agentSse.ts`): `publishToOrg(orgId, event, data)` broadcasts in-process events to connected dashboard clients. Used for new messages, assignments, and notifications.

### Background Jobs
BullMQ with Redis. Two queues defined in `src/lib/queue.ts`:
- `webhook-messages` — processes incoming messages from Evolution API and WhatsApp Business API webhooks; handles contact creation and triggers auto-assignment
- `sync-history` — syncs message history from WhatsApp channels

Workers start alongside the server in `src/server.ts`.

### WhatsApp Integration
Dual support via `channels/` routes:
- **Evolution API**: Self-hosted wrapper, uses `evolutionFetch()` helper
- **WhatsApp Business API**: Meta Graph API, uses `whatsappBusinessFetch()` helper

Channel credentials/config are stored as JSON in `Channel.config`.

### Auto-Assignment
`src/lib/assignmentEngine.ts` evaluates `AssignmentRule` records (priority-ordered) with strategies: round-robin, load-balancing, random. Triggered from `messageWorker.ts` when a new contact is created or a message arrives.

### Widget API
`src/routes/widget/` is a public API (no session auth) for the embeddable chat widget. Validated via `X-Widget-Key` + `X-Contact-Id` headers.

### Logging
Custom colored logger in `src/lib/logger.ts` (no dependencies). Use it instead of `console.log`. Labels: INFO, OK, WARN, ERROR, MSG, TAG, WA, WEBHOOK, SSE.
