# ShopBridge VoiceOps: validation results

Measured 27–28 November 2026 on the deployed stack in Mumbai: Cloud Run (asia-south1), Cloud SQL Postgres 18, and Gemini Live `gemini-3.8-live` on Vertex AI (asia-south1). The lab ran against a private copy of the service with its own database. The public demo was never touched.

**Speech:** the seller's own phone recordings. 26 voice commands in Hinglish, Tamil/Tanglish and English, plus one earlier "haan, bhej do" recording.

**Noise:** the seller's own recordings of a godown, a market and a home shop with a TV on. Background speech is the hardest kind of noise for voice agents. Each clip was mixed with this noise at 10, 5 and 0 dB SNR: 0 dB means the TV is as loud as the seller.

**Fresh start:** every case began from a fresh demo reset.

## Headline

| | Automatic turn detection | Hold-to-talk ("Noisy shop" mode) |
|---|---|---|
| Clean speech | **27/28 (96%)** | not needed |
| 10 dB SNR (TV / market in background) | 18/28 (64%) | **26/28 (93%)** |
| 5 dB SNR | 19/28 (68%) | **26/28 (93%)** |
| 0 dB SNR (background as loud as the seller) | 14/28 (50%) | 19/28 (68%) |
| Reply latency p50 / p95 | 980 ms / 1,648 ms (clean) | **598 ms / 1,287 ms** from button release |
| Agent talked over the seller | 8 of 112 turns | **0 of 84** |
| **Wrong changes executed** | **0 of 112** | **0 of 84** |
| Wrong proposals (stopped at approval) | 2 | 0 |

The safety result: across 196 real-voice cases, **no change was ever executed that the seller did not ask for**. Every failure was either:
- the agent asking to repeat or looking something up, or
- a wrong proposal (two cases) that stopped at the approval step.

Critical actions held up:
- Refunds: a spoken "haan" never executed one; the agent asked for a tap.
- Hesitant answers: "haan… nahi, ruko" never approved anything.

## What the real recordings changed

The first real-voice run exposed problems that generated speech had hidden:

| Finding (first real run) | Fix | After |
|---|---|---|
| Natural pauses ("1042… matlab 1052") ended the turn after 300 ms, so the agent acted on the first number | End-of-speech pause 300 → 600 ms | Corrections in clean speech: all pass (were 55% across conditions) |
| TV and market voices started turns and cut the agent off mid-reply | **Hold-to-talk** mode: the seller holds a button while speaking; background audio is never sent | 93% at 10 and 5 dB, 0 talk-overs |
| "saree" / "Jhumke" not found (the catalogue says "sari", "jhumkas") | Sound-alike product matching + catalogue names given to the agent | Fixed in all conditions |
| Tamil "ஆமாம்" (yes) not accepted | Tamil and Tanglish yes/no words | Fixed |
| "1053" heard as "1353" | Suggest the one-digit near miss ("did you mean 1053?"), never act on it unasked | Agent asks instead of failing |
| Spoken "yes" took 1.1–1.4 s | Agent acknowledges first, then confirms | 0.6–0.8 s typical |

Before-and-after detail: [REPORT-real-before-fixes.md](lab/REPORT-real-before-fixes.md). That run used an older latency measure (end of the audio file, not the last voiced sound), so its latency column is not comparable.

## Latency: what "sub-second" means here

- **Hold-to-talk: p50 598 ms, p95 1,287 ms** from the moment the seller lets go of the button to the first sound of the agent's reply. In this mode the seller says when they're done, so no end-of-speech wait is needed.
- **Automatic mode, clean speech: p50 980 ms, p95 1,648 ms.** Measured from the seller's last voiced sound. It includes the deliberate 600 ms end-of-speech pause, which keeps corrections working; 60% of all automatic-mode turns answered within one second.
- **Measurement point:** the client's microphone stream to the first agent audio received back over the internet, from Indore to Mumbai. It includes end-of-speech detection, Gemini, tool calls with database reads, and the network both ways.
- **Session start:** 160–500 ms to open a voice session on Vertex AI in Mumbai.

## Mid-sentence corrections

| Clip | Says | Result |
|---|---|---|
| C01 | "1051 ko pack kar do… nahi nahi, 1052 ko" | Clean ✓; only 1052 is ever proposed |
| C02 | "Sari ka stock das kar do… sorry, aath" | Clean ✓; the proposal says 8, never 10 |
| C03 | "…parso tak… nahi, kal tak" | Clean ✓; the message says tomorrow |
| C04 | "1042… matlab 1052 ka status" | Clean ✓; looks up 1052 |
| T03 | Tamil: "1051… illa illa, 1052" | Clean ✓ |

With noise, corrections pass 87% in hold-to-talk and 60% in automatic mode. Every correction failure was safe: the agent asked again.

## Unit economics (measured audio)

| | |
|---|---|
| Audio per voice request (measured) | 7.7 s in, 7.3–9.6 s out |
| Gemini Live cost per request | **$0.0028–0.0035 (₹0.24–0.30)** at $0.005/min in, $0.018/min out |
| A seller doing 30 voice requests a day | **≈ ₹214–255 a month** in Gemini audio |
| Hosting (Cloud Run + Cloud SQL Mumbai, one always-on instance) | ≈ $20–30 a month in total, shared by all sellers. This is a list-price **estimate**; the real figure comes from the Google Cloud bill. |

**At 100 sellers:** about ₹230 per seller per month in total, for 30 voice requests a day. A seller earning ₹5,000 profit on 20 orders saves more than that by not losing one late order to a cancellation.

Text calls (forecasts, insights, triage) are billed per token and are a small fraction of audio. They are not included above.

## What is simulated, and known limits

- **Simulated:** supplier purchase orders, courier re-booking and refunds go through connectors that behave like real partners (references, ETAs, tracking numbers) but move no money or parcels. Real connectors plug in behind the same interface.
- **One speaker:** the recordings are from one speaker, plus one earlier clip. Other voices, dialects and Indic languages beyond Hindi, Tamil and English are untested.
- **Short noise beds (1.3–5.2 s):** they were looped. Longer recordings would make the noise results stronger.
- **0 dB background speech** (a TV as loud as the seller) remains hard: 68% even with hold-to-talk. The agent then asks again rather than guessing.
- **Single instance:** the service runs one instance in-region. The figures were measured with one session at a time.

## How to reproduce

```bash
# 1. a server you are allowed to reset (local, or the private lab service)
BASE=http://127.0.0.1:8795 node scripts/lab/run-lab.mjs --clips real-voice-clips --conditions clean,snr10,snr5,snr0
# 2. hold-to-talk
BASE=http://127.0.0.1:8795 node scripts/lab/run-lab.mjs --ptt --clips real-voice-clips --conditions snr10,snr5,snr0
# 3. report
node scripts/lab/report.mjs docs/voiceops/lab/<run>.json --out report.md
```

The cases and their pass rules are in `scripts/lab/cases.mjs`. The raw results, with every transcript, tool call and timing, are the `run-*.json` files in `docs/voiceops/lab/`.

Detailed reports:
- [Real voice, automatic](lab/REPORT-real-automatic.md)
- [Real voice, hold-to-talk](lab/REPORT-real-hold-to-talk.md)
- [Real voice, before the fixes](lab/REPORT-real-before-fixes.md)
- [Synthetic baseline](lab/REPORT-synthetic-baseline.md)
