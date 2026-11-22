# ShopBridge VoiceOps — demo video recording script

Shot list for screen recording. The **voiceover is added later**, but two things are recorded **live**: what you say to the
agent and the agent's spoken replies. Keep the system/tab audio and your microphone on while recording, then duck them under
the narration in the edit.

- **Main cut:** about 5 minutes (scenes 1–14). **Short cut (3 min):** use only the scenes marked ★.
- Times below are on-screen time in the final video. "Wait" means keep recording, hands off, so the result is visible.
- Gemini voice replies take about 1 s; keep them real-time. Gemini text features (triage, smart replies, listing, digest)
  can take 10–30 s when Google's models are busy: **record the wait, then cut or speed it up 4× in the edit** and add a small
  "sped up" label. Never fake a result.

---

## 0. Before you record (10 minutes, once)

**Setup**
1. Screen 1920×1080, browser zoom 100% (110% if text looks small), full-screen browser, bookmarks bar hidden, other tabs closed.
2. Two browser windows side by side for scenes 10–13:
   - **Window A** (normal): the Seller, later the Support agent.
   - **Window B** (incognito / another profile): the Buyer. Both open https://shopbridge-voiceops.onrender.com
3. Headset microphone. A phone next to you with a **fan / traffic / market noise** clip ready (scene 6).
4. Open the app a few minutes early so Render is awake (the first load after sleeping is slow).

**Reset the data (in this order)**
1. Window A → **Seller** → top-right account menu → **Reset demo data…** → confirm. Wait until the toast says restored.
2. **Voice AI → Overview → Reset demo scenario.** This creates the voice demo orders:
   | Order | State | Used in |
   |---|---|---|
   | 1042 | delivered, buyer Asha (kantha throw) | return with refund on hold (scene 7), smart replies (scene 11) |
   | 1050 | already shipped, buyer Asha (cane tote) | cancel blocked + interruption (scene 5), buyer view (scene 10) |
   | 1051, 1052, 1053 | delayed more than 24 h | batch delay notice (scene 4), noisy self-correction on 1053 (scene 6) |
   | 1054 | delivered, return window closed | exception + human review (scene 8) |
   | 1055 | fresh | special-price offer (scene 9) |
3. **Overview → Pre-demo check → Run check.** Every line must say OK, including "Gemini key rotation: N of N keys working".
4. Do one practice take of scene 3 to warm up the voice session, then **End session**, reset the scenario again, and start recording.

**If a take goes wrong:** the agent's wording varies between runs. Stop, click **End session**, Overview → **Reset demo scenario**,
and re-record just that scene. Scenes are independent except 5 → 10 (the buyer sees the message from scene 5).

---

## Scene 1 ★ — Landing: what this is (0:00–0:25)

| Time | Do | Record / show |
|---|---|---|
| 0:00 | Window A on the landing page, signed out. Don't move for 3 s. | Headline "Say it once. The AI does the work.", the rotating language word (हिन्दी · Hinglish · தமிழ் · English), the "✦ Powered by Gemini" badge, the animated conversation board. |
| 0:05 | Hover over the chips row ("Gemini Live voice AI", "Live translation", …). | Chips and the feature marquee at the bottom. |
| 0:10 | Click **See how the AI works ↓**. Scroll slowly through pages p. 01 → p. 07 (about 2 s per page). | The waveform drawing itself, "AI proposes. The server decides.", the read-back card, the audit log. |
| 0:22 | Stop on **What the AI does / What the AI never does**. Wait 3 s. | The guardrails, in plain words. |

## Scene 2 ★ — Seller opens the Voice AI (0:25–0:35)

| Time | Do | Record / show |
|---|---|---|
| 0:25 | Scroll to the top, click **Seller** under Explore demo. | Lands on **Voice AI → Voice agent**. |
| 0:28 | Hover the badge "AI agent · Gemini Live native audio · server-checked actions" and the six-step strip (Listens → Understands → Decides → Checks policy → Asks you → Done). | The AI identity and its loop. |

## Scene 3 ★ — Proactive briefing (0:35–0:50)

| Time | Do | Record / show |
|---|---|---|
| 0:35 | Click **Start talking**. Allow the microphone if asked. **Say nothing.** | Status "Listening". |
| 0:37 | Wait 5–8 s. | The agent opens by itself, in Hinglish: delayed orders, low stock, and a suggested next step. The right panel shows **Business summary** with its milliseconds; the latency badge shows "ms to reply". |

## Scene 4 ★ — One approval, many customers (0:50–1:10)

