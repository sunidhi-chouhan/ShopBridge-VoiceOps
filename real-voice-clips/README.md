# Real voice clips: recording script

These clips are the evidence for the claims "works in a noisy shop" and "handles mid-sentence corrections". Synthesised speech cannot prove either. The audio files stay out of git (personal voice); only this README is tracked.

## How to record

- **Phone voice recorder, any format** (m4a, mp3, wav, ogg). The test harness converts everything to 16 kHz mono.
- **One sentence per file**, named exactly as in the tables below (for example `H02_bulk-delay.m4a`).
- Leave **about 1 second of silence** before and after you speak.
- Say it the way you would **while packing**: natural speed, not reading aloud. Small "umm"s and pauses are fine, even useful.
- Hold the phone about an arm's length away, as if it were lying on the packing table.
- The sentences match the demo shop (Meera's orders 1042–1055, sari, jhumkas, tote). Reword freely as long as the **order number and intent** stay the same.
- If a different person records a clip, note their first name in `speakers.txt` (one line per file). They should know the clip is used for testing.

## Part A: normal room (all clips)

Record these in an ordinary room, with a fan or light background noise. Later I mix your noise recordings (Part C) into these at three volume levels, which gives a controlled noise test.

### Hinglish: everyday workflows

| File | Say this | What should happen |
|---|---|---|
| `H01_summary` | "Aaj ka haal batao: kitne orders late hain, aur kaunsa stock kam hai?" | Summary: delayed orders, low stock |
| `H02_bulk-delay` | "Jitne bhi orders late hain, sabko message bhej do ki kal tak dispatch ho jayega." | One approval for 1051, 1052, 1053 |
| `H03_return` | "1042 wala return start kar do." | Return proposal, waits for yes |
| `H04_cancel-blocked` | "1050 cancel kar do." | Blocked: already shipped. Offers a message instead |
| `H05_stock-add` | "Jhumke ke paanch piece aur aa gaye, stock mein add kar do." | Stock +5 for brass jhumkas |
| `H06_ship` | "1053 ship ho gaya, Delhivery se, AWB DL5530." | Status → shipped, with courier and AWB |

### Mid-sentence corrections (most important)

| File | Say this | What should happen |
|---|---|---|
| `C01_order-fix` | "1051 ko pack kar do… nahi nahi, 1052 ko." | Packs **1052** only |
| `C02_number-fix` | "Sari ka stock das kar do… sorry, aath." | Sets the sari stock to **8** |
| `C03_message-fix` | "Sabko message bhejo ki parso tak… nahi, kal tak aa jayega." | Message says **kal** (tomorrow) |
| `C04_soundalike` | "1042… matlab 1052 ka status kya hai?" | Reads out **1052** (placed, delayed) |

### Spoken approvals (play these after the agent reads back)

| File | Say this | What should happen |
|---|---|---|
| `Y01_yes` | "Haan, bhej do." | Approves |
| `Y02_yes-casual` | "Theek hai, kar do." | Approves |
| `N01_no` | "Nahi, abhi mat bhejo." | Rejects |
| `N02_changed-mind` | "Haan… nahi, ruko ek minute." | **Must not** approve |
| `I01_interrupt` | "Ruko ruko, pehle 1053 ke baare mein batao." | Agent stops talking and switches to 1053 |

### Refunds and critical actions (must stay human-approved)

| File | Say this | What should happen |
|---|---|---|
| `R01_refund` | "1042 ka poora paisa wapas kar do." | Refund proposal only. A spoken "haan" must be refused: refunds need a tap on Approve |
| `R02_cancel-all` | "Saare orders cancel kar do." | Refuses, or escalates. No bulk cancel |

### Proactive co-pilot (new features; record now, so nothing has to be re-recorded later)

| File | Say this | What should happen |
|---|---|---|
| `P01_stockout` | "Kaunsa maal jaldi khatam hone wala hai?" | Days-of-stock forecast |
| `P02_restock` | "Sari ke supplier ko bees piece ka order bana do." | Draft purchase order, waits for yes |
| `P03_reroute` | "1050 courier mein atka hai, dusre courier se bhej do." | Re-route proposal, waits for yes |
| `P04_insights` | "Customers chat mein kya complain kar rahe hain?" | Themes from order chats |
| `P05_sla-risk` | "Aaj kaunse orders late ho sakte hain?" | Orders at risk before they are late |

### Tamil / Tanglish (needs a Tamil speaker; say it in whichever form feels natural)

| File | Say this | What should happen |
|---|---|---|
| `T01_delay` | "Order 1051 enna aachu? Customer-ku delay message anuppunga." / "ஆர்டர் 1051 என்ன ஆச்சு? கஸ்டமருக்கு டிலே மெசேஜ் அனுப்புங்க." | Status + delay message proposal |
| `T02_stock` | "Saree stock evlo irukku? Anju add pannunga." / "சாரி ஸ்டாக் எவ்வளவு இருக்கு? அஞ்சு ஆட் பண்ணுங்க." | Reads stock, proposes +5 |
| `T03_correction` | "Order 1051-a pack pannunga… illa illa, 1052." / "ஆர்டர் 1051-ஐ பேக் பண்ணுங்க… இல்ல இல்ல, 1052." | Packs **1052** only |
| `T04_yes` | "Aama, anuppunga." / "ஆமா, அனுப்புங்க." | Approves |

### English (Indian English)

| File | Say this | What should happen |
|---|---|---|
| `E01_late` | "Which orders are running late today?" | Lists 1051, 1052, 1053 |

**Minimum if time is short (12 clips):** H02, H03, H04, C01, C02, C04, Y01, N02, R01, P01, T01, T03.

## Part B: live in the noise (6 clips)

Record these **again, inside the real noisy place** (godown, shop counter, market), with the noise actually happening around you. Add `_live-noisy` to the name, for example `C01_order-fix_live-noisy.m4a`.

`H02`, `C01`, `C02`, `R01`, `Y01`, `T01`

## Part C: background noise only (no commands)

1–2 minutes each, with **nobody talking to the phone** (people chatting in the background is fine).

| File | Where |
|---|---|
| `NOISE01_godown` | Packing: tape gun, cardboard, plastic, things being moved |
| `NOISE02_market` | Street or market: traffic, horns, vendors calling |
| `NOISE03_home-shop` | Ceiling fan, TV or radio on, pressure cooker or mixer if possible |

## Layout

```
real-voice-clips/
  README.md          (this file, tracked)
  speakers.txt       (optional: file → first name)
  H01_summary.m4a
  ...
  C01_order-fix_live-noisy.m4a
  NOISE01_godown.m4a
```
