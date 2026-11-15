---
name: voiceops-build
description: Use when working on ShopBridge VoiceOps (voice-driven agentic workflow: Gemini Live, tool orchestration, approvals, seller voice agent). Loads the challenge, architecture rules and safety invariants.
---

# ShopBridge VoiceOps

Read `docs/voiceops/CHALLENGE.md` (judging criteria) and `docs/voiceops/PLAN.md` (architecture, phases) first.

## Invariants (never violate)
1. Gemini never writes business data. All writes go through `server/voiceops/orchestrator` tools.
2. Every write tool: verify session user owns the order -> validate state/policy -> require a server-issued
   approval -> idempotency key -> execute -> audit row -> return a read-back string.
3. Never use the production `DATABASE_URL`. Dev/test use local Postgres (`npm run test:pg:up`) or JSON store.
   Do not run scripts in `scripts/` or `db:import` against Neon.
4. GEMINI_API_KEY stays server-side. The browser talks only to our `/voiceops/live` WebSocket.
5. Report only measured metrics (latency, cost, completion). Never invent numbers.
6. Low-confidence IDs/amounts -> ask the user to repeat; do not guess.

## Conventions
TypeScript, ESM, Node 20, `node --test` via `npm test`, `npm run typecheck` must pass before finishing a phase.
New SQL goes in `server/db/migrations/00N_*.sql`. Shared types in `shared/types.ts`.