| Time | Do | Record / show |
|---|---|---|
| 0:50 | Say: **"Haan, sab delayed customers ko sorry ka message bhej do, order ek din late hoga."** | Transcript of your words; the strip moves to *Decides*. |
| 0:55 | Wait 3 s. | **Notify delayed customers** card: one read-back for 3 customers (1051 Imran, 1052 Ravi, 1053 Lakshmi). The strip shows *Asks you*. |
| 1:00 | Say: **"Haan, bhej do."** | The relay accepts your spoken yes; the card turns green: "Delay update sent to 3 customers". |
| 1:05 | Hold 4 s on the timeline. | Three personalised messages, one approval. |

## Scene 5 ★ — Exception + mid-sentence interruption (1:10–1:40)

| Time | Do | Record / show |
|---|---|---|
| 1:10 | Say: **"Order 1050 cancel kar do."** | Get order → Cancel order. |
| 1:14 | As soon as the agent **starts explaining** that it is already shipped, **interrupt** loudly: **"Ruko! Cancel nahi karna. Customer ko delay ka message bhejo."** | The agent's audio cuts off at once; its line is marked "— interrupted". The timeline shows **Cancel order · blocked** (already dispatched). |
| 1:22 | Wait 3 s. | A new **Message customer** approval card with the drafted delay message. |
| 1:26 | **Click Approve** (show the tap path this time). | Card turns green. Order 1050 stays shipped. |
| 1:32 | Hold 5 s on the timeline: blocked cancel (red), then the approved message. | Exception handled, human approved, nothing unsafe executed. |

## Scene 6 ★ — Noise + self-correction (1:40–2:00)

| Time | Do | Record / show |
|---|---|---|
| 1:40 | Start the noise clip on your phone, close to the mic. | (Background noise audible in the recording.) |
| 1:42 | Say: **"Order 1052 ko… nahi nahi, 1053 ko shipped mark karo, Delhivery, tracking DL999."** | Transcript shows the correction. |
| 1:48 | Wait 3 s. | The read-back proposes **1053** only, with Delhivery DL999. |
| 1:52 | Say: **"Haan."** Stop the noise. | Approved; latency badge still around a second. |

> If the agent is unsure of a number in the noise, it asks you to repeat it. Keep that take: it shows the confidence guard.

## Scene 7 — Return with refund on hold, then undo (2:00–2:25)

| Time | Do | Record / show |
|---|---|---|
| 2:00 | Say: **"Order 1042 ka return start karo, lekin refund abhi mat karna."** | Read-back ends with "No refund will be issued now." |
| 2:07 | Say: **"Haan, kar do."** | Return created. |
| 2:12 | Click **Undo** on that timeline card. | The return is cancelled: the correction path. |
| 2:18 | Hold 4 s. | Undo recorded in the timeline. |

## Scene 8 — Out of policy → a human (2:25–2:40)

| Time | Do | Record / show |
|---|---|---|
| 2:25 | Say: **"Order 1054 ka return karo."** | Create return · **blocked** (7-day return window closed). |
| 2:30 | If it offers, say: **"Haan, kisi insaan se check karwa do."** | **Ask a human** card. Approve it. This is the human-in-the-loop escalation. |

## Scene 9 — Special-price offer by voice (2:40–2:55)

| Time | Do | Record / show |
|---|---|---|
| 2:40 | Say: **"Order 1055 pe customer ko das percent discount ka offer bhejo."** | Read-back with the new price and the old one (for example ₹1,665, was ₹1,850). |
| 2:47 | Say: **"Haan."** | Offer sent. (Optional: say "aadha price kar do" on another order to show that deep discounts are blocked.) |
| 2:52 | Click **End session**. | |

## Scene 10 ★ — The buyer sees it, in their language (2:55–3:10)

| Time | Do | Record / show |
|---|---|---|
| 2:55 | **Window B:** click **Buyer** (Asha). Open **Inbox → the *Cane and hide tote* conversation (order 1050).** | The delay message from scene 5, translated into Hindi for Asha; the original one tap away. |
| 3:05 | Hold 4 s. | Voice in Hinglish became a real message in a real order chat. |

## Scene 11 — Gemini smart replies (3:10–3:35)

| Time | Do | Record / show |
|---|---|---|
| 3:10 | **Window B (Asha):** open the *Block-print kantha throw* conversation (order **1042**) and type in Hindi: **"नमस्ते, रिटर्न का पिकअप कब होगा?"** → send. | Buyer message. |
| 3:16 | **Window A:** Seller → **Inbox** → the kantha throw conversation with Asha (order 1042). Wait until the chips above the composer say **✦ Gemini**. | Three replies Gemini wrote from this conversation. (Cut the wait if it is long.) |
| 3:28 | Tap one chip, edit a word, send. | Window B shows the reply arriving, translated for Asha. |

