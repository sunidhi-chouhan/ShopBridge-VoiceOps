# VoiceOps scenario results

Run: 2026-11-13T13:12:55.193Z against http://127.0.0.1:8791, model gemini-3.8-live.
Speech is synthesized by Gemini and streamed as 16 kHz mic audio (not human recordings). Latency = last speech sample sent -> first agent audio frame received at the client, so it includes end-of-turn detection, tool calls and network.

| # | Scenario | Result | Latency (ms) | Notes |
|---|---|---|---|---|
| s1 | Daily operations (Hinglish): pending orders, delayed, low stock | PASS | 975 | tools: business_summary, list_orders, list_low_stock; spoke delayed order numbers |
| s2 | Return resolution: 1042, refund on hold, spoken approval | PASS | 1234 | approval: "Start a return for order 1042 (Asha Rao). Reason: Seller-initiated return. No refund will be issued now."; voice approval accepted; return row state=requested refund_deferred=true |
| s3 | Exception: cancel 1050 (already shipped) + spoken interruption -> delay message | PASS | 1584 | cancel_order -> blocked ORDER_ALREADY_DISPATCHED; agent audio cut off (interrupted event); message approval: "Send Asha Rao (order 1050) this message: "Your order 1050 has been delayed. We apologize for the inconvenience"; tap approval ok; notification rows=1 |
| s4 | Noisy warehouse (8 dB SNR): mark 1051 packed | PASS | 1195 | heard: "Order 1051 ko packed mark kar do."; agent proposed: "Mark order 1051 (Imran Sheikh) as packed." |
| s5 | Spoken correction: '1052... nahi, 1053' -> ship with tracking | PASS | 990 | heard: "Order 1053 ko shipped mark karo delivery se. Tracking number DL999."; agent proposed: "Mark order 1053 (Lakshmi Iyer) as shipped with Delivery tracking DL999." |
| s6 | Tamil/Tanglish: message customer of order 1053 in Tamil | PASS | 1233 | heard: "Order 1053 ka customer Lakshmi ko order thoda late hoga Tamil mein ek message bhejo."; proposed: "Send Lakshmi Iyer (order 1053) this message: "வணக்கம் லக்ஷ்மி, உங்கள் ஆர்டர் 1053 கொஞ்சம் தாமதமாகும். சிரமத்திற்கு வருந்"; message in Tamil script |

Passed 6 of 6.
