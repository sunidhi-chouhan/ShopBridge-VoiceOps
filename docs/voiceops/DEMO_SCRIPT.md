# VoiceOps demo script (about 5 minutes)

Setup (once): `npm run build`, then start the server and sign in as **Seller**. Open **Voice → Overview → Reset demo scenario**.
Use a headset in a quiet room first; play a short warehouse-noise clip from a phone for the noise segment.

## The pitch (30 s)
Meera sells handmade goods. Between packing parcels she has no free hands for five screens. She talks to ShopBridge in Hinglish;
the agent understands, checks the real orders, asks for her OK, does the work and says what it did.
Gemini never touches data directly: every change goes through a server that checks ownership, policy and duplicates.

## 1. Daily operations (45 s)
Say: **"Aaj ke pending orders aur low stock check karo."**
Point out: Voice agent answers aloud in Hinglish; right panel lists the three lookups with their milliseconds; latency badge shows the
measured time to first reply. Overview shows delayed orders 1051, 1052, 1053.

## 2. Return with refund on hold (60 s)
Say: **"Order 1042 ka return initiate karo, lekin refund abhi mat karna."**
Point out: the approval card with the read-back ("No refund will be issued now"). Say **"Haan, kar do."**
The relay checks its own transcript of what you said, not the model's claim. Activity log shows "Human in the loop".
Click **Undo** to show the correction path.

## 3. Exception, interruption, changed mind (75 s)
Say: **"Order 1050 cancel kar do."** The agent finds it is already shipped and starts explaining.
**Interrupt mid-sentence:** "Wait! Cancel nahi karna. Customer ko delay ka message bhejo."
Point out: audio cuts off at once, the blocked cancel is in the timeline (policy), a delay message is drafted, and it waits for approval.
Click **Approve**. Order 1050 stays shipped.

## 4. Noise and self-correction (45 s)
With noise playing, say: **"Order 1052 ko... nahi nahi, 1053 ko shipped mark karo, Delhivery, tracking DL999."**
Point out: it proposes 1053 only. If it is unsure of a number it asks you to repeat instead of guessing (1042 vs 1052).

## 5. The numbers (60 s)
Before the demo: on **Overview → Manual baseline**, time each task by hand a few times (Start timing, do it in the normal screens, Done).
Open **Overview → Performance and economics**: p50/p95 latency, audio minutes, workflows completed vs tried, blocked by policy,
needed a human, taps by hand vs by voice. Then **ROI at scale**: measured voice seconds, manual seconds and AI cost per workflow,
multiplied by the business inputs. Say plainly which values are measured and which inputs are yours (each task shows a
"measured" or "assumed" badge).

## If something goes wrong
- Mic blocked: type in the box under the transcript; everything else is identical.
- Agent unsure: that is the feature. Say the number again, or press Approve/Cancel.
- Reset: Overview → Reset demo scenario (end the voice session first).