## Scene 12 ★ — Support: Gemini triage → proposal (3:35–4:10)

| Time | Do | Record / show |
|---|---|---|
| 3:35 | Window A → account menu → sign out → **Support agent**. | **Queue**. |
| 3:38 | Wait until each open case shows a **✦ summary** line (cut the wait). | The queue sorted by urgency; Asha's sari case marked **high urgency**. |
| 3:45 | Select the case. Show the **Gemini triage** card: urgency, issue, buyer mood, suggested resolution, reasons. | Decision support, not automation. |
| 3:52 | Click **Claim and join conversation**. Open the **Order details** (ⓘ) panel. | Case brief with the triage refreshed from the conversation. |
| 3:58 | Click **Use this proposal**. | The proposal form fills itself (Replacement + note). Edit one word to show it is yours. |
| 4:03 | Click **Propose**. Optional: **Draft a reply with Gemini** → **Put in message box** → send. | |
| 4:07 | Optional, Window B: Asha clicks **Accept** on the proposal. | Buyer confirms; the case resolves. |

## Scene 13 — Listing drafted from a photo (4:10–4:30)

| Time | Do | Record / show |
|---|---|---|
| 4:10 | Window A → sign in as **Seller** → **Products → New piece**. | Photo-first form. |
| 4:13 | Pick the **kantha throw** cover photo. In *Rough note* type: **"hand stitched from old cotton saris, two layers"**. | |
| 4:17 | Click **Draft with Gemini**. Wait (cut in the edit). | Name, description and category filled, suggested price with a reason, "Drafted by Google Gemini". |
| 4:26 | Hold 3 s, then **Cancel** (don't add a product to the shared demo). | |

## Scene 14 ★ — Proof: numbers, ROI, resilience (4:30–5:10)

| Time | Do | Record / show |
|---|---|---|
| 4:30 | **Voice AI → Overview.** Scroll slowly. | *What the agent has done (measured)*: actions completed, **blocked by policy**, **needed a human**. |
| 4:38 | Stop on **Performance and economics**. Hold 5 s. | Reply latency p50/p95, audio minutes, workflows done/tried, cost per workflow, time saved, taps by hand vs by voice. |
| 4:45 | Scroll to **Manual baseline** and **ROI at scale**. Hold 6 s. | Measured vs assumed badges, per-seller and at-scale economics. |
| 4:53 | **Daily digest by Gemini:** choose **हिन्दी** + **Owner (WhatsApp)** → **Write digest** (cut the wait). | The day summarised in Hindi from database facts. |
| 5:02 | **Pre-demo check → Run check.** Hold 4 s. | "Gemini key rotation: N of N keys working": the demo survives a bad key. |
| 5:07 | Click **How the AI works** tab, hold on the pipeline line at the bottom. End. | Voice → Gemini Live → Guarded tools → Shop data → Spoken reply. |

---

## Optional B-roll (use as cutaways under narration)

- **Live sale room (30 s):** Seller → **Live** → pick the sari → **Go live**. Window B (Buyer) → **Live** → open the room → send
  "क्या ये असली ज़री है?" → **Buy now**. Window A shows "Asha just bought…" and "1 sold". End the room from the host side.
- **Tamil (10 s):** in a voice session say *"Order 1053 customer Lakshmi-ku Tamil-la message anuppu, order oru naal late aagum."*
  The read-back shows a message in Tamil script.
- **Approvals tab and Activity tab:** the audit trail with "Human in the loop" markers.

## What each scene proves (for the judges' checklist)

| Challenge requirement | Scene |
|---|---|
| Native real-time voice, natural turn-taking, visible latency | 3, 4, 14 |
| Mid-sentence interruption and spoken correction | 5, 6 |
| Hinglish / Hindi / Tamil, code-switched speech | 3–9, 10, B-roll |
| Background noise, low-confidence guard | 6 |
| Multi-step workflow with real backend actions | 4, 5, 7, 9 |
| Exception handling (blocked, out of policy) | 5, 8 |
| Human in the loop (approval, escalation, undo) | 4, 5, 7, 8, 12 |
| Workflow visibility (timeline, audit, where humans stepped in) | 5, 14 |
| Measurable value: latency, completion, cost, ROI | 14 |
| Bonus: content for other audiences and languages | 10, 11, 14 (digest) |

## Editing notes

- Put the scene title as a small lower-third ("Exception + interruption", "One approval, many customers").
- When the agent speaks, show its transcript line large or zoom the transcript panel (zoom 150% in the editor).
- Label sped-up waits: "Gemini text call · sped up 4×". Leave voice replies real-time: that is the latency claim.
- Do not edit numbers on the Overview screen; they are measured. Mention that the manual time is assumed where it is badged "assumed".
