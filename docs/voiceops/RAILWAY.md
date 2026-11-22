# Deploying ShopBridge VoiceOps on Railway

One Node service (serves the web app, `/api`, and the voice WebSocket) plus the Railway Postgres add-on.
Run exactly one instance: the spend caps and voice session limits are held in memory.
**Never reuse the old production Neon database.** Use a fresh Railway Postgres.

## 1. Create the project
1. Railway > New Project > Deploy from GitHub repo > pick the ShopBridge-VoiceOps repo.
2. Add a Postgres database to the same project (New > Database > PostgreSQL).
3. `railway.json` in the repo already sets build (`npm ci --include=dev && npm run build`), start (`npm start`) and the health check
   (`/api/health`). Leave the service at one replica.

## 2. Variables on the web service
Reference the database with Railway's variable reference rather than pasting a URL: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SHOPBRIDGE_AUTO_MIGRATE` | `1` (applies migrations 001 to 006 on boot) |
| `SHOPBRIDGE_DEMO_PASSWORD` | a password you choose; must equal the one used when seeding |
| `GEMINI_API_KEY` | primary key (billing-enabled Google Cloud project) |
| `GEMINI_API_KEY_BACKUP` | backup key from a different project |
| `GEMINI_API_KEY_BACKUP_2` … `_9` | more backup keys; every call rotates through all keys and fails over |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` |
| `GEMINI_LIVE_FALLBACK_MODELS` | `gemini-3.1-flash-live-preview` |
| `GEMINI_MODEL` | `gemini-2.5-flash` (text model; the auto-picked one was unreliable) |
| `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET`, `NEXCONN_API_BASE` | from your Nexconn console |
| `VOICEOPS_DEMO` | `1` (shows the Reset demo scenario button in production) |
| `VOICEOPS_MAX_CONCURRENT` | `3` |
| `VOICEOPS_MAX_SESSIONS_PER_IP_DAY` | `40` |
| `VOICEOPS_MAX_AUDIO_MIN_PER_DAY` | `180` |

Do not set `PORT` (Railway provides it) or `SHOPBRIDGE_ALLOW_RESEED`.

## 3. Seed the hosted database once (from your laptop)
Production blocks reseeding by design, so seed from your machine against Railway's PUBLIC database URL
(Postgres service > Connect > Public network). Keep it in your shell only, never in git:

```bash
export DATABASE_URL='<railway public postgres url>'
export SHOPBRIDGE_DEMO_PASSWORD='<same as the service variable>'
npm run db:migrate
npm run seed        # wipes and seeds; safe only on this fresh database. Uses your Nexconn keys from .env.
```

## 4. Smoke test on the Railway address
1. `https://<your-app>.up.railway.app/api/health` returns `{"ok":true,"backend":"postgres",...}`.
2. Click Seller > Voice > Overview > **Run check**: database, primary key, backup key and Nexconn should all be OK.
3. Overview > **Reset demo scenario**, then run two voice scenarios from `DEMO_SCRIPT.md`.
4. Sign in as Buyer in another window and confirm a message sent for order 1050 appears in the order conversation.

## 5. Before you present
Run the check again on the venue network, keep a phone hotspot ready, and have the backup video open.
After the event, rotate both Gemini keys and delete the Railway project or its variables.

## Troubleshooting
- Build fails with `vite: not found`: the build command must keep `--include=dev`.
- Voice says busy or budget used: raise the caps above or wait for the daily reset.
- Mic works locally but not on Railway: the site must be on HTTPS (Railway provides it).
- Voice connects then fails: run the check; a rejected key falls back to the backup key automatically.
