# ShopBridge VoiceOps: implementation plan

Decision: **Option A, extend ShopBridge.** Reuse auth, orders, products, support cases and the Nexconn
order chat. Add a seller-facing voice agent that operates those same records.

## 0. Product definition (answers the 4 submission questions)
- **User / setting:** an Indian MSME seller (handmade goods, ShopBridge marketplace) packing orders at a
  counter or small godown, hands busy, phone speaker, noisy, speaking Hindi/Hinglish/English.
- **Friction:** to check delayed orders, update status, message customers, handle returns the seller
  opens 4-5 screens. Each routine task is ~2-4 minutes of tapping; most sellers skip it, so customers
  get no updates and escalate to support.
- **Execution path:** speech -> Gemini Live (function calling) -> VoiceOps orchestrator (validate, policy,
  idempotency) -> existing store (orders, support, products) + new VoiceOps tables -> Nexconn
  customer notice -> spoken confirmation + activity timeline entry.
- **Viability:** measured in-app: tasks completed by voice, taps avoided, seconds saved vs. a timed manual
  baseline, blocked/failed actions, Gemini token+audio cost per workflow (logged per session).

## 1. Architecture
```
Browser (React)                    Node server (existing single process)
 mic -> AudioWorklet 16k PCM  ws   /voiceops/live  (WebSocket relay, session-authenticated)
 player <- 24k PCM          <---->   |- holds GEMINI_API_KEY, opens Gemini Live session
 transcript / timeline / approvals   |- declares tools, executes tool calls
                                     |- Orchestrator: auth -> validate -> policy -> idempotency -> execute -> audit
                                     '- SSE/WS events to UI: tool_started/result, approval_required, latency
```
Rules: Gemini never writes data. Every tool is a typed server function that re-checks the logged-in
seller owns the order, checks status rules, requires a server-issued `approval_id` for any write, and is
idempotent. The model's "yes" is not an approval: approval comes from a UI tap or a server-verified
spoken confirm of the exact read-back text.

## 2. Data (new, Postgres only; leave the two 1300-line stores alone)
`voiceops_sessions`, `voiceops_actions` (tool, args, result, status, latency_ms, human_involved),
`voiceops_approvals` (action payload hash, state pending/approved/rejected/expired, decided_by),
`voiceops_returns`, `voiceops_notifications`, `voiceops_idempotency`, `voiceops_metrics` (token/audio cost).
Add as `004_voiceops.sql` using the existing migrate runner. Order/product reads and status changes go
through the existing `store` facade (`listOrders`, `getOrder`, `advanceOrder`, product update).

## 3. Tools exposed to Gemini
Read: `list_orders(filter)`, `get_order(id)`, `list_delayed_orders(hours)`, `list_low_stock(threshold)`.
Write (all two-phase: `prepare_*` returns a read-back + approval_id, `confirm_*` executes):
`update_order_status`, `create_return`, `cancel_order` (rejected if shipped/delivered: the exception),
`send_customer_message` (Nexconn system event / chat message), `adjust_stock`, `undo_action(action_id)`.
Escalation: `request_human_review(reason)` -> shows in Approvals queue.

## 4. Three demo workflows (from the brief)
1. Daily ops: delayed orders + low stock, spoken summary, suggested next actions.
2. Return resolution: fetch -> eligibility/policy -> create return -> order note -> draft notice -> approval -> execute.
3. Exception: "Order X cancel kar do" -> already shipped -> user interrupts "nahi, delay ka message bhejo" -> revised plan -> approval -> send.
Also scripted: a low-confidence/noisy utterance triggers "did you say 1042 or 1052?" instead of acting.

## 5. UI (add to existing Shell, seller role only)
Persistent mic button -> Voice workspace: waveform, live transcript (both sides), latency badge
(speech-end -> first audio byte), tool timeline, approval cards, undo buttons. Pages: Overview
(KPIs), Approvals, Activity, Analytics (automation rate, time saved, cost/workflow, blocked actions).

## 6. Phases (each ends runnable + tested)
P0 Foundation: fix repo layout, isolate env from production, local Postgres, migration 004, `ws` dep.
P1 Orchestrator + tools + policy + idempotency + audit, unit/API tests (no Gemini needed; fake model).
P2 Live relay: WS endpoint, Gemini Live session, audio in/out, transcripts, barge-in, tool-call loop.
P3 Voice UI + timeline + approval cards + undo.
P4 Three workflows end to end + exception/noise case; scripted Hinglish test audio.
P5 Metrics (latency, completion, cost) + analytics page + demo script/README + deploy.

