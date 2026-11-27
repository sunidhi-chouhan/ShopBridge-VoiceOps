# ShopBridge VoiceOps

Conversation-first marketplace plus a seller voice agent. Gemini proposes; the server checks policy and a human yes before any shop write. Details live in [`.context/OVERVIEW.md`](.context/OVERVIEW.md).

## Tech Stack

- Language/Framework: TypeScript 7, React 19, Node.js >=20 (Render Node 22), Vite 8
- Dependencies: `@nexconn/chat` and `@nexconn/call` 26.2.1, `pg` 8, `bcrypt`, `ws`, `motion`; Gemini text and Gemini Live
- Database: PostgreSQL 18 on Render; local JSON file `data/store.json` when `DATABASE_URL` is unset
- Build tool: Vite (`vite build` → `dist/web`); `tsx` runs the API
- Test framework: Node.js built-in test runner (`node:test` via `tsx`)

[Full stack](.context/stack.md)

## Commands

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm run dev` | API + Vite watcher |
| `npm run build` | Build the SPA |
| `npm test` | Unit tests (`test/*.test.ts`) |
| `npm run typecheck` | `tsc --noEmit` |

No lint script. Full copy-paste commands: **`.context/stack.md` § Commands** (canonical).

## Code Conventions

- Strict TypeScript, named exports, double quotes, semicolons, 2-space indent. Server files are kebab-case; React components are PascalCase.
- Raw `node:http` routes. Errors are `{ error: { code, message } }`. Persistence goes through `server/store.ts`.
- Tests live in `test/`, not next to source. Postgres suites skip when the local `*_test` database is down.
- Stored roles are `member` / `volunteer` / `coordinator`. Demo labels are buyer / seller / support. Package name is still `saathi`.

[Gotchas](.context/conventions.md)

## Boundaries

- Never let the model write business data. Writes go through `server/voiceops/orchestrator`.
- Never treat a model-claimed “yes” as approval. Approval is a UI tap or a server-checked transcript bound to the exact arguments.
- Never put `GEMINI_API_KEY` or the Nexconn App Secret in the browser.
- Never run `npm run seed`, reseed, or tests against hosted or production Postgres.
- Do not commit `.env`, `data/`, or `backups/`. Production refuses to start without `DATABASE_URL`. VoiceOps does not work on the JSON store.
