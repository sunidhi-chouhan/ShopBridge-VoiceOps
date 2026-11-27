# Stack

Single Node process (`saathi` 0.1.0, ESM). Vite builds the React SPA to `dist/web`; `tsx` serves the API and the built SPA. No Python, Ruby, Go, Dockerfile, docker-compose, or CI workflow.

## Runtime and languages (with versions)

- **Node.js:** `engines.node` is `>=20` (`package.json`). Render sets `NODE_VERSION=22` (`render.yaml`). Vite and `@vitejs/plugin-react` require `^20.19.0 || >=22.12.0` (lockfile engines). No `.nvmrc` or patch pin.
- **TypeScript:** 7.0.2 (lockfile). `tsc` target `ES2022`, `jsx: react-jsx`, `strict` (`tsconfig.json`).
- **Module format:** `"type": "module"`.

## Major dependencies (name + version)

Locked in `package-lock.json` (lockfileVersion 3). Manifest ranges match these exact versions.

| Package | Version | Role |
| --- | --- | --- |
| react / react-dom | 19.3.1 | UI |
| vite | 8.3.5 | Frontend build (devDependency) |
| @vitejs/plugin-react | 6.2.1 | Vite React plugin |
| typescript | 7.0.2 | Typecheck |
| tsx | 4.23.15 | Run/watch server TypeScript |
| concurrently | 9.2.5 | Dev: server + Vite |
| @nexconn/chat | 26.2.1 | Chat SDK |
| @nexconn/call | 26.2.1 | Call SDK (peers pin chat/engine 26.2.0; `.npmrc` sets `legacy-peer-deps=true`) |
| @nexconn/engine | 26.2.1 | Nexconn engine |
| pg | 8.23.1 | PostgreSQL client |
| bcrypt | 6.0.0 | Password hashes |
| ws | 8.23.0 | WebSockets |
| motion | 14.9.0 | UI animation |

## Database / storage

- **Local default:** JSON file `data/store.json` when `DATABASE_URL` is unset (`.env.example`, README).
- **Production:** PostgreSQL 18. Render Blueprint database `shopbridge-db`, `postgresMajorVersion: "18"`, region `singapore`. App reads `DATABASE_URL`.
- **Tests:** disposable Docker image `postgres:18` on `127.0.0.1:55432`, database `shopbridge_test` (`npm run test:pg:up`).
- **Optional local VoiceOps Postgres:** README uses image tag `postgres:16` on port 55433. That tag is not the production major version.
- `.env.example` comments Neon as a possible `DATABASE_URL` host. The checked-in deploy target is Render Postgres, not a Neon project file.
- Gemini and Nexconn are external HTTP APIs (keys in env). No object-storage SDK in the manifest.

## Deployment target

**Render** free web service `shopbridge`, runtime `node`, region `singapore`, branch `main`, one instance (`render.yaml`, `RENDER.md`).

- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- Health: `/api/health`
- `NODE_ENV=production`, `SHOPBRIDGE_AUTO_MIGRATE=1`
- No Dockerfile. No GitHub Actions or other CI yml in the repo.

## Commands

From README “Local run” / “Tests” and `package.json` scripts. Render build is the deploy install+build. There is no lint script.

Install:

```bash
npm install
```

Install (Render build, exact):

```bash
npm ci --include=dev
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

Test with disposable Postgres (README):

```bash
npm run test:pg:up
npm test
npm run test:pg:down
```

Lint:

none

Typecheck:

```bash
npm run typecheck
```

Start after build:

```bash
npm start
```

`npm run typecheck` is `tsc --noEmit`. `npm test` is `node --import tsx --test --test-concurrency=1 test/*.test.ts`. `npm run dev` is the local API + Vite watcher. `npm run build` is `vite build`.

## Evidence (file paths)

- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/package.json`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/package-lock.json`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/tsconfig.json`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/.npmrc`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/.env.example`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/render.yaml`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/RENDER.md`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/README.md`
- Absent: `pyproject.toml`, `requirements*.txt`, `Gemfile`, `go.mod`, `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*`
