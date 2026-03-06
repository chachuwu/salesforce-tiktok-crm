# Salesforce → TikTok CRM Events Integration

A production-grade integration that captures **Salesforce Lead lifecycle changes** via Change Data Capture and posts them to the **TikTok CRM Events API** — with TikTok standard events, OAuth2, automated event set provisioning, and full Deep Funnel Optimization (DFO) support.

---

## Table of Contents

- [Architecture](#architecture)
- [Lead Lifecycle → TikTok Event Mapping](#lead-lifecycle--tiktok-event-mapping)
- [Deep Funnel Optimization (DFO)](#deep-funnel-optimization-dfo)
- [Identity Signal Priority](#identity-signal-priority)
- [OAuth2 Setup](#oauth2-setup)
- [Event Set Provisioning](#event-set-provisioning)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Salesforce Setup](#salesforce-setup)
- [Getting Started](#getting-started)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security & Compliance](#security--compliance)
- [Key Design Decisions](#key-design-decisions)

---

## Architecture

```
Salesforce Sales Cloud
        │
        │  Change Data Capture (/data/LeadChangeEvent)
        ▼
SalesforceCDCListener          — jsforce EMP/CometD streaming
        │
        ▼
EventFilter                    — status change detection, DFO stage routing
        │
        ▼
IdentityEnrichmentLayer        — all signals extracted + quality scored
        │
        ▼
Hasher (normalization + SHA-256)
        │
        ▼
CRMEventSetManager             — resolves per-advertiser event set ID
        │                         (Redis cache → Postgres → env fallback)
        ▼
TikTokEventBuilder             — canonical → TikTok API payload (standard events)
        │
        ▼
EventDeduplicator (Redis NX)   — 48h idempotency window
        │
        ▼
TikTokAPIClient (OAuth token)  — axios + exponential retry + rate limiter
        │
   ┌────┴────┐
   │ Success │ → EventLog (Postgres) status=sent
   │ Failure │ → BullMQ retry queue → worker → TikTokAPIClient
   └─────────┘
        │
        ▼
Observability (pino structured logs, /metrics/queue, /health, /ready)
```

---

## Lead Lifecycle → TikTok Event Mapping

All events map to **TikTok standard events** — no manual funnel mapping required in Events Manager.

| Salesforce Status / Trigger | TikTok Standard Event | DFO Stage |
|---|---|:---:|
| Lead CREATE / new / open / pending | `SubmitForm` | 1 |
| contacted / working / nurturing | `Contact` | 2 |
| demo scheduled / meeting scheduled | `Schedule` | 2 |
| qualified / mql / interested | `CompleteRegistration` | 3 |
| sql / opportunity / proposal | `SubmitApplication` | 3 |
| converted / won / closed won | `Purchase` | 4 |
| approved / credit approved | `ApplicationApproval` | 4 |
| subscribed / subscription started | `Subscribe` | 4 |
| trial / trial started / free trial | `StartTrial` | 4 |
| unqualified / junk / lost / inactive | filtered out | — |
| `IsConverted` flag set | `Purchase` | 4 |

Full status list (60+ mappings): [`src/filters/event-filter.ts`](src/filters/event-filter.ts)

---

## Deep Funnel Optimization (DFO)

TikTok's DFO optimizes campaigns toward leads most likely to convert by requiring signal volume across 4 funnel stages.

| Stage | Events | Min. Volume |
|:---:|---|---|
| 1 — Lead Captured | `SubmitForm` | — |
| 2 — Engaged | `Contact`, `Schedule` | ≥50 / 14 days |
| 3 — Qualified | `CompleteRegistration`, `SubmitApplication` | ≥50 / 14 days |
| 4 — Converted | `Purchase`, `ApplicationApproval`, `Subscribe`, `StartTrial` | ≥50 / 14 days |

Set your DFO optimization target (stage 2, 3, or 4) in TikTok Ads Manager. Map up to 3 events per stage in Events Manager.

---

## Identity Signal Priority

TikTok resolves identity using these signals in order of match rate impact:

| Signal | Treatment | Weight | Notes |
|---|---|:---:|---|
| `lead_id` | Plaintext | — | TikTok native form ID — highest priority |
| `email` | SHA-256 | +35 | Normalized (lowercase + trim) before hashing |
| `phone_number` | SHA-256 | +25 | Normalized to E.164 before hashing |
| `ttclid` | Plaintext | +20 | TikTok click ID — never hash |
| `external_id` | SHA-256 | +10 | Stable cross-device identifier |
| `ip` | Plaintext | +5 | Captured at form submission |
| `user_agent` | Plaintext | +5 | Captured at form submission |

Signal score ≥70 → estimated match rate >70%.

### Required Salesforce Custom Fields

| Field API Name | Type | Purpose |
|---|---|---|
| `TikTok_Lead_ID__c` | Text(255) | TikTok native lead form ID |
| `TTCLID__c` | Text(255) | TikTok click ID from landing page URL |
| `External_Id__c` | Text(255) | Cross-device user identifier |
| `IP_Address__c` | Text(45) | IP address at form submission |
| `User_Agent__c` | Text(1024) | User-agent at form submission |

---

## OAuth2 Setup

This integration uses TikTok's **"Developer's Own App"** OAuth2 flow. Tokens are stored in Postgres (durable) and Redis (hot-path cache) and refreshed proactively before expiry.

### Flow

```
1. GET  /auth/tiktok            → redirect to TikTok consent screen
2. GET  /auth/tiktok/callback   → exchange auth_code, store tokens,
                                   auto-provision CRM event set
3.      ProactiveRefresher      → refreshes tokens 1h before 24h expiry
```

### OAuth Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/auth/tiktok` | Initiate OAuth — redirect to TikTok |
| `GET` | `/auth/tiktok/callback` | Handle redirect, exchange code, provision event set |
| `GET` | `/auth/tiktok/status` | List authorized advertiser IDs |
| `POST` | `/auth/tiktok/refresh/:id` | Manually refresh a token |
| `POST` | `/auth/tiktok/revoke/:id` | Revoke access for an advertiser |

### Token Storage

- **Redis** — hot-path cache (23h TTL, avoids DB round-trip on every event)
- **Postgres** — durable source of truth (`tiktok_oauth_tokens` table)
- **ProactiveRefresher** — background job that refreshes tokens 1h before expiry

---

## Event Set Provisioning

Advertisers no longer need to manually create a CRM event set in TikTok Events Manager. After OAuth completes, the integration automatically:

- **0 existing sets** → creates one and stores the ID
- **1 existing set** → selects it automatically
- **2+ existing sets** → returns them for manual selection via API

Event set IDs are stored per-advertiser in Postgres and cached in Redis, so every event is routed to the correct event set with no manual configuration required.

### Event Set Endpoints

| Method | Route | Description |
|---|---|---|
| `POST` | `/event-sets/:advertiserId/provision` | Run check-and-create flow |
| `GET` | `/event-sets/:advertiserId` | List all event sets for an advertiser |
| `POST` | `/event-sets/:advertiserId` | Manually create a named event set |
| `POST` | `/event-sets/:advertiserId/select` | Pick one when multiple exist |
| `GET` | `/event-sets/:advertiserId/active` | Check the currently active event set ID |

---

## Project Structure

```
salesforce-tiktok-crm/
├── src/
│   ├── auth/
│   │   ├── types.ts                  OAuth token types
│   │   ├── tiktok-oauth.ts           OAuth2 client (auth URL, exchange, refresh)
│   │   ├── token-store.ts            Postgres + Redis token storage
│   │   ├── oauth-routes.ts           Express OAuth routes + event set provisioning
│   │   └── proactive-refresher.ts    Background token refresh job
│   ├── clients/
│   │   └── tiktok-api-client.ts      TikTok Events API HTTP client
│   ├── config/
│   │   └── env.ts                    Zod-validated environment config
│   ├── db/
│   │   ├── event-log.ts              Postgres event audit log
│   │   └── migrate.ts                Schema migrations
│   ├── deduplication/
│   │   └── redis-dedup.ts            Redis SET NX idempotency (48h TTL)
│   ├── enrichment/
│   │   └── identity-enrichment.ts    Signal extraction + quality scoring
│   ├── event-set/
│   │   ├── types.ts                  CRM event set types
│   │   ├── crm-event-set-manager.ts  list / create / provision / resolve / select
│   │   └── event-set-routes.ts       Express event set route handlers
│   ├── filters/
│   │   └── event-filter.ts           CDC event filter + 60+ status→event mappings
│   ├── listeners/
│   │   └── salesforce-cdc.ts         Salesforce CDC EMP/CometD listener
│   ├── logging/
│   │   └── logger.ts                 Pino structured logger (PII redacted)
│   ├── normalization/
│   │   ├── normalizer.ts             Email, phone (E.164), name, zip, geo
│   │   └── hasher.ts                 SHA-256 hashing + deterministic event IDs
│   ├── queue/
│   │   └── retry-queue.ts            BullMQ durable retry queue
│   ├── transformer/
│   │   └── tiktok-event-builder.ts   Canonical → TikTok API payload builder
│   ├── types/
│   │   └── index.ts                  Shared TypeScript types + TikTok standard events
│   ├── pipeline.ts                   Central orchestrator
│   └── server.ts                     Express server + graceful shutdown
│
├── tests/                            18 suites — 340 tests total
│   ├── pipeline.test.ts
│   ├── pii-safety.test.ts            ⚠️  CI gate: no plaintext PII in payloads
│   ├── crm-event-set-manager.test.ts
│   ├── event-set-routes.test.ts
│   ├── event-filter.test.ts
│   ├── tiktok-event-builder.test.ts
│   ├── tiktok-oauth.test.ts
│   ├── oauth-routes.test.ts
│   ├── token-store.test.ts
│   ├── redis-dedup.test.ts
│   ├── event-log.test.ts
│   ├── match-rate.test.ts
│   ├── normalizer.test.ts
│   ├── normalizer.edge-cases.test.ts
│   ├── hasher.test.ts
│   ├── identity-enrichment.test.ts
│   ├── tiktok-api-client.test.ts
│   └── postback-compliance.test.ts
│
├── scripts/
│   └── setup-salesforce-cdc.md       Salesforce CDC + Connected App setup guide
│
├── .env.example
├── docker-compose.yml                Redis + Postgres for local dev
├── Dockerfile                        Multi-stage production build
├── package.json
└── tsconfig.json
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values.

### Required

```bash
# Salesforce
SF_CLIENT_ID=           # Connected App consumer key
SF_CLIENT_SECRET=       # Connected App consumer secret
SF_USERNAME=            # Integration user email
SF_PASSWORD=            # Integration user password
SF_SECURITY_TOKEN=      # Salesforce security token

# TikTok App — https://developers.tiktok.com/
TIKTOK_APP_ID=
TIKTOK_APP_SECRET=
TIKTOK_REDIRECT_URI=    # https://your-domain.com/auth/tiktok/callback

# Postgres
POSTGRES_URL=           # postgresql://user:pass@host:5432/dbname
```

### Optional (auto-provisioned or have defaults)

```bash
# Only needed if skipping OAuth or auto-provisioning
TIKTOK_ACCESS_TOKEN=
TIKTOK_CRM_EVENT_SET_ID=    # Auto-provisioned after OAuth — override if needed

# Defaults shown
TIKTOK_API_BASE_URL=https://business-api.tiktok.com
TIKTOK_API_VERSION=v1.3
REDIS_URL=redis://localhost:6379
PORT=3000
LOG_LEVEL=info
INTEGRATION_VERSION=1.0.0
TIKTOK_RATE_LIMIT_RPS=10
TIKTOK_MAX_RETRIES=5
TIKTOK_BATCH_SIZE=50
REDIS_DEDUP_TTL_SECONDS=172800
```

---

## Salesforce Setup

See [`scripts/setup-salesforce-cdc.md`](scripts/setup-salesforce-cdc.md) for full step-by-step instructions:

1. Enable Change Data Capture for the Lead object
2. Create a Connected App with the required OAuth scopes
3. Create the 5 custom Lead fields (`TikTok_Lead_ID__c`, `TTCLID__c`, etc.)
4. Set up TTCLID capture on landing pages
5. Configure the integration user with minimum required permissions

---

## Getting Started

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start Redis + Postgres
docker-compose up -d

# 3. Run migrations
npm run migrate

# 4. Configure environment
cp .env.example .env
# Fill in your Salesforce + TikTok credentials

# 5. Start the server
npm run dev
```

### Authorize TikTok

```bash
# Opens TikTok consent screen — authorizes + auto-provisions your CRM event set
open http://localhost:3000/auth/tiktok

# Confirm authorization and active event set
curl http://localhost:3000/auth/tiktok/status
curl http://localhost:3000/event-sets/{advertiserId}/active
```

### All API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check |
| `GET` | `/metrics/queue` | BullMQ queue stats |
| `GET` | `/auth/tiktok` | Initiate OAuth |
| `GET` | `/auth/tiktok/callback` | OAuth callback + event set provisioning |
| `GET` | `/auth/tiktok/status` | Authorized advertisers |
| `POST` | `/auth/tiktok/refresh/:id` | Refresh token |
| `POST` | `/auth/tiktok/revoke/:id` | Revoke access |
| `POST` | `/event-sets/:id/provision` | Auto-provision event set |
| `GET` | `/event-sets/:id` | List event sets |
| `POST` | `/event-sets/:id` | Create event set |
| `POST` | `/event-sets/:id/select` | Select event set |
| `GET` | `/event-sets/:id/active` | Active event set ID |

---

## Testing

```bash
# Run all 340 tests
npm test

# With coverage
npm test -- --coverage

# Single suite
npm test -- tests/pii-safety.test.ts

# Watch mode
npm run test:watch
```

### Test Suites

| Suite | Tests | Purpose |
|---|:---:|---|
| `pipeline.test.ts` | 25 | Full orchestration end-to-end |
| `pii-safety.test.ts` | 12 | ⚠️ CI gate — no plaintext PII in payloads |
| `crm-event-set-manager.test.ts` | 22 | Event set list / create / provision / resolve |
| `event-set-routes.test.ts` | 17 | Event set HTTP routes |
| `event-filter.test.ts` | 10 | Standard event + DFO stage mapping |
| `tiktok-event-builder.test.ts` | 20 | Payload structure + standard events |
| `tiktok-oauth.test.ts` | 26 | OAuth2 flow |
| `oauth-routes.test.ts` | 18 | OAuth HTTP routes + CSRF |
| `token-store.test.ts` | 14 | Token persistence + cache |
| `redis-dedup.test.ts` | 12 | Deduplication + fail-open |
| `event-log.test.ts` | 14 | Postgres event audit log |
| `match-rate.test.ts` | 18 | Identity signal quality scoring |
| `normalizer.test.ts` | 24 | Email, phone, name normalization |
| `normalizer.edge-cases.test.ts` | 31 | International + unicode edge cases |
| `hasher.test.ts` | 16 | SHA-256 + deterministic event IDs |
| `identity-enrichment.test.ts` | 16 | Signal extraction |
| `tiktok-api-client.test.ts` | 9 | HTTP client + retry logic |
| `postback-compliance.test.ts` | 36 | TikTok postback spec compliance |
| **Total** | **340** | |

---

## Deployment

### Docker

```bash
docker build -t salesforce-tiktok-crm .
docker run --env-file .env -p 3000:3000 salesforce-tiktok-crm
```

### Production Checklist

- [ ] `NODE_ENV=production`
- [ ] `LOG_LEVEL=info` (not `debug` — avoids token logging)
- [ ] Redis TLS enabled (`REDIS_TLS=true`)
- [ ] Postgres SSL enabled
- [ ] `TIKTOK_REDIRECT_URI` points to your public HTTPS domain
- [ ] Complete OAuth flow at `/auth/tiktok` after deployment
- [ ] Verify events appear in TikTok Events Manager within 10 minutes
- [ ] Confirm ≥50 signals per funnel stage per 14 days for DFO to activate

---

## Security & Compliance

### PII Handling

All PII is SHA-256 hashed before leaving the server. `pii-safety.test.ts` is a mandatory CI gate that fails if any plaintext PII is found in a TikTok API payload.

| Field | Treatment |
|---|---|
| `email` | SHA-256 (normalized) |
| `phone_number` | SHA-256 (E.164 normalized) |
| `first_name` | SHA-256 (lowercase) |
| `last_name` | SHA-256 (lowercase) |
| `external_id` | SHA-256 |
| `ttclid` | Plaintext (required by TikTok spec) |
| `ip` | Plaintext (required by TikTok spec) |
| `user_agent` | Plaintext (required by TikTok spec) |
| `lead_id` | Plaintext (TikTok native ID) |

### Other Security Measures

- **Structured log redaction** — pino redacts all token and PII fields from logs
- **CSRF protection** — OAuth state verified with constant-time comparison
- **One-time state tokens** — OAuth state keys deleted from Redis immediately after use
- **Fail-open deduplication** — Redis unavailable → events flow through (data accuracy over availability)
- **Non-retryable codes** — 400/401/403 from TikTok are never retried

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| TikTok standard events | No manual Events Manager mapping; auto-aligns to campaign objectives; DFO-eligible out of the box |
| Auto event set provisioning | Removes the only remaining manual onboarding step after OAuth |
| Deterministic event IDs | SHA-256 of `leadId + eventName + eventTime` — prevents duplicate conversions under retries |
| Two-layer retry (axios + BullMQ) | Immediate transient retries + durable queue that survives process restarts |
| CDC `commitTimestamp` for `event_time` | TikTok spec requires the time the status changed in the CRM, not pipeline processing time |
| Redis token cache + Postgres source of truth | Sub-millisecond token reads on hot path; durable refresh token storage |
| Proactive token refresh | Refreshes 1h before expiry — prevents mid-day pipeline stalls from expired 24h tokens |
| Per-advertiser event set resolution | Redis → Postgres → env fallback supports both single and multi-advertiser deployments |
