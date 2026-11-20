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
The ROI case is built from per-workflow unit numbers this app measures itself, multiplied by business inputs you set.
Everything is on **Voice > Overview**.

| Input | Where it comes from | Status |
|---|---|---|
| Voice seconds per workflow | All session audio (in + out) / completed workflows. Includes greetings and lookups, so it overstates voice time and understates the saving | **[MEASURED]** |
| AI cost per workflow | Audio minutes x Google's paid-tier list price for Gemini 3.8 Live ($0.005/min in, $0.018/min out, checked 13 Nov 2026). Excludes text tokens | **[MEASURED]** minutes, list price |
| Manual seconds, taps and keystrokes per task | **Manual baseline** stopwatch: the seller starts it, does the job by tapping through the normal screens, presses Done. The median over all timed runs is used per task | **[MEASURED]** once timed; until then **[ASSUMPTION]** (90-240 s), badged "assumed" in the UI |
| Taps by voice | Approvals confirmed by tapping instead of speaking, over the same tasks | **[MEASURED]** |
| Errors avoided | Actions blocked by policy (cancel after dispatch, closed return window, duplicates, unknown orders) | **[MEASURED]** |
| Sellers, workflows per day, working days, value of a seller's hour, ₹/USD, hosting per seller, subscription price | ROI calculator fields, saved per browser | **[ASSUMPTION]**, yours to set |

**Outputs (ROI calculator):** per seller per month: hours saved, value of time saved, AI cost, platform margin, seller net after
the subscription; at N sellers: hours saved, revenue, AI spend, gross margin. **Copy summary** puts the current figures on the
clipboard for this document.

**How the cost scales:** AI cost per workflow is audio minutes x list price (output audio costs 3.6x input), so it grows
linearly with talk time. The levers are short, acknowledge-first replies, push-to-talk on mobile and doing several actions per
session. Whether a seller comes out ahead depends on the real manual time, which is why it is measured rather than assumed.

**Before submitting:** time each of the five tasks at least 3 times (ideally 5 to 10 real sellers on their own phones), run
the demo workflows by voice, set the calculator inputs to your own pricing and volumes, press **Copy summary** and paste the
result here:

> _(paste ROI summary here)_

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
