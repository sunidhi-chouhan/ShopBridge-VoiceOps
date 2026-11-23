# ShopBridge

**Every order has a conversation — in every language.** A Hindi-reading buyer and an English-writing
seller talk about an order in one Nexconn channel, each reading in their own language. When something
goes wrong, a support agent joins the *same* conversation with its full history and resolves it.

Built on the **Nexconn Chat SDK** (`@nexconn/chat` 26.2.1) and **Call SDK** (`@nexconn/call` 26.2.1).

## Nexconn features used

| Feature | Nexconn API |
| --- | --- |
| One group channel per order; server-only membership | Server API `group-channel/create` (`joinPerm: 3`), `group-channel/join` |
| Live translation of the whole conversation | `translateModule.translateMessages`, `translateTexts`, `TranslateHandler` |
| Support agent sees history from before joining | Console "pre-join history" + `createMessagesQuery` |
| Photos, files, voice notes | `Helper.createSend{Image,GIF,File,HDVoice}MessageParams` + `sendMediaMessage` |
| Voice transcript | `message.requestSpeechToText()` / `onSpeechToTextCompleted` |
| Reply, edit, delete | `SendReferenceMessageParams`, `BaseChannel.updateMessage`, `deleteMessageForAll` / `deleteMessagesForMe` |
| Reactions | message metadata (`setMetadata` / `onMessageMetadataUpdated`) |
| Read receipts, unread | `needReceipt`, `sendReadReceiptResponse`, `getMessageReadReceiptInfo`, `clearUnreadCount` |
| Drafts, pin, mute | `saveDraft`, `pin`/`unpin`, `setNoDisturbLevel` |
| Order events, offers, tracking, order & call cards, typing | `registerCustomMessages` (`SB:*`), server-sent where trust matters |
| **Live sale rooms** ("Live from the loom"): seller puts a piece on stage, viewers chat in their own language, send hearts and buy in one tap | **Open channels**: Server API `open-channel/create`, `get` (live viewer count), `metadata/batch/set` (featured product, sold count), `message/send`, `destroy`; client `OpenChannel.enterChannel` / `exitChannel`, `getMetadata`, `createOpenChannelMessagesQuery`, `OpenChannelHandler` (participants, metadata, destroyed) |
| Voice & video calls | `NCCallEngine` `startCall` / `acceptCall` / `endCall`, `setLocal/RemoteVideoView`, media switch |
| Connection state | `addConnectionStatusHandler` |

> `.npmrc` sets `legacy-peer-deps=true`: `@nexconn/call` 26.2.1 pins its peers to chat/engine 26.2.0
> while the app uses 26.2.1. `npm ci` on Render uses it automatically.

ShopBridge is a single Node.js process that serves the Vite React app (`dist/web`) and the `/api` backend.

- **Local default:** JSON file `data/store.json` (when `DATABASE_URL` is unset).
- **Hosted / production:** PostgreSQL via `DATABASE_URL`. Render Free is defined in `render.yaml` (see `RENDER.md`).

## Local run

```bash
cp .env.example .env
# Set NEXCONN_APP_KEY and NEXCONN_APP_SECRET (server-only). Never commit .env.
# Optional: DATABASE_URL for local Postgres; omit to use JSON.
npm install
npm run seed          # local JSON only — never against hosted Postgres
npm run dev
```

