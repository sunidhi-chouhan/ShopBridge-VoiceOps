# render-blueprint

## Goal
Add a Render Blueprint so ShopBridge VoiceOps deploys as one free web service plus a free Postgres database, with build, health check, and non-secret env already set. Secret keys are declared but not stored in git.

## Files likely touched
- render.yaml
- RENDER.md
- README.md
- specs/quick/render-blueprint.md

## Acceptance criteria
- [x] `render.yaml` is a valid Blueprint: Node web service, free plan, one instance, build `npm ci --include=dev && npm run build`, start `npm start`, health `/api/health`
- [x] `DATABASE_URL` is wired from the Blueprint Postgres instance, not pasted into git
- [x] Gemini, Nexconn, and the demo password are `sync: false`
- [x] `RENDER.md` matches this repo (root is the app; fresh database auto-migrates)

## Verification
- [x] Blueprint fields match https://render.com/docs/blueprint-spec
- [x] No secret values in the diff

## Noticed but not touched
- `HOSTED_DEMO_INIT.md` still describes a Neon import. The Blueprint uses Render Postgres and `npm run seed`.
- Commit is left for the user to request. Their git rule forbids committing without an explicit ask.
