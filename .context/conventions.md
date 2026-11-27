# Conventions

No ESLint, Prettier, Biome, EditorConfig, or PR template. Style is the TypeScript compiler plus the patterns already in the tree. `package.json` `"type": "module"`. Node `>=20`.

## Style and naming

- **TypeScript.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `forceConsistentCasingInFileNames`, `jsx: react-jsx`, target ES2022 (`tsconfig.json`). Double quotes, semicolons, 2-space indent. `import type` for types. Named exports only; `vite.config.ts` is the default-export exception.
- **Files.** Server and shared modules are lowercase, hyphenated when compound: `server/demo-reset.ts`, `server/store-pg.ts`, `shared/types.ts`. React components are PascalCase files (`web/src/ui/Button.tsx`, `web/src/pages/SellerOrders.tsx`). Hooks, clients, and non-component modules stay camelCase (`useVoiceAgent.ts`, `api.ts`, `languagePrefs.ts`). Tests mirror the subject: `test/store-pg.test.ts`.
- **Identifiers.** `camelCase` functions and locals. Domain enums are `SCREAMING_SNAKE` `as const` arrays in `shared/types.ts`, with the type derived as `(typeof ROLES)[number]`. Error codes are the same case (`VALIDATION_ERROR`, `UNAUTHENTICATED`). React components are `export function Button`, not arrow consts. Hooks are `useX` and throw if used outside their provider (`useSession`).
- **Errors.** Server throws `HttpError(status, code, message)` (`server/errors.ts`). HTTP responses are `{ error: { code, message } }` plus security headers and `X-Demo-Epoch` (`sendJson` / `sendError` in `server/index.ts`). Unexpected errors become `500 SERVER_ERROR` with a generic sentence; Nexconn failures become `502 CHAT_SERVICE_ERROR` and the vendor name is stripped. The browser mirror is `ApiError` in `web/src/api.ts`. A `401` with code `UNAUTHENTICATED` fires `onUnauthorized`.
- **Validation.** One parser per field in `server/validate.ts`. Bad input is `422 VALIDATION_ERROR` with a short user-facing sentence (“Enter a valid email address.”). IDs must match `/^[a-z0-9]{8,40}$/` or the parser returns `404 NOT_FOUND`. New ids are `prefix + randomBytes(6).hex` (`server/store-json.ts`).
- **Server shape.** Raw `node:http`, not a framework. Routes and handlers are functions in `server/index.ts` and `server/voiceops/routes.ts`. Persistence goes through the `server/store.ts` facade, which delegates to `store-pg` or `store-json`.
- **UI.** Global CSS, not CSS modules: tokens in `web/src/styles.css` (`--ink`, `--ease`, `--space-*`), feature sheets beside features (`inbox.css`, `live.css`, `flair.css`). Class names are kebab with state prefixes (`btn`, `btn-primary`, `is-pending`, `is-magnetic`), joined with `.filter(Boolean).join(" ")`. Motion uses `cubic-bezier(0.16, 1, 0.3, 1)`, never `transition: all`, and honors `prefers-reduced-motion`. Visual work follows `.cursor/rules/creative-ui.mdc` (asymmetric layout, glass surfaces, WCAG AA).
- **Comments.** Short JSDoc on non-obvious exports (why a guard exists). Inline comments explain a trap, not the next line.

## Testing

- **Runner.** Node’s built-in test runner: `npm test` → `node --import tsx --test --test-concurrency=1 test/*.test.ts`. Assert with `node:assert/strict`. `describe` / `it` / `before` / `after` from `node:test`. No Vitest, Jest, Playwright, or Cypress in `npm test`.
- **Where.** All automated tests live in top-level `test/`, not next to source. `test/helpers.ts` is shared setup, not a suite. `tsconfig.json` `include` is `server`, `shared`, `web/src`, `vite.config.ts` — **`npm run typecheck` does not typecheck `test/`**.
- **Layers.**
  - Unit, no database: `auth.test.ts`, `triage.test.ts`, `reasoning.test.ts`, `gemini-keys.test.ts`, `assist.test.ts`, `voiceops-policy.test.ts`. Gemini is stubbed by replacing `globalThis.fetch` or unsetting `GEMINI_API_KEY`.
  - JSON store on a temp directory: `store-json.test.ts`.
  - Postgres (skip if the container is down): `store-pg.test.ts`, `api.test.ts` (spawns `server/index.ts`), `demo-reset.test.ts`, `voiceops-orchestrator.test.ts`, `voiceops-live.test.ts`.
