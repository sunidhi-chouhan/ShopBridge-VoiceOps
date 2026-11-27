# Project Context Overview

## What This Is

- ShopBridge is a conversation-first Indian marketplace: each order has one shared Nexconn channel for buyer, seller, and support, with live translation.
- VoiceOps lets a seller speak Hindi, Hinglish, Tamil, or English. Gemini Live proposes tools; the server checks policy and a human yes before any shop write.
- Users are sellers (primary), buyers, and support. Demo accounts are `buyer@` / `seller@` / `support@shopbridge.demo`.
- One Node process serves a React SPA and `/api`. Local data is `data/store.json`; production is PostgreSQL 18 on Render.
- The model never writes business data and never sees API secrets. `specs/spec.md` is an older Saathi app, not the current product.

## Quick Reference

| Dimension | File | Purpose |
|-----------|------|---------|
| Project | [project.md](./project.md) | Business context: purpose, users, goals |
| Stack | [stack.md](./stack.md) | Tech + **canonical `## Commands`** (install/build/test/lint/typecheck) |
| Architecture | [architecture.md](./architecture.md) | Code organization: layers, boundaries, data flow |
| Conventions | [conventions.md](./conventions.md) | Code style: naming, patterns, testing approach |
| Concerns | [concerns.md](./concerns.md) | Pain points: debt, fragile areas, known issues |

## Start Here (for agents)

When you land in this project:

1. Read this overview first (you're reading it now)
2. Based on your task, jump to the relevant dimension file above
3. If writing a spec: read project.md → stack.md → architecture.md → concerns.md
4. If implementing: read **stack.md** (Commands) → conventions.md → concerns.md → architecture.md
5. If debugging: read architecture.md → stack.md → concerns.md

## Latest Update

2026-11-23. Checked against actual code: React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.5 in `package-lock.json`; `npm test` runs `test/*.test.ts`; `server/store.ts` is the Postgres-or-JSON facade and `runTool` lives in `server/voiceops/orchestrator.ts`.
