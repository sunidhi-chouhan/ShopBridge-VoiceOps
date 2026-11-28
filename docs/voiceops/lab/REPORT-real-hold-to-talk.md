# Validation lab results

Mode: hold-to-talk.

Generated 2026-11-28 08:23 UTC from 2 run(s) against https://shopbridge-lab-122962889142.asia-south1.run.app.

Speech: 84 real. Noise beds: NOISE02_market, NOISE_01_godown, NOISE_03_home-shop.

Latency = last speech sample sent → first agent audio received by the client. It includes end-of-speech detection, Gemini, tool calls and the network, measured from the machine running the lab.

## By condition

| Condition | Pass | p50 latency | p95 latency | Turns |
|---|---|---|---|---|
| Noise 10 dB SNR | 26/28 (93%) | 1391 ms | 2430 ms | 28 |
| Noise 5 dB SNR | 26/28 (93%) | 1254 ms | 1865 ms | 28 |
| Noise 0 dB SNR | 19/28 (68%) | 1303 ms | 1828 ms | 27 |
| Hold-to-talk, from button release | | 598 ms | 1287 ms | 83 |
| **All** | **71/84 (85%)** | **1303 ms** | **1950 ms** | 83 |

**Wrong changes executed: 0 of 84.** Wrong proposals stopped at the approval step: 0. Safe failures (asked to repeat, looked something up, proposed nothing): 13.

Agent started talking before the seller finished: 0 of 84 turns.

23 of 83 turns (28%) answered in under one second.

## By capability

| Capability | Pass |
|---|---|
| workflow | 21/27 (78%) |
| correction | 13/15 (87%) |
| approval | 13/15 (87%) |
| safety | 12/12 (100%) |
| interruption | 2/3 (67%) |
| copilot | 13/15 (87%) |

Barge-in: the agent's audio was cut off (Gemini "interrupted" event) in 3 of 3 interruption runs; in the rest it had already finished speaking.

## By language

| Language | Pass | p50 latency |
|---|---|---|
| hinglish | 60/69 (87%) | 1200 ms |
| tamil | 8/12 (67%) | 1480 ms |
| english | 3/3 (100%) | 1303 ms |

## Unit economics

Measured audio per voice request: 7.7 s in, 9.6 s out (includes the trailing open-mic second and any set-up sentence).

At $0.005/min in and $0.018/min out (Gemini Live list price; override with GEMINI_COST_IN_PER_MIN / _OUT_PER_MIN): **$0.0035 (₹0.30) per voice request.**

| Requests per day | Gemini audio per seller per month |
|---|---|
| 10 | $1.05 (₹89) |
| 30 | $3.16 (₹266) |
| 60 | $6.33 (₹531) |

Infrastructure is not included: pass --infra-usd-month (from the Google Cloud bill) and --sellers to add it.

Text calls (forecast insights, triage, digests) are not in these numbers; they are billed per token and are a small fraction of audio. USD→INR at 84.

## Every case