- **Postgres safety.** Import `./helpers` before any server module. It sets `SHOPBRIDGE_SKIP_DOTENV=1` so a real `.env` is never loaded (`server/env.ts` honors that). `safeTestDatabaseUrl()` allows only `127.0.0.1` / `localhost` / `::1` and a database name ending in `_test` (default `postgresql://postgres:test@127.0.0.1:55432/shopbridge_test`). Suites probe with `postgresAvailable` and pass `{ skip: PG_SKIP_REASON }` when Docker is down. Start the DB with `npm run test:pg:up`. Reset with `resetTestSchema` (drops and recreates `public`) then dynamic-import `../server/db/migrate` **after** `process.env.DATABASE_URL` is set.
- **Outside `npm test`.** `npm run demo:accept` runs `scripts/e2e-phase41-acceptance.mjs`. Video checks live under `scripts/video/`.

## Gotchas

- **Saathi rename is incomplete.** npm package name is still `saathi`. Session cookie is `shopbridge_session`; `saathi_session` is still accepted (`server/index.ts`). Do not invent a third name.
- **Two vocabularies for the same people.** Demo parties are `buyer` | `seller` | `support` (`DEMO_PARTIES` in `server/demo-seed.ts`). Stored roles are `member` | `volunteer` | `coordinator`. Buyer cart/checkout checks `role === "member"`. Emails are `buyer@shopbridge.demo`, `seller@shopbridge.demo`, `support@shopbridge.demo`.
- **Two stores.** `DATABASE_URL` selects Postgres. Without it, non-production uses the JSON file store. Production with no `DATABASE_URL` throws `503 DATABASE_REQUIRED` and never falls back. Import store modules only after the URL is set; `store.ts` calls `loadEnvFile()` at import time.
- **Legacy order status.** `ORDER_STATUSES` still includes `completed`. New orders move `placed → packed → shipped → delivered` (`ORDER_FLOW`). `cancelled` is outside that flow.
- **Demo product ids are fixed** (`pdemosari`, …) so reset is repeatable. Order and request ids are new every seed so Nexconn rooms (`order{orderId}`) stay clean (`server/demo-seed.ts`).
- **`.env` does not override the process.** `loadEnvFile` fills only keys that are `undefined`. Tests and hosts set variables first. `SHOPBRIDGE_DEMO_PASSWORD` is required for seed and password sign-in.
- **Rate limits are in-memory** (`server/auth.ts`), keyed `bucket:left-most-X-Forwarded-For`, 15-minute window. Demo role switches have a much larger budget than password attempts. Tests must `resetAuthRate()` in `beforeEach`.
- **Peer deps.** `.npmrc` sets `legacy-peer-deps=true` because `@nexconn/call` pins older `@nexconn/chat` and `@nexconn/engine`.
- **UI entry.** `web/src/main.tsx` renders `CallPreview` only when `import.meta.env.DEV` and the hash starts with `#/__calls`. Everything else is `StrictMode` → `ToastProvider` → `App`.

## Evidence (file paths)

- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/tsconfig.json`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/package.json`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/.npmrc`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/.cursor/rules/creative-ui.mdc`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/errors.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/validate.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/index.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/store.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/env.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/auth.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/demo-seed.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/shared/types.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/web/src/api.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/web/src/ui/Button.tsx`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/web/src/styles.css`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/web/src/main.tsx`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/test/helpers.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/test/auth.test.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/test/api.test.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/test/store-pg.test.ts`
