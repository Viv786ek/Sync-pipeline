# Sync Pipeline

A resilient, idempotent data sync pipeline that ingests CRM contacts/deals (HubSpot), payments (Stripe), and calendar events (Google Calendar) into one normalized PostgreSQL schema.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 / 8080 in dev)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned in dev)

## Key API Endpoints

- `GET  /api/healthz` — health check
- `POST /api/sync/run` — trigger sync (body: `{"sources":["hubspot","stripe","google_calendar"]}`)
- `GET  /api/sync/status` — cursor + last run per source
- `GET  /api/sync/logs` — audit log
- `GET  /api/records?source=&type=&limit=&offset=` — query normalized records
- `GET  /api/auth/google/init` — start Google OAuth flow
- `GET  /api/auth/google/callback` — exchange code → refresh_token
- `POST /api/webhooks/hubspot` — receive HubSpot CRM webhooks

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/pipeline/` — sync orchestrator + per-source adapters
- `artifacts/api-server/src/routes/` — Express route handlers
- `lib/db/src/schema/` — Drizzle schema (`sync_records`, `sync_cursors`, `sync_logs`)
- `Dockerfile` — production container
- `render.yaml` — one-click Render Blueprint deployment
- `README.md` — full docs, curl examples, deployment guide

## Architecture decisions

- Idempotency via `ON CONFLICT (source_type, external_id) DO UPDATE` — no app-level locking needed
- `Promise.allSettled` runs all source adapters concurrently; a failure in one never blocks others
- Cursors stored in DB (`sync_cursors`) — survives restarts, no Redis required
- Google Calendar uses `nextSyncToken`; 410 response auto-triggers full backfill
- HubSpot and Stripe use ISO-8601 / Unix timestamp cursors with 401/410 → full-backfill fallback

## User preferences

- No Replit-specific keywords or files in code/README — company will review via GitHub push
- Pipeline must be generic, deployable on Render free tier