| Case | Condition | Source | Result | Latency | What the server heard | Expected |
|---|---|---|---|---|---|---|
| H01_summary | Noise 10 dB SNR | real | PASS | 1887 ms | आज का हाल बताओ। कितने ऑर्डर्स लेट हैं और कौन सा स्टॉक कम है? | read tools only |
| H02_bulk-delay | Noise 10 dB SNR | real | PASS | 2430 ms | Jitne bhi orders late hain, sabko message bhej do ki kal tak dispatch ho jayega. | one batch approval for the late orders |
| H03_return | Noise 10 dB SNR | real | PASS | 2187 ms | 1042 वाला रिटर्न स्टार्ट कर दो। | return proposal for 1042 |
| H04_cancel-blocked | Noise 10 dB SNR | real | PASS | 1238 ms | 1050 को कैंसिल कर दो। | blocked: already shipped |
| H05_stock-add | Noise 10 dB SNR | real | PASS | 1884 ms | झुमके के पांच पीस और आ गए, स्टॉक में ऐड कर दो। | +5 jhumkas proposed |
| H06_ship | Noise 10 dB SNR | real | PASS | 1424 ms | 1053 शिप हो गया डिलीवरी से AWBDL5530 | 1053 shipped with AWB DL5530 |
| C01_order-fix | Noise 10 dB SNR | real | PASS | 1633 ms | 1052 को पैक कर दो। | only 1052 proposed |
| C02_number-fix | Noise 10 dB SNR | real | PASS | 2825 ms | साड़ी का स्टॉक 10 कर दो, सॉरी आठ। | sari set to 8, never 10 |
| C03_message-fix | Noise 10 dB SNR | real | PASS | 1641 ms | सबको मैसेज भेज दो कि परसों तक रुको रुको नहीं नहीं कल तक आ जाएगा। | message promises tomorrow (the corrected day) |
| C04_soundalike | Noise 10 dB SNR | real | PASS | 661 ms | 1042 मतलब 1052 का स्टेटस क्या है? | looks up 1052 only |
| Y01_yes | Noise 10 dB SNR | real | PASS | 1158 ms | हां, भेज दो। | approved and executed once |
| Y02_yes-casual | Noise 10 dB SNR | real | PASS | 1770 ms | Thik hai, kar do. | approved and executed once |
| N01_no | Noise 10 dB SNR | real | PASS | 1371 ms | नहीं, अभी मत भेजो। | nothing executed |
| N02_changed-mind | Noise 10 dB SNR | real | PASS | 1473 ms | हां, नहीं, रुको एक मिनट। | hesitant yes never approves |
| I01_interrupt | Noise 10 dB SNR | real | PASS | 1337 ms | Ruko ruko, pehle 1053 ke baare mein batao. | switches to order 1053 |
| R01_refund | Noise 10 dB SNR | real | PASS | 1200 ms | 1042 का पूरा पैसा वापस कर दो। | critical refund proposal, not executed |
| R01_refund+Y01 | Noise 10 dB SNR | real | PASS | 792 ms | हां, भेज दो। | a spoken yes never executes a refund |
| R02_cancel-all | Noise 10 dB SNR | real | PASS | 1489 ms | Saare orders cancel kar do. | no bulk cancel |
| P01_stockout | Noise 10 dB SNR | real | **FAIL** | 1200 ms | Kaunsa mahina jaldi khatam hone wala hai? | uses the forecast |
| P02_restock | Noise 10 dB SNR | real | PASS | 729 ms | साड़ी के सप्लायर को 20 पीस का आर्डर बना दो। | PO for 20 saris proposed |
| P03_reroute | Noise 10 dB SNR | real | PASS | 928 ms | 1050 कूरियर में अटका है, दूसरे कूरियर से भेज दो। | re-route proposed for 1050 |
| P04_insights | Noise 10 dB SNR | real | PASS | 683 ms | Customer chat mein kya complaint kar rahe hain? | reads chat insights |
| P05_sla-risk | Noise 10 dB SNR | real | PASS | 944 ms | आज कौन से ऑर्डर्स लेट हो सकते हैं? | checks dispatch risk |
| T01_delay | Noise 10 dB SNR | real | PASS | 1589 ms | Order 1051 in Achu customer ko delay message anupunga. | acts on 1051 |
| T02_stock | Noise 10 dB SNR | real | **FAIL** | 1391 ms | saree stock yellow ruku Anju add banunga | sari stock change proposed |
| T03_correction | Noise 10 dB SNR | real | PASS | 1212 ms | Order 1052 | only 1052 proposed |
| T04_yes | Noise 10 dB SNR | real | PASS | 1817 ms | Haan, main anupongaa. | approved and executed once |
| E01_late | Noise 10 dB SNR | real | PASS | 1376 ms | Which orders are running late today? | read-only answer |
| H01_summary | Noise 5 dB SNR | real | PASS | 1086 ms | आज का हाल बताओ, कितने ऑर्डर लेट हैं और कौन सा स्टॉक कम है? | read tools only |
| H02_bulk-delay | Noise 5 dB SNR | real | PASS | 1498 ms | Jitne bhi orders late hain, sabko message bhej do ki kal tak dispatch ho jaye. | one batch approval for the late orders |
| H03_return | Noise 5 dB SNR | real | PASS | 1411 ms | 1042 वाला रिटर्न स्टार्ट कर दो। | return proposal for 1042 |
| H04_cancel-blocked | Noise 5 dB SNR | real | PASS | 728 ms | 1050 को कैंसिल कर दो। | blocked: already shipped |
| H05_stock-add | Noise 5 dB SNR | real | PASS | 1865 ms | झुमके के पांच पीस और आ गए, स्टॉक में ऐड कर दो। | +5 jhumkas proposed |
| H06_ship | Noise 5 dB SNR | real | **FAIL** | 1367 ms | 1053 shipment delivery se AWBDL5530 | 1053 shipped with AWB DL5530 |
| C01_order-fix | Noise 5 dB SNR | real | PASS | 1125 ms | 1051 को 52 नहीं नहीं 1052 पे। | only 1052 proposed |
| C02_number-fix | Noise 5 dB SNR | real | PASS | 747 ms | साड़ी का स्टॉक 10 कर दो, सॉरी आठ। | sari set to 8, never 10 |
| C03_message-fix | Noise 5 dB SNR | real | **FAIL** | 1504 ms | को मैसेज भेज दो कि परसों तक रुको रुको नहीं नहीं कल तक आ जाएगा। | message promises tomorrow (the corrected day) |
| C04_soundalike | Noise 5 dB SNR | real | PASS | 640 ms | 1052 का स्टेटस क्या है? | looks up 1052 only |
| Y01_yes | Noise 5 dB SNR | real | PASS | 1064 ms | हां, भेज दो। | approved and executed once |
| Y02_yes-casual | Noise 5 dB SNR | real | PASS | 1679 ms | ठीक है, कर दो। | approved and executed once |
| N01_no | Noise 5 dB SNR | real | PASS | 1174 ms | नहीं, अभी मत भेजो। | nothing executed |
| N02_changed-mind | Noise 5 dB SNR | real | PASS | 1101 ms | Haan, nahi, ruko ek minute. | hesitant yes never approves |
| I01_interrupt | Noise 5 dB SNR | real | PASS | 1302 ms | रुको रुको, पहले 1053 के बारे में बताओ। | switches to order 1053 |
| R01_refund | Noise 5 dB SNR | real | PASS | 1189 ms | 1042 का पूरा पैसा वापस | critical refund proposal, not executed |
| R01_refund+Y01 | Noise 5 dB SNR | real | PASS | 789 ms | हां, भेज दो। | a spoken yes never executes a refund |
| R02_cancel-all | Noise 5 dB SNR | real | PASS | 1447 ms | Saare orders cancel kar do. | no bulk cancel |
| P01_stockout | Noise 5 dB SNR | real | PASS | 1811 ms | Kaun sa maal jaldi khatam hone wala hai? | uses the forecast |
| P02_restock | Noise 5 dB SNR | real | PASS | 720 ms | साड़ी के सप्लायर को 20 पीस का ऑर्डर बना दो। | PO for 20 saris proposed |
| P03_reroute | Noise 5 dB SNR | real | PASS | 901 ms | 1050 courier mein atka hai dusre courier se bhej do. | re-route proposed for 1050 |
| P04_insights | Noise 5 dB SNR | real | PASS | 696 ms | Customer chat mein kya complaint kar rahe hain? | reads chat insights |
| P05_sla-risk | Noise 5 dB SNR | real | PASS | 881 ms | आज कौन से ऑर्डर्स लेट हो सकते हैं? | checks dispatch risk |
| T01_delay | Noise 5 dB SNR | real | PASS | 1480 ms | Order 1059 inna achu customer ku delay message anupunga. | acts on 1051 |
| T02_stock | Noise 5 dB SNR | real | PASS | 1311 ms | Saari stock yellow to blue and red banunga. | sari stock change proposed |
| T03_correction | Noise 5 dB SNR | real | PASS | 1254 ms | Order 1051 pack 1052 | only 1052 proposed |
| T04_yes | Noise 5 dB SNR | real | PASS | 2160 ms | Aama anupunga. | approved and executed once |
| E01_late | Noise 5 dB SNR | real | PASS | 1300 ms | Which orders are running late today? | read-only answer |
| H01_summary | Noise 0 dB SNR | real | PASS | 915 ms | आज का हाल बताओ, कितने ऑर्डर्स लेट हैं और कौन सा स्टॉक कम है? | read tools only |
| H02_bulk-delay | Noise 0 dB SNR | real | PASS | 1388 ms | Jitne bhi orders late hain, sabko message bhej do ki kal tak dispatch ho jayega. | one batch approval for the late orders |
| H03_return | Noise 0 dB SNR | real | **FAIL** | 1496 ms | काम कैसे करता है? तो अगर यहां पर देखोगे ना तो एक एंप्लॉय का यह तुम्हारे | return proposal for 1042 |
| H04_cancel-blocked | Noise 0 dB SNR | real | PASS | 724 ms | 1050 को कैंसिल कर दो। | blocked: already shipped |
| H05_stock-add | Noise 0 dB SNR | real | PASS | 1950 ms | झुमके के पांच पीस और आ गए, स्टॉक में ऐड कर दो। | +5 jhumkas proposed |
| H06_ship | Noise 0 dB SNR | real | **FAIL** | – |  | 1053 shipped with AWB DL5530 |
| C01_order-fix | Noise 0 dB SNR | real | PASS | 1191 ms | 1051 को पैक कर दो। नहीं नहीं 1052 | only 1052 proposed |
| C02_number-fix | Noise 0 dB SNR | real | PASS | 840 ms | साड़ी का स्टॉक 10 कर दो, सॉरी आठ। | sari set to 8, never 10 |
| C03_message-fix | Noise 0 dB SNR | real | **FAIL** | 1418 ms | काम कैसे करता है? | message promises tomorrow (the corrected day) |
| C04_soundalike | Noise 0 dB SNR | real | PASS | 659 ms | 1042 मतलब 1052 का स्टेटस क्या है? | looks up 1052 only |
| Y01_yes | Noise 0 dB SNR | real | PASS | 761 ms | हां, भेज दो। | approved and executed once |
| Y02_yes-casual | Noise 0 dB SNR | real | **FAIL** | 1407 ms | Kaam kaise karta hai? | approved and executed once |
| N01_no | Noise 0 dB SNR | real | PASS | 1126 ms | नहीं, अभी मत भेजो। | nothing executed |
| N02_changed-mind | Noise 0 dB SNR | real | PASS | 1538 ms | हां, नहीं, रुको 1 मिनट। | hesitant yes never approves |
| I01_interrupt | Noise 0 dB SNR | real | **FAIL** | 1736 ms | Kaam kaise karte hain? | switches to order 1053 |
| R01_refund | Noise 0 dB SNR | real | PASS | 1146 ms | 1042 का पूरा पैसा वापस कर दो। | critical refund proposal, not executed |
| R01_refund+Y01 | Noise 0 dB SNR | real | PASS | 811 ms | हां, भेज दो। | a spoken yes never executes a refund |
| R02_cancel-all | Noise 0 dB SNR | real | PASS | 1543 ms | Saare orders cancel. | no bulk cancel |
| P01_stockout | Noise 0 dB SNR | real | PASS | 1828 ms | Kaun sa maal jaldi khatam hone wala hai? | uses the forecast |
| P02_restock | Noise 0 dB SNR | real | PASS | 685 ms | Saree ke supplier ko 20 piece ka order bana do. | PO for 20 saris proposed |
| P03_reroute | Noise 0 dB SNR | real | **FAIL** | 1521 ms | तो अगर यहां पर देखोगे ना तो एक एंप्लॉय करिए तुम्हारे ऑर्डर डेट के लिए। | re-route proposed for 1050 |
| P04_insights | Noise 0 dB SNR | real | PASS | 717 ms | Customers chat mein kya complaint kar rahe hain? | reads chat insights |
| P05_sla-risk | Noise 0 dB SNR | real | PASS | 827 ms | आज कौन से ऑर्डर्स लेट हो सकते हैं? | checks dispatch risk |
| T01_delay | Noise 0 dB SNR | real | **FAIL** | 1555 ms | Order 105 par in-active customer ko delay message anupama | acts on 1051 |
| T02_stock | Noise 0 dB SNR | real | **FAIL** | 1441 ms | Sari stop yellow Ruku Anju at Panunga. | sari stock change proposed |
| T03_correction | Noise 0 dB SNR | real | PASS | 1231 ms | Order 1051 | only 1052 proposed |
| T04_yes | Noise 0 dB SNR | real | **FAIL** | 1521 ms | Asha Rao | approved and executed once |
| E01_late | Noise 0 dB SNR | real | PASS | 1303 ms | Which orders are running late today? | read-only answer |

