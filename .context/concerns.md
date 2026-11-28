# Concerns

No CHANGELOG and no checked-in failing-test log. Postgres suites skip cleanly when Docker is down, so a green `npm test` can hide the VoiceOps and HTTP paths. `specs/tasks/todo.md` is stale Saathi phase-1 work (all unchecked, tests deferred). `docs/HACKATHON_WINNING_STRATEGY.md` still describes `joinPerm: 1`; current channels use `joinPerm: 3`.

## Fragile areas

- **Two stores, one facade.** `server/store.ts` switches JSON vs Postgres. `store-json.ts` and `store-pg.ts` must stay in lockstep. Production refuses JSON; local dev does not. VoiceOps, digest, team runs, and demo reset call `getPool()` directly and do not work on the JSON backend.
- **Migrations can be missing while the server stays up.** `prepareDatabase()` logs and continues. Missing `007_voiceops_baselines.sql` surfaces later as `503 NOT_MIGRATED`. Overview swallows a missing baselines table and returns empty rows.
- **In-memory state dies on restart and does not span instances.** Auth rate limits (`server/auth.ts`), live-sale rooms (`server/live.ts`), VoiceOps concurrent/IP caps (`server/voiceops/live.ts`), Gemini key cooldowns, and reply/triage caches. Documented limit: single server instance (`docs/voiceops/SUBMISSION.md`).
- **Spoken yes is a wide word list.** `isAffirmative` accepts `ok`, `ha`, `karo`, `done`, and the Hindi equivalents, capped at 120 characters and blocked if a negation is present. `confirm_action` overwrites the model’s `user_words` with the server transcript, but that transcript can race the tool call (wait up to 3s).
- **Chat delivery is best-effort.** Order events post only when a Nexconn channel exists. Demo orders other than 1042 and 1050 have no room, so messages are recorded and not delivered. Offer-card and system posts log a warning and continue.
- **Voice latency is not a stable sub-second path.** Scenario run 2026-11-13 passed 6/6 on synthetic speech, about 0.9–1.6s to first audio. Other Indic languages besides Hindi, Hinglish, English, and Tamil are untested. Cost math falls back to assumed manual seconds when no baselines exist.
- **HTTP surface is one file.** `server/index.ts` (~1000 lines) owns cookies, CSP, marketplace, support, live sales, and VoiceOps wiring. Roles are still named `member` / `volunteer` / `coordinator` (buyer / seller / support). Legacy cookie `saathi_session` is still accepted. Package name is `saathi`.

## Tech debt

- Dual persistence plus a hand-maintained export list in `store.ts`. Parity is only as good as `test/store-json.test.ts`.
- Leftover help-request API (`/api/requests`, `/api/volunteers`) from the earlier Saathi product, still routed.
- `eslint-disable react-hooks/exhaustive-deps` in `web/src/inbox/Chat.tsx` (six), plus `CaseBrief.tsx`, `ChatRoom.tsx`, `InboxPage.tsx`, `flair.tsx`. Stale closures are the likely failure mode.
- Tests use `as any` for users and order payloads. App code is stricter; one `as any[]` on a missing-table catch in the orchestrator.
- No `.github/workflows`. `npm test` is local only. ROI summary in `SUBMISSION.md` is still a paste placeholder.
- Open live rooms are in-memory on purpose (Nexconn idle-destroy). A process restart drops “Live from the loom” with no recovery.

## Security and risk

- **Rate limits trust the left-most `X-Forwarded-For`.** Comment in `server/auth.ts` says a client can forge it; the alternative (one shared bucket) would lock out demo judges. Same pattern in VoiceOps IP caps.
- **Debug tool HTTP.** `POST /api/voiceops/tools/:name` is on unless `NODE_ENV=production` and `VOICEOPS_DEBUG_TOOLS` is unset. It still runs through the orchestrator (ownership, policy, approval). `VOICEOPS_DEMO=1` keeps demo reset available in production for sample sellers.
- **CSP is wide on purpose.** `style-src 'unsafe-inline'`; `connect-src 'self' https: wss:` so the Nexconn SDK and CDN work. `frame-ancestors 'none'`.
- **Gemini key is a WebSocket query parameter** (`live.ts`). Keys rotate and fail over; they are not in git, but proxy logs can capture them.
- **Live sale channels are open** to any signed-in user (hearts, chat). Order group channels are server-joined (`joinPerm: 3`). Authorization for order chat is membership, not a secret id.
- **Refunds are never executed.** Returns set refund to deferred; `request_human_review` is the escape for risky or unclear asks. Prompt-injection in support notes is covered by `test/triage.test.ts` (model is instructed to ignore it).
- **Demo password** comes only from `SHOPBRIDGE_DEMO_PASSWORD`. Reseed is off in production unless `SHOPBRIDGE_ALLOW_RESEED=1` is set outside production (`reseedAllowed` returns false when `NODE_ENV=production`).

## Tests

| Suite | Needs | If Postgres is down |
|---|---|---|
| `voiceops-orchestrator`, `voiceops-live`, `store-pg`, `api`, `demo-reset` | `npm run test:pg:up` (local `*_test` DB only) | **skipped**, not failed |
| `store-json`, `auth`, `voiceops-policy`, `reasoning`, `gemini-keys`, `assist`, `triage` | none | run |

No `it.skip` / `describe.skip` beyond that Postgres gate. `test/helpers.ts` refuses non-local hosts and database names that do not end in `_test`. Deferred unit notes in `specs/tasks/todo.md` (status transitions, Nexconn signature shape) are obsolete relative to current tests; do not treat that file as the test plan.

## Evidence (file paths)

- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/store.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/index.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/auth.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/live.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/voiceops/live.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/voiceops/orchestrator.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/voiceops/policy.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/voiceops/routes.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/server/nexconn.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/test/helpers.ts`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/docs/voiceops/SUBMISSION.md`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/docs/voiceops/SCENARIO_RESULTS.md`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/specs/tasks/todo.md`
- `/home/ulap301/Desktop/Agentic Workflow Automation/ShopBridge-VoiceOps/docs/HACKATHON_WINNING_STRATEGY.md`
