# Architecture

Single Node process: React SPA in `web/`, HTTP + WebSocket API in `server/`, shared contracts in `shared/`. One deployable serves the built SPA and `/api`. Marketplace data goes through a store facade (Postgres or local JSON). Voice writes do not: they are Postgres-only and always pass the VoiceOps orchestrator.

## Layout

| Path | Role |
|------|------|
| `web/` | Vite + React 19 SPA. Hash routes (`web/src/ui/route.ts`). Pages by role in `web/src/pages`, `inbox/`, `live/`, `conversation/`, `voiceops/`. |
| `web/src/api.ts` | Typed `fetch` client. Cookie session, `X-Demo-Epoch` watch. |
| `web/src/chat/` | Nexconn chat SDK, calls, translation, presence. |
| `server/index.ts` | `node:http` router, cookie auth, static `dist/web`, Nexconn side effects. |
| `server/store.ts` | Persistence facade → `store-pg.ts` or `store-json.ts`. |
| `server/db/` | `pg` pool, additive SQL migrations `001`–`008`. |
| `server/voiceops/` | Seller voice API, Gemini Live relay, orchestrator, policy, digest. |
| `server/agents/` | Multi-agent team + reasoning traces. Proposals re-enter the orchestrator. |
| `shared/types.ts`, `shared/catalog.ts` | Roles, orders, products, Nexconn message types. |
| `test/` | `node:test` against the same modules. |

Roles in data: `member` (buyer), `volunteer` (seller), `coordinator` (support). UI sections follow that split (`web/src/App.tsx`).

## Layers

1. **UI** — Hash SPA. `Shell` + role screens. Chat UI talks to Nexconn directly after the server issues a token. Voice UI opens a WebSocket to this server, not to Gemini.
2. **HTTP edge** — `server/index.ts` matches `/api/*` by method and path (no Express). VoiceOps routes are delegated to `server/voiceops/routes.ts` and return first. Everything else is marketplace, auth, live rooms, or static files. Validation lives in `server/validate.ts`. Errors are `{ error: { code, message } }`.
3. **Domain** — Marketplace: `store.ts` plus `auth.ts`, `cards.ts`, `live.ts`, `triage.ts`, `replies.ts`, `listing.ts`, `assist.ts`, `demo-reset.ts`. Voice: `orchestrator.ts` is the only path that mutates shop data for the model. `policy.ts` and `agents/reasoning.ts` gate writes. `agents/team.ts` plans work; specialists never write tables themselves.
4. **Persistence** — `DATABASE_URL` → Postgres (`server/db/pool.ts`, Neon-friendly). Unset and not production → JSON file (`SHOPBRIDGE_DATA_DIR` or `./data`). Production refuses to start without `DATABASE_URL`. VoiceOps tables are queried with the pool directly, so voice requires Postgres.
5. **External adapters** — `server/nexconn.ts` (REST), `server/gemini-keys.ts` + `assist.ts` (Gemini text), `server/voiceops/live.ts` (Gemini Live WebSocket).

## Data flow

**Marketplace.** Browser `fetch("/api/…")` with the `shopbridge_session` cookie (legacy `saathi_session` still accepted). Vite dev proxies `/api` (including WebSocket) from `:5173` to `:8787`. Handlers call `store.ts`, which picks Postgres or JSON. Checkout, offers, order status, and support cases are store operations. Order-room events are posted server-side as the system user (`shopbridgesystem`) through Nexconn custom types (`SB:Offer`, `SB:Track`, `SB:Order`, `SB:Live`, …).

**Chat and calls.** Server creates or joins group channels and issues an access token (`POST /api/chat/token`). The browser SDK (`@nexconn/chat`, `@nexconn/call`) connects to Nexconn for messages, presence, translation, and calls. The app database stores `channel_id`, not the transcript.