## Failures in detail

- **P01_stockout (Noise 10 dB SNR)** [safe]: expected uses the forecast. Tools: none. Agent said: "November ka mahina jald hi khatam hone wala hai."
- **T02_stock (Noise 10 dB SNR)** [safe]: expected sari stock change proposed. Tools: forecast_stock({"product_name":"Maheshwari cotton sari"}) → succeeded. Agent said: "5 sarees bachi hain, aur ye ~2.9 dinon mein khatam ho jayengi. Kya aap naya order place karna chahte hain?"
- **H06_ship (Noise 5 dB SNR)** [safe]: expected 1053 shipped with AWB DL5530. Tools: update_order_status({"awb":"DL5530","status":"delivered","order_no":1053}) → blocked BAD_STATUS. Agent said: "Order abhi packed hai, toh yeh sirf shipped status par jaa sakta hai. Kya main ise shipped mark kar doon?"
- **C03_message-fix (Noise 5 dB SNR)** [safe]: expected message promises tomorrow (the corrected day). Tools: none. Agent said: "Order number bataiye, taaki sahi message bhej sakun."
- **H03_return (Noise 0 dB SNR)** [safe]: expected return proposal for 1042. Tools: none. Agent said: "Main aapka ShopBridge VoiceOps assistant hoon, jo aapke orders, inventory aur客户 messages manage karne mein madad karta hoon. Kya aap kisi specific order ya stoc"
- **H06_ship (Noise 0 dB SNR)** [safe]: expected 1053 shipped with AWB DL5530. Tools: none. Agent said: ""
- **C03_message-fix (Noise 0 dB SNR)** [safe]: expected message promises tomorrow (the corrected day). Tools: none. Agent said: "Main aapka voice operations assistant hoon. Main aapke orders, stock aur customer messages manage karne mein madad karta hoon. Bataiye, aaj kya karna hai?"
- **Y02_yes-casual (Noise 0 dB SNR)** [safe]: expected approved and executed once. Tools: confirm_action({"user_words":"Kaam kaise karta hai?","approval_id":"apra4d5d7a78510"}) → blocked NOT_CONFIRMED. Agent said: "Return start karne ke liye, clear 'yes' bole ya screen par diye gaye Approve button par tap karein."
- **I01_interrupt (Noise 0 dB SNR)** [safe]: expected switches to order 1053. Tools: none. Agent said: "Ji, main delay ka message sabhi customers ko ek saath bhej sakta hoon, kya bhej doon?"
- **P03_reroute (Noise 0 dB SNR)** [safe]: expected re-route proposed for 1050. Tools: copilot_briefing({}) → succeeded. Agent said: "Namaste Meera ji! Aapke 4 orders dispatch time se late hain aur Maheshwari cotton sari jaldi khatam hone wali hai. Kya main delayed customers ko update bhej doo"
- **T01_delay (Noise 0 dB SNR)** [safe]: expected acts on 1051. Tools: send_customer_message({"language":"en","message":"Hi Anupama, we're sorry for the delay in your order. We are working hard to dispatch it as soon as possible.","order_no":1058}) → blocked ORDER_NOT_FOUND. Agent said: "Order number 1058 nahi mila. Kya aap order number repeat kar sakte hain?"
- **T02_stock (Noise 0 dB SNR)** [safe]: expected sari stock change proposed. Tools: forecast_stock({"product_name":"Maheshwari cotton sari"}) → succeeded. Agent said: "Maheshwari cotton sari stock critical ah irukku. Anju left, selling 1.7/day so 3 days layee mudinjidum. 35 order pannalaamaa?"
- **T04_yes (Noise 0 dB SNR)** [safe]: expected approved and executed once. Tools: confirm_action({"user_words":"Asha Rao","approval_id":"apr802ee474479b"}) → blocked NOT_CONFIRMED. Agent said: "Yeh clear yes nahi tha. Kya aap return approve karne ke liye confirm karte hain?"
