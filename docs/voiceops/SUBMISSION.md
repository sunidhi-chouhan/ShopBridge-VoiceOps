# ShopBridge VoiceOps: submission answers

**Tagline:** Your Business. Your Language. One Voice.
Items marked **[MEASURED]** come from this repo's own runs (see `SCENARIO_RESULTS.md` and the Overview tab). Items marked
**[ASSUMPTION]** are inputs you should replace with your own field data. Nothing here is a made-up performance claim.

## 1. Target user and setting
An independent seller on an Indian marketplace (handmade goods, D2C, home business) packing orders at a counter, a spare room or a small
godown. Hands are busy, phone or laptop sits on a shelf, the room is noisy (machines, street, family), and the seller speaks Hindi,
Hinglish, Tamil/Tanglish or English, often switching mid-sentence.

## 2. Operational friction
Routine order operations need several screens and many taps: find the order, check status, update it, open the customer chat, write a
message, start a return, adjust stock. Sellers skip updates, so delayed orders go unannounced, customers escalate to support, and returns
sit unprocessed. VoiceOps replaces "find, tap, type" with one spoken sentence and a spoken yes.

## 3. Action execution path
speech -> Gemini Live (native audio, function calling) -> server relay (`server/voiceops/live.ts`) -> orchestrator
(`orchestrator.ts`: ownership, policy, approval bound to exact arguments, idempotency, audit) -> PostgreSQL orders/products/returns and the
Nexconn order chat -> spoken confirmation, transcript, action timeline and Activity log.

- **Read** tools run at once. **Writes** are two-phase: the agent receives a read-back, says it aloud, and nothing changes until the
  seller approves by voice or by tapping. Spoken approval is checked against the server's own transcript of what the seller said (not the
  model's claim) and understands Latin and Devanagari spellings of yes/no.
- **Exceptions:** order already shipped (cancel blocked), return window closed, duplicate return, unknown or ambiguous order number or
  product, negative stock, out-of-policy quantity, expired or duplicate approvals, low-confidence audio (agent asks to repeat).
- **Human in the loop:** every write needs approval; `request_human_review` escalates unclear or risky requests; refunds are never
  automated. **Undo** is available for status, cancel, return and stock changes.
- **Visibility:** live tool timeline with milliseconds, approval cards, Activity log marking human involvement, Overview metrics.

## 4. Commercial viability
**Unit cost [MEASURED inputs, list-price assumption]:** each session records audio minutes in and out. Overview shows cost per
completed workflow using Google's published paid-tier list price for Gemini 3.8 Live audio ($0.005/min input, $0.018/min output, checked
13 Nov 2026 at aistudio.google.com/docs/pricing). This excludes text tokens and hosting. Copy the "Cost per workflow" figure from
Overview after a demo run.

**Time saved [ASSUMPTION, labelled in the UI]:** manual baseline per task (status 90 s, stock 90 s, cancel 120 s, message 150 s, return
240 s). Replace with timings from 5 to 10 real sellers; Overview subtracts measured voice seconds.

**ROI at scale (formula):** monthly saving per seller = workflows per month x (manual seconds - voice seconds) / 3600 x seller's
hourly value; compare with workflows per month x cost per workflow + hosting. Voice cost scales linearly with audio minutes, so
the levers are shorter sessions, push-to-talk on mobile and caching of lookups. Add your own volumes here.

**Language coverage [MEASURED]:** Hindi, Hinglish, English and Tamil/Tanglish scenarios pass with real Gemini speech (Tamil drafted
customer message in Tamil script). Other Indic languages are untested and should be listed as "to validate" until tested.

## Measured results (synthetic speech, this machine)
See `SCENARIO_RESULTS.md`. Pass counts vary between runs (observed 3/5 to 5/5 before the Tamil case was added); first reply after
end of speech is roughly 0.9 to 2 s, not consistently sub-second. Speech was synthesized by Gemini, not recorded from people.

## Known limits (state them)
- Latency not consistently sub-second; multi-tool requests are slower.
- Test audio is synthetic; real-microphone and real-noise testing is manual.
- Demo orders other than 1042 and 1050 have no chat room, so messages for them are recorded but not delivered.
- Cost excludes text tokens and hosting. Time saved uses an assumed baseline.
- Single server instance (in-memory session caps).

## Bonus extension
Overview > Daily digest turns the day's agent activity into a summary for the owner, the packing team or waiting customers in English,
Hindi, Tamil or Hinglish, using only database facts.