**Voice (seller only).** `LiveClient` (`web/src/voiceops/liveClient.ts`) opens `WS /api/voiceops/live`. The server authenticates the cookie, opens Gemini Live with the API key, and forwards PCM audio both ways. Tool calls go to `orchestrator.runTool`: reads run immediately; writes insert a `voiceops_approvals` row, return a read-back, and execute only after tap or a verified spoken yes (`confirm_action`). Execution is a Postgres transaction plus an audit row in `voiceops_actions`. Customer-visible text is sent through the `notifier`, which posts into the order’s Nexconn channel. Debug `POST /api/voiceops/tools/:name` is off in production unless `VOICEOPS_DEBUG_TOOLS=1`.

**Agent team.** `POST /api/voiceops/agents/run` (or the `run_agent_team` tool) starts a run. Monitor reads shop state; Supervisor plans with Gemini JSON and falls back to `rulePlan`. Specialists propose through the same orchestrator tools. Steps land in `agent_runs` / `agent_steps` and show on the Agent network tab. Human approval is still required.

**Demo epoch.** API responses send `X-Demo-Epoch`. A change means a shared demo reset; the SPA remounts.

## Integration points

| System | Where | Contract |
|--------|--------|----------|
| Neon / Postgres | `DATABASE_URL`, `server/db/pool.ts` | Marketplace + VoiceOps + agent tables. Migrations `001_init` … `008_agent_team`. Boot checks schema; `SHOPBRIDGE_AUTO_MIGRATE=1` applies them (Render). |
| Nexconn | `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET`, `NEXCONN_API_BASE` (default Singapore) | Rooms, system messages, chat tokens, live open channels. Browser SDK uses the same app key. Missing keys degrade chat, not the catalog. |
| Gemini text | `GEMINI_API_KEY` (+ backups), `server/gemini-keys.ts` | Support drafts (`assist.ts`), triage, listing drafts, daily digest, supervisor plan. Key stays on the server. Unavailable paths fall back to rules or skip the draft. |
| Gemini Live | `GEMINI_LIVE_MODEL`, `GEMINI_LIVE_URL` | Bidirectional audio at `/api/voiceops/live`. Tool declarations in `orchestrator.ts`. |
| Render | `render.yaml` | One Node web service, health `GET /api/health`, `npm start` after `vite build`. Serves `dist/web` and the API on `PORT` (default 8787). |
| Railway | `railway.json` | Alternate host; same process. |

Session cookies are `HttpOnly`; `Secure` in production. Static HTML gets a CSP. JSON store is single-process only.

## Evidence (file paths)

- Router and static host: `server/index.ts` (`handleApi`, `handleStatic`, `attachLiveRelay`)
- Vite proxy and build output: `vite.config.ts` (`root: web`, `outDir: ../dist/web`, `/api` → `:8787`)
- SPA gate and role screens: `web/src/App.tsx`, `web/src/ui/route.ts`, `web/src/ui/nav.ts`
- HTTP client: `web/src/api.ts`
- Store switch: `server/store.ts`, `server/store-pg.ts`, `server/store-json.ts`, `server/store-types.ts`
- Schema: `server/db/migrations/001_init.sql`, `002_lifecycle_language_demo.sql`, `003_offers_shipment.sql`, `004_voiceops.sql`, `005_voiceops_orders.sql`, `006_voiceops_latency.sql`, `007_voiceops_baselines.sql`, `008_agent_team.sql`
- Shared contracts: `shared/types.ts` (`ROLES`, `MESSAGE_TYPES`, `OrderView`)
- Voice HTTP + Live relay: `server/voiceops/routes.ts`, `server/voiceops/live.ts`, `web/src/voiceops/liveClient.ts`
- Write gate: `server/voiceops/orchestrator.ts` (`toolDeclarations`, `runTool`), `server/voiceops/policy.ts`, `server/agents/reasoning.ts`, `server/agents/team.ts`
- Chat adapter: `server/nexconn.ts`, `web/src/chat/nexconn.ts`, `web/src/chat/calls.ts`
- Gemini text: `server/assist.ts`, `server/gemini-keys.ts`
- Config: `.env.example`, `server/env.ts`, `render.yaml`, `railway.json`
