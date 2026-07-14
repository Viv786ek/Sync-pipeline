# Sync Pipeline

A production-ready data sync pipeline that ingests records from three sources — **HubSpot CRM**, **Stripe Payments**, and **Google Calendar** — into a single normalized PostgreSQL schema.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Features](#features)
3. [Quick Start](#quick-start)
4. [API Reference](#api-reference)
5. [Deployment on Render](#deployment-on-render)
6. [Testing with curl / Postman](#testing-with-curl--postman)
7. [Design Tradeoffs](#design-tradeoffs)
8. [References](#references)
9. [AI Usage Disclosure](#ai-usage-disclosure)

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Express API Server                      │
│                                                           │
│  POST /api/sync/run  ──►  Orchestrator                    │
│                            │                              │
│                   ┌────────┴─────────┐                    │
│                   │                  │                     │
│           HubSpot adapter  Stripe adapter  Calendar adapter│
│                   │                  │         │           │
│                   └────────┬─────────┘         │           │
│                            │                              │
│                        Normalizer                         │
│                            │                              │
│                    Writer (upsert)                        │
│                            │                              │
│                      PostgreSQL DB                        │
│                  sync_records (normalized)                │
│                  sync_cursors (incremental state)         │
│                  sync_logs    (audit trail)               │
└───────────────────────────────────────────────────────────┘
```

### Idempotency

Every upsert uses `ON CONFLICT (source_type, external_id) DO UPDATE`. Firing the same webhook twice or re-running the sync job produces exactly one row.

### Incremental vs Full Sync

| Source           | Cursor type         | Stale-cursor fallback |
|-----------------|---------------------|-----------------------|
| HubSpot         | ISO-8601 timestamp  | Re-fetch all pages    |
| Stripe          | Unix timestamp (s)  | Re-fetch all pages    |
| Google Calendar | `nextSyncToken`     | HTTP 410 → full backfill |

A source returning `401`/`403`/`410` sets `needs_full_sync = true` in `sync_cursors`; the next run automatically does a full backfill.

### Fault Isolation

`Promise.allSettled` runs all three adapters concurrently. A failure in one source is logged and returned in the response but never blocks the other two.

---

## Features

- **Normalized schema**: contacts, deals, payments, and calendar events stored in one table with consistent field names
- **Idempotent writes**: re-running the pipeline or re-firing webhooks never creates duplicates
- **Incremental sync**: only fetches changed records after the first full backfill
- **Auto fallback**: stale or expired cursors trigger an automatic full backfill
- **Per-source fault isolation**: source A failing does not prevent B and C from syncing
- **Webhook support**: HubSpot can push changes in real time; endpoint is idempotent
- **Audit log**: every sync run is recorded in `sync_logs`
- **Google OAuth flow**: `/api/auth/google/init` guides you through getting a refresh token

---

## Quick Start

### Prerequisites

- Node.js 22+, pnpm 9+
- PostgreSQL 14+ (or Docker)

### 1. Clone and install

```bash
git clone https://github.com/your-username/sync-pipeline.git
cd sync-pipeline
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Push database schema

```bash
pnpm --filter @workspace/db run push
```

### 4. Start the server

```bash
pnpm --filter @workspace/api-server run dev
```

Server listens on `http://localhost:5000`.

### 5. Trigger your first sync

```bash
curl -X POST http://localhost:5000/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## API Reference

### Health

```
GET /api/healthz
```

Returns `{ "status": "ok" }`.

### Sync

| Method | Path             | Description                                      |
|--------|-----------------|--------------------------------------------------|
| POST   | `/api/sync/run`  | Trigger sync for all or specific sources         |
| GET    | `/api/sync/status` | Current cursor + last run per source           |
| GET    | `/api/sync/logs` | Paginated sync log history (`?limit=50`)         |

**POST /api/sync/run body** (all fields optional):

```json
{
  "sources": ["hubspot", "stripe", "google_calendar"]
}
```

### Records

| Method | Path               | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | `/api/records`     | List normalized records (filterable)     |
| GET    | `/api/records/:id` | Single record by UUID                    |

Query params for `/api/records`:
- `source` — `hubspot` | `stripe` | `google_calendar`
- `type` — `contact` | `deal` | `payment` | `event`
- `limit` — max rows (default 50, max 500)
- `offset` — pagination offset

### Google OAuth

| Method | Path                        | Description                               |
|--------|-----------------------------|-------------------------------------------|
| GET    | `/api/auth/google/init`     | Returns Google consent-page URL           |
| GET    | `/api/auth/google/callback` | Exchanges code for tokens, returns `refresh_token` |

### Webhooks

| Method | Path                    | Description                       |
|--------|------------------------|-----------------------------------|
| POST   | `/api/webhooks/hubspot` | Receive HubSpot CRM subscription events |

---

## Deployment on Render

### Option A — One-click Blueprint (recommended)

1. Push this repo to GitHub
2. Go to **render.com → New → Blueprint**
3. Connect your GitHub repo — Render detects `render.yaml` automatically
4. It provisions a free PostgreSQL instance and deploys the API
5. In the service dashboard → **Environment**, add your secret vars:
   - `HUBSPOT_TOKEN`
   - `STRIPE_SECRET_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`
6. Redeploy — done

### Option B — Manual setup

1. **Database**: New → PostgreSQL (free tier) → copy the Internal DB URL

2. **Web Service**: New → Web Service
   - Connect your repo
   - Runtime: **Docker**
   - Dockerfile path: `./Dockerfile`
   - Plan: Free

3. **Environment variables** (Environment tab):
   ```
   DATABASE_URL=<internal connection string from step 1>
   NODE_ENV=production
   PORT=5000
   HUBSPOT_TOKEN=...
   STRIPE_SECRET_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://<your-app>.onrender.com/api/auth/google/callback
   GOOGLE_REFRESH_TOKEN=...
   ```

4. **Push DB schema** (one-time): In Render's Shell tab:
   ```bash
   pnpm --filter @workspace/db run push
   ```

5. Verify: `curl https://<your-app>.onrender.com/api/healthz`

### Getting a Google Refresh Token

After deployment:
1. `GET https://<your-app>.onrender.com/api/auth/google/init`
2. Open the returned `authUrl` in a browser
3. Sign in with the Google account whose calendar you want to sync
4. Copy the `refresh_token` from the callback response
5. Set it as `GOOGLE_REFRESH_TOKEN` in Render → redeploy

---

## Testing with curl / Postman

### 1. Health check

```bash
curl https://<your-app>.onrender.com/api/healthz
# → {"status":"ok"}
```

### 2. Full sync — all sources

```bash
curl -X POST https://<your-app>.onrender.com/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response:
```json
{
  "ok": true,
  "sources": [
    { "source": "hubspot",          "processed": 12 },
    { "source": "stripe",           "processed": 5  },
    { "source": "google_calendar",  "processed": 8  }
  ],
  "totalProcessed": 25,
  "errors": [],
  "durationMs": 1843
}
```

### 3. Sync one source only

```bash
curl -X POST https://<your-app>.onrender.com/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{"sources":["stripe"]}'
```

### 4. Simulate stale-cursor fallback (edge case)

```bash
# Corrupt the HubSpot cursor to a date in the future
# (simulates an expired/stale timestamp)
curl -X POST https://<your-app>.onrender.com/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{"sources":["hubspot"]}'
# Response will show 0 new records (cursor is ahead of all records)

# Now check status — needs_full_sync should flip to true on a 410/401
curl https://<your-app>.onrender.com/api/sync/status
```

### 5. Query normalized records

```bash
# All records
curl https://<your-app>.onrender.com/api/records

# Stripe payments only
curl "https://<your-app>.onrender.com/api/records?source=stripe&type=payment"

# HubSpot contacts, paginated
curl "https://<your-app>.onrender.com/api/records?source=hubspot&type=contact&limit=10&offset=0"
```

### 6. Idempotency test — run sync twice back-to-back

```bash
curl -X POST https://<your-app>.onrender.com/api/sync/run -H "Content-Type: application/json" -d '{}'
curl -X POST https://<your-app>.onrender.com/api/sync/run -H "Content-Type: application/json" -d '{}'

# Row count in sync_records should be identical after both calls
curl "https://<your-app>.onrender.com/api/records?limit=1"
```

### 7. Source-down resilience test

```bash
# If Stripe key is wrong, HubSpot and Calendar still sync
# Temporarily set an invalid key and trigger a run — errors array
# will contain only Stripe; other sources still return processed > 0
```

---

## Design Tradeoffs

| Decision | Choice | Why |
|----------|--------|-----|
| ORM | Drizzle ORM | Type-safe, lightweight, great Postgres support, zero magic |
| Sync state | DB table (sync_cursors) | Survives restarts; visible for debugging; no Redis needed |
| Concurrency | Promise.allSettled | Isolates per-source failures; no complex job queue for 3 sources |
| Idempotency | ON CONFLICT DO UPDATE | Atomic, no application-layer locking needed |
| Google auth | OAuth2 refresh token | Refresh tokens don't expire on inactivity; safe for server-side use |
| Webhook auth | Skipped (demo) | Production should verify X-HubSpot-Signature-V3 header |
| Schema | Single sync_records table | Simpler queries, easier pagination; column sparsity acceptable for mixed types |
| Bundler | esbuild | Fast, produces a single deployable mjs; tree-shakes unused code |

---

## References

- [HubSpot CRM API — Search Endpoints](https://developers.hubspot.com/docs/api/crm/search)
- [HubSpot Webhooks Documentation](https://developers.hubspot.com/docs/api/webhooks)
- [Stripe Payment Intents API](https://docs.stripe.com/api/payment_intents)
- [Stripe Auto-pagination](https://docs.stripe.com/api/pagination/auto)
- [Google Calendar Events: list](https://developers.google.com/calendar/api/v3/reference/events/list)
- [Google Calendar Incremental Sync](https://developers.google.com/calendar/api/guides/sync)
- [Google OAuth2 Offline Access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Drizzle ORM — PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)
- [Render Blueprint Spec](https://render.com/docs/blueprint-spec)

---

## AI Usage Disclosure

This project was built with AI assistance (Claude). The AI was used to:
- Scaffold the Express + Drizzle boilerplate
- Generate source adapter code for HubSpot, Stripe, and Google Calendar APIs
- Write the normalizer, writer, and orchestrator modules
- Draft the README, Dockerfile, and render.yaml

All AI output was reviewed, corrected where needed (API version pinning, error handling edge cases, OAuth flow), and tested before submission. The assistant was directed to follow specific design decisions (idempotency via upsert, Promise.allSettled isolation, refresh-token-based Google auth) rather than making those choices itself.