## 7. Risks to retire early
- **Live model id / audio formats / tool-call protocol:** spike a 50-line Node script first (P2 day 1); do not assume the model name.
- **Region/latency:** measure from the demo network; keep first-audio time visible, report real numbers.
- **Hinglish accuracy in noise:** build a small recorded test set; confidence guard asks to repeat IDs.
- **Prod data:** current `.env` points at production Neon (see P0).
- **Nexconn dependency:** customer messages use existing server API; keep a mock sender for offline demo.

## Spike results (measured 2026-11-13, text prompt -> first audio chunk, from dev machine)
| Model | First audio (2 runs) |
|---|---|
| `gemini-3.8-live` | 887 ms, 860 ms |
| `gemini-3.1-flash-live-preview` | 900 ms, 948 ms |
| `gemini-2.5-flash-native-audio-latest` | 3519 ms, 3139 ms |
Output audio: PCM 24 kHz (`audio/pcm;rate=24000`). Decision: default `GEMINI_LIVE_MODEL=gemini-3.8-live`
(configurable; fall back to 3.1-flash-live-preview). Re-measure with real mic audio and tool calls in P2.
Also available: `gemini-3.5-transcribe-live`, `gemini-3.5-live-translate-preview` (candidates for the bonus extension).

## P2 results (Live relay, measured with real Gemini, dev machine)
- Protocol: `/api/voiceops/live` WebSocket (cookie auth, same-origin check). Binary up = 16 kHz PCM16 mic, binary down = 24 kHz PCM16 agent. JSON events: ready, transcript, interrupted, tool_started, tool_result, approval_required, approval_resolved, latency, turn_complete, error, closed.
- Voice approval trust: the relay replaces the model's `user_words` with its own transcript of the seller's last turn before checking for a clear yes.
- Text request, 3 tool calls, Hinglish spoken answer: first audio after tools 718 ms.
- Synthesized Hinglish speech streamed as mic audio: speech end -> tool call -> approval -> first spoken read-back 634 ms.
- Smoke tool: `BASE=http://127.0.0.1:8791 node scripts/voiceops-live-smoke.mjs "<sentence>" [--audio]` (seed + run with NEXCONN keys blank).

## P4 results (scenarios, real Gemini, synthesized speech; see SCENARIO_RESULTS.md)
5 of 5 scenarios pass: daily ops, return with refund on hold + spoken approval, cancel-after-dispatch exception with a real
mid-reply interruption, noisy warehouse (8 dB SNR), spoken self-correction. End-to-end latency from the last speech sample to the
first agent audio was measured at about 1.5 to 2.5 s in these runs (includes end-of-turn detection and tool calls): NOT yet sub-second.
Fixes made: Devanagari-aware spoken yes/no; confirm waits for fresh transcript; client-side barge-in in the browser.
Open for P5: tune Live VAD silence duration to cut latency, analytics, README/demo script, deploy.

## P5 results (latency, analytics, docs)
- Latency tuning: Live end-of-speech pause 250 ms vs 600 ms made no clear difference; breakdown of one request: ~0.9 s until Gemini
  decides on the tool call, ~30 ms in our tool code, ~0.6 s until it starts speaking. Instructing the agent to say a short acknowledgement
  before calling tools cut first-audio from ~1.5-2.5 s to ~0.9-1.3 s (single tool calls); multi-tool requests (s1) still reach ~2 s.
  Defaults: GEMINI_VAD_SILENCE_MS=300 + acknowledge-first prompt. Not consistently sub-second.
- Full-run totals over the last runs: 5/5, 5/5, 4/5, 3/5 (the saved SCENARIO_RESULTS.md is the 3/5 run: s3 the agent never called
  cancel_order, s5 the transcript heard "153" instead of 1053; no wrong action was executed in either). Not a stable 5/5 yet.
- Run-to-run variance: across the full scenario runs, most scenarios passed in most runs; s2 failed once (agent asked for a return reason
  instead of proceeding) and passed 3/3 on rerun; s3's mid-reply interruption depends on timing of the agent's explanation.
- Overview now shows measured latency p50/p95, audio minutes, workflows done/tried and cost per workflow (needs GEMINI_COST_* rates);
  "time saved" uses an ASSUMED manual baseline and is labelled as such.
- Added docs/voiceops/DEMO_SCRIPT.md and a VoiceOps section in README.md. Deployment not done.

## Gap-closing pass (before deploy)
Added: spend caps (concurrent, per-IP/day, audio-min/day), backup Gemini key + model fallback, preflight check, persistent voice dock on every seller screen
(mobile-safe), Nexconn rooms for demo orders 1042 and 1050 (belong to the demo buyer so messages are visible), Tamil/Tanglish scenario (s6),
daily digest (bonus) in en/hi/ta/hinglish, list-price cost estimate, docs/voiceops/SUBMISSION.md. Latest full scenario run: 6 of 6; 73 tests pass.
Found: auto-picked newest Flash text model hung on this key; pin GEMINI_MODEL=gemini-2.5-flash (also fixes support-reply drafting).
