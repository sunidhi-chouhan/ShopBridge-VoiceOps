# Deploy ShopBridge VoiceOps on Render

One free Node web service plus one free Render Postgres database. `render.yaml` is the Blueprint. Secrets are not in git. Render asks for them when you create the Blueprint.

The web service and the database must stay in the same region (`singapore` in the Blueprint) so the app can use the database's internal URL. Keep the service at one instance. Voice spend caps are held in memory.

## 1. Put this file on GitHub

`render.yaml` has to be on `main` before Render can read it. Commit and push it, then continue below.

## 2. Create the Blueprint

1. Render Dashboard → **New** → **Blueprint**.
2. Connect GitHub if needed, then select `sunidhi-chouhan/ShopBridge-VoiceOps`.
3. Render reads `render.yaml` and prompts for the secret variables. Fill these in. Do not leave them blank:

| Prompt | Value |
| --- | --- |
| `SHOPBRIDGE_DEMO_PASSWORD` | a password you choose |
| `GEMINI_API_KEY` | primary key from a billing-enabled Google Cloud project |
| `GEMINI_API_KEY_BACKUP` | key from a different Google Cloud project |
| `NEXCONN_APP_KEY` | Nexconn Console → Key Management |
| `NEXCONN_APP_SECRET` | the matching app secret |

4. Apply the Blueprint. Render creates `shopbridge` and `shopbridge-db`, sets `DATABASE_URL` from the database, and deploys.

These are already set in `render.yaml`: Node 22, `NODE_ENV=production`, `SHOPBRIDGE_AUTO_MIGRATE=1`, the Gemini model names, `NEXCONN_API_BASE`, and the voice caps. Do not set `PORT` or `SHOPBRIDGE_ALLOW_RESEED`.

In the Nexconn console for that app key, turn on translation, pre-join history, and audio/video calling.

## 3. Seed once from your laptop

`SHOPBRIDGE_AUTO_MIGRATE=1` applies the schema on boot. Demo accounts are loaded separately. Production refuses reseeding, so run this from your machine against the database's **external** URL (database page → Connect → External). Keep the URL in the shell only.

```bash
export DATABASE_URL='<render external postgres url>'
export SHOPBRIDGE_DEMO_PASSWORD='<same password you entered in Render>'
npm run db:migrate
npm run seed
```

`npm run seed` also reads `NEXCONN_APP_KEY` and `NEXCONN_APP_SECRET` from your local `.env`. Run it only against this new database. It wipes and reseeds.

## 4. Check

1. Open `https://<your-app>.onrender.com/api/health`. A working deploy returns `{"ok":true,"backend":"postgres",...}`.
2. Sign in as Seller → Voice → Overview → **Run check**. Database, both Gemini keys, and Nexconn should be OK.

Demo accounts are `buyer@shopbridge.demo`, `seller@shopbridge.demo`, and `support@shopbridge.demo`, all using `SHOPBRIDGE_DEMO_PASSWORD`.

## Free-plan limits

- The web service sleeps after about 15 minutes without traffic. The next visit takes about a minute to wake. Open the URL a few minutes before a live demo.
- A free Render Postgres database expires 30 days after creation, then has a 14-day grace period before Render deletes it. There are no backups on the free database.
- A workspace can have only one free Postgres database.

## Build note

The build command keeps `--include=dev` because Vite is a dev dependency and Render installs with `NODE_ENV=production`. Without that flag the build fails with `vite: not found`.