Open the Vite URL (default http://127.0.0.1:5173). Use Explore Demo buttons, or email sign-in. Demo account emails and password setup are in `DEMO.md`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API + Vite with proxy |
| `npm run build` | Production frontend → `dist/web` |
| `npm start` | Serve API + built SPA (`tsx server/index.ts`) |
| `npm run seed` | **Local wipe/rebuild** of `data/store.json` |
| `npm run demo:prepare` | Soft-clean local demo clutter |
| `npm run demo:accept` | Local API smoke (needs running server) |
| `npm run db:migrate` | Apply Postgres schema migrations |
| `npm run db:import:dry` | Dry-run JSON → Postgres import |
| `npm run db:import` | Import curated `data/store.json` into Postgres |
| `npm run db:verify` | Compare JSON vs Postgres (safe fields only) |
| `npm test` | Store, auth and HTTP API tests (Node test runner) |
| `npm run test:pg:up` / `test:pg:down` | Start / stop the disposable local Postgres 18 used by tests |

## Tests

```bash
npm run test:pg:up   # local Docker Postgres on 127.0.0.1:55432 (RAM only)
npm test
npm run test:pg:down
```

Tests never read `.env` and refuse any database that is not on localhost with a name ending in `_test`, so they cannot touch Neon. Without the container, the Postgres suites are skipped and the rest still run.

`POST /api/dev/reseed` is refused when `NODE_ENV=production`.

## Nexconn Console prerequisites (production App Key)

- Translation: **Enabled**
- Pre-join history access by new member: **Allowed**
- Audio & video calling: **Enabled** (otherwise calls show "not enabled for this App Key", SDK code 80006)
- Speech-to-text (optional, for voice transcripts)

## Deploy

See `RENDER.md`. `render.yaml` creates the Render web service and Postgres database. Do not put secrets in git.

## Safety

- Never commit `.env`, `data/`, or `backups/`.
- The Nexconn App Secret stays on the server.
- Chat tokens are issued only to authenticated sessions.

---

## VoiceOps: voice-driven agentic workflows (Gemini Live)

Multi-agent team + reasoning engine: a Supervisor (Gemini planner) coordinates an Operations monitor, Customer-comms, Inventory and
Support-triage agents; every proposal passes a rules-based reasoning engine that records a decision trace (facts, rules, verdict, why)
before a human approves (`server/agents/`, Voice AI → Agent network).

Gemini automation across the app (details in `docs/voiceops/SUBMISSION.md`): the seller voice agent (orders, returns, stock,
messages, special-price offers, one-approval delay notices to every late customer, proactive briefing), Gemini triage of the
support queue with a policy-checked suggested resolution, smart replies in seller and support chat, listings drafted from the
cover photo, support reply drafts and the multilingual daily digest.

A seller talks to ShopBridge in Hindi, Hinglish or English. The agent looks up real orders, proposes changes, reads them back,
waits for a spoken or tapped approval, executes through a validated backend and confirms by voice.

- **Seller screen:** sign in as the demo **Seller**, open **Voice**. Tabs: Voice agent, Approvals, Activity, Overview.
- **Safety:** Gemini never writes data. `server/voiceops/orchestrator.ts` checks ownership and policy, requires an approval bound to the
  exact arguments, enforces idempotency, audits every call and supports undo. Spoken approvals are verified against the server's own transcript.
- **Docs:** `docs/voiceops/PLAN.md` (architecture and measurements), `CHALLENGE.md`, `DEMO_SCRIPT.md`, `SCENARIO_RESULTS.md`.

### Run it locally (never against the production database)

```bash
npm run test:pg:up                      # test Postgres on :55432
docker run -d --name sb-dev-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=shopbridge_dev -p 127.0.0.1:55433:5432 postgres:16
# .env: DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55433/shopbridge_dev, GEMINI_API_KEY, GEMINI_LIVE_MODEL=gemini-3.8-live
npm run db:migrate
SHOPBRIDGE_DEMO_PASSWORD=devpass NEXCONN_APP_KEY= NEXCONN_APP_SECRET= npm run seed   # blank keys: no real Nexconn rooms
npm run build && SHOPBRIDGE_DEMO_PASSWORD=devpass PORT=8791 npm start
```

Optional env: `GEMINI_VAD_SILENCE_MS` (default 300), `GEMINI_COST_IN_PER_MIN`, `GEMINI_COST_OUT_PER_MIN` (USD per audio minute, for cost per workflow).

### Verify

```bash
npm test                                                    # 70+ tests (policy, orchestrator, relay with a fake Gemini)
BASE=http://127.0.0.1:8791 node scripts/voiceops-scenarios.mjs --out docs/voiceops/SCENARIO_RESULTS.md   # real Gemini, 5 scenarios
```
