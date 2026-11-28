# Project

**ShopBridge VoiceOps** — a conversation-first Indian marketplace plus a voice-driven seller agent. Taglines: “Every order has a conversation — in every language.” (`README.md`) and “Say it once. The AI does the work.” (`web/src/ui/Reveal.tsx`). Built for the Nexconn Build Challenge (marketplace & support) and a Gemini Live voice-workflow challenge (`docs/HACKATHON_WINNING_STRATEGY.md`, `docs/voiceops/CHALLENGE.md`).

`specs/spec.md` describes an earlier **Saathi** volunteer-help app (member / volunteer / coordinator). That is not the current product. Roles still use those internal names (`DEMO.md`).

## Purpose

One Node process serves a Vite React app and `/api` (`README.md`).

1. **Marketplace chat.** Each order gets one Nexconn group channel. Buyer, seller, and support share it. Live translation, media, voice notes, receipts, order cards, live-sale open channels, and voice/video calls are in scope (`README.md`).
2. **VoiceOps.** A seller speaks Hindi, Hinglish, Tamil/Tanglish, or English. Gemini Live calls tools. A server orchestrator validates ownership, policy, idempotency, and a human approval, then writes orders, stock, returns, and Nexconn notices and confirms by voice (`README.md`, `docs/voiceops/PLAN.md`).
3. **Agent team.** A Supervisor plans; Operations, Customer-comms, Inventory, and Support-triage propose. A rules engine records facts, rules, verdict, and why. Gemini proposes; rules decide (`README.md`, `docs/voiceops/SUBMISSION.md`).
4. **Adjacent Gemini assists** (suggest or wait for approval): support triage, smart replies, listing draft from a photo, daily digest in en/hi/ta/Hinglish (`docs/voiceops/SUBMISSION.md`).

Local store is `data/store.json` when `DATABASE_URL` is unset; hosted uses Postgres (`README.md`).

## Users

| Who | Setting | Evidence |
| --- | --- | --- |
| **Seller** (primary VoiceOps user) | Indian MSME / handmade / D2C, packing at a counter, spare room, or small godown; hands busy; noisy; phone or laptop on a shelf | `docs/voiceops/PLAN.md`, `docs/voiceops/SUBMISSION.md` |
| **Buyer** | Shops and talks about an order in their language (demo: Hindi reader vs English writer) | `README.md`, `DEMO.md` |
| **Support agent** | Joins the same order channel with pre-join history; Gemini triage is a suggestion | `README.md`, `docs/voiceops/SUBMISSION.md` |
| **Owner, packing team, waiting customers** | Read-only daily digest | `docs/voiceops/SUBMISSION.md` |
| **Demo / judges** | Explore Demo: Buyer, Seller, Support (`buyer@` / `seller@` / `support@shopbridge.demo`) | `DEMO.md` |

Demo seller persona: Meera Joshi (`DEMO.md`, `docs/voiceops/DEMO_SCRIPT.md`).

## Problems solved

- **Language split on one order.** Buyer and seller read the same thread in their own language; original stays next to the translation. Support sees history from before they joined (`README.md`).
- **Seller ops are too many taps.** Checking delays, updating status, messaging customers, returns, and stock means 4–5 screens and ~2–4 minutes each. Sellers skip updates; customers get silence and escalate (`docs/voiceops/PLAN.md`, `docs/voiceops/SUBMISSION.md`).
- **Speech must become a real action, not a chat.** Path: speech → Gemini Live → relay → orchestrator → Postgres and Nexconn → spoken confirmation and an activity timeline (`docs/voiceops/CHALLENGE.md`, `docs/voiceops/PLAN.md`).
- **Unsafe or unclear speech.** Cancel after dispatch is blocked; return window and stock rules apply; ambiguous IDs are repeated back; interruption and spoken correction are first-class (`docs/voiceops/PLAN.md`, `docs/voiceops/DEMO_SCRIPT.md`).
- **No visibility.** Tool timeline, approval cards, “Why” traces, and Overview metrics (latency, blocked actions, cost per workflow). Time saved uses a measured manual baseline when timed, otherwise a labelled assumption (`docs/voiceops/SUBMISSION.md`).

## Non-goals

Explicit limits. Do not treat `specs/spec.md` “Phase 2 (not now)” as current — translation, calls, and AI already shipped.

**The model does not (`web/src/ai/AiStory.tsx`, `README.md`, `.claude/skills/voiceops-build/SKILL.md`):**

- Write business data. All writes go through `server/voiceops/orchestrator`.
- Act on the model’s claimed “yes”. Approval is a UI tap or a server-checked transcript of the seller’s words, bound to the exact arguments.
- Guess a low-confidence order id or amount; it asks again.
- Issue refunds or deep discounts (over 50% off). A person handles money. Returns outside 7 days are blocked (`docs/voiceops/SUBMISSION.md`).
- See `GEMINI_API_KEY` or the Nexconn App Secret. Both stay on the server. The browser talks to `/voiceops/live`.

**Also out of scope or refused:**

- A chatbot with no backend action (`docs/voiceops/CHALLENGE.md`).
- Auto-sending smart replies or support drafts; a person edits and sends (`docs/HACKATHON_WINNING_STRATEGY.md`, `docs/voiceops/SUBMISSION.md`).
- Real payments — checkout is labelled simulated (`docs/HACKATHON_WINNING_STRATEGY.md`).
- Invented ROI numbers. Report measured latency, cost, and completion only (`docs/voiceops/CHALLENGE.md`, skill invariants).
- `npm run seed`, reseed, or test suites against hosted/production Postgres or Neon. `POST /api/dev/reseed` is refused when `NODE_ENV=production` (`README.md`, `DEMO.md`).
- Commit `.env`, `data/`, or `backups/` (`README.md`).

**Stated limits (not promises):** latency is not consistently sub-second; scenario audio is synthetic; only some demo orders have Nexconn rooms; cost figures omit text tokens and hosting; caps are in-memory on one server (`docs/voiceops/SUBMISSION.md`, `docs/voiceops/PLAN.md`).

## Evidence (file paths)

- `README.md` — product, Nexconn features, VoiceOps safety, local vs Postgres
- `DEMO.md` — demo roles and seed rules
- `docs/voiceops/CHALLENGE.md` — judged capabilities; “not a chatbot”
- `docs/voiceops/PLAN.md` — user, friction, execution path, tools, phases
- `docs/voiceops/SUBMISSION.md` — users, Gemini map, refunds, ROI, known limits
- `docs/voiceops/DEMO_SCRIPT.md`, `docs/voiceops/VIDEO_SCRIPT.md` — demo journeys
- `docs/HACKATHON_WINNING_STRATEGY.md` — marketplace thesis; simulated payment; Saathi leftover warning
- `web/src/ai/AiStory.tsx` — “What the AI does / never does”
- `web/src/ui/Reveal.tsx` — landing headline
- `.claude/skills/voiceops-build/SKILL.md` — write and secret invariants
- `specs/spec.md` — historical Saathi phase 1 only
