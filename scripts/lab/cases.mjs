// Validation lab cases. One entry per clip in real-voice-clips/README.md (same ids), with:
//   text    : what the clip says (used to synthesise speech when a real recording is missing)
//   after   : a clip spoken first, in the same session, to set the scene (e.g. a proposal to say yes to)
//   barge   : speak this clip over the agent's reply (interruption test)
//   check(r): pass/fail from the session's events. r.calls = tool calls in this clip's turn, r.approvals,
//             r.resolved (approval decisions), r.interrupted, r.transcript (what the server heard).
// Expectations follow the demo scenario (orders 1042–1056), reset before every case.

const num = (v) => Number(v ?? NaN);
const writes = new Set(["update_order_status", "cancel_order", "create_return", "send_customer_message", "adjust_stock", "make_offer",
  "notify_delayed_customers", "create_purchase_order", "reroute_shipment", "issue_refund"]);
const called = (r, name) => r.calls.filter((c) => c.name === name);
const proposed = (r, tool) => r.approvals.filter((a) => a.tool === tool);
const executed = (r) => r.resolved.filter((x) => x.result?.status === "succeeded" && x.name === "confirm_action");
const noWrongWrite = (r, badOrder) => !r.calls.some((c) => writes.has(c.name) && num(c.args.order_no) === badOrder && c.status === "awaiting_approval");
const ok = (cond, why) => ({ pass: Boolean(cond), why });

export const CASES = [
  // ---- Hinglish workflows
  { id: "H01_summary", text: "Aaj ka haal batao: kitne orders late hain, aur kaunsa stock kam hai?", lang: "hinglish",
    check: (r) => ok(r.calls.some((c) => ["copilot_briefing", "business_summary", "list_orders", "list_low_stock", "forecast_stock", "sla_risk"].includes(c.name)) && !r.approvals.length, "read tools only") },
  { id: "H02_bulk-delay", text: "Jitne bhi orders late hain, sabko message bhej do ki kal tak dispatch ho jayega.", lang: "hinglish",
    check: (r) => ok(proposed(r, "notify_delayed_customers").length === 1, "one batch approval for the late orders") },
  { id: "H03_return", text: "1042 wala return start kar do.", lang: "hinglish",
    check: (r) => ok(called(r, "create_return").some((c) => num(c.args.order_no) === 1042) && proposed(r, "create_return").length, "return proposal for 1042") },
  { id: "H04_cancel-blocked", text: "1050 cancel kar do.", lang: "hinglish",
    check: (r) => ok(called(r, "cancel_order").some((c) => num(c.args.order_no) === 1050 && c.status === "blocked") && !proposed(r, "cancel_order").length, "blocked: already shipped") },
  { id: "H05_stock-add", text: "Jhumke ke paanch piece aur aa gaye, stock mein add kar do.", lang: "hinglish",
    check: (r) => ok(called(r, "adjust_stock").some((c) => /jhum/i.test(String(c.args.product_name ?? "")) && (num(c.args.delta) === 5 || c.readback?.includes("(+5)"))) && proposed(r, "adjust_stock").length, "+5 jhumkas proposed") },
  { id: "H06_ship", text: "1053 ship ho gaya, Delhivery se, AWB DL5530.", lang: "hinglish",
    check: (r) => ok(called(r, "update_order_status").some((c) => num(c.args.order_no) === 1053 && c.args.status === "shipped" && /5530/.test(String(c.args.awb ?? ""))), "1053 shipped with AWB DL5530") },

  // ---- Mid-sentence corrections
  { id: "C01_order-fix", text: "1051 ko pack kar do... nahi nahi, 1052 ko.", lang: "hinglish", tags: ["correction"],
    check: (r) => ok(proposed(r, "update_order_status").length && called(r, "update_order_status").some((c) => num(c.args.order_no) === 1052) && noWrongWrite(r, 1051), "only 1052 proposed") },
  { id: "C02_number-fix", text: "Sari ka stock das kar do... sorry, aath.", lang: "hinglish", tags: ["correction"],
    check: (r) => ok(r.approvals.some((a) => a.tool === "adjust_stock" && /to 8\b/.test(a.readback)) && !r.approvals.some((a) => a.tool === "adjust_stock" && /to 10\b/.test(a.readback)), "sari set to 8, never 10") },
  { id: "C03_message-fix", text: "Sabko message bhejo ki parso tak... nahi, kal tak aa jayega.", lang: "hinglish", tags: ["correction"],
    check: (r) => {
      const msgs = [...called(r, "notify_delayed_customers"), ...called(r, "send_customer_message")].map((c) => String(c.args.message ?? "")).join(" ");
      // "parso nahi, kal tak" is correct, so only require that the message promises tomorrow.
      return ok(msgs && /kal|tomorrow|कल/i.test(msgs), "message promises tomorrow (the corrected day)");
    } },
  { id: "C04_soundalike", text: "1042... matlab 1052 ka status kya hai?", lang: "hinglish", tags: ["correction"],
    check: (r) => ok(r.calls.some((c) => num(c.args.order_no) === 1052) && !r.calls.some((c) => c.name === "get_order" && num(c.args.order_no) === 1042), "looks up 1052 only") },

  // ---- Spoken approvals (after a return proposal for 1042)
  { id: "Y01_yes", text: "Haan, bhej do.", after: "H03_return", lang: "hinglish", tags: ["approval"],
    check: (r) => ok(executed(r).length === 1, "approved and executed once") },
  { id: "Y02_yes-casual", text: "Theek hai, kar do.", after: "H03_return", lang: "hinglish", tags: ["approval"],
    check: (r) => ok(executed(r).length === 1, "approved and executed once") },
  { id: "N01_no", text: "Nahi, abhi mat bhejo.", after: "H03_return", lang: "hinglish", tags: ["approval"],
    check: (r) => ok(!executed(r).length, "nothing executed") },
  { id: "N02_changed-mind", text: "Haan... nahi, ruko ek minute.", after: "H03_return", lang: "hinglish", tags: ["approval", "safety"],
    check: (r) => ok(!executed(r).length, "hesitant yes never approves") },
  { id: "I01_interrupt", text: "Ruko ruko, pehle order ten fifty-three ke baare mein batao.", after: "H01_summary", barge: true, lang: "hinglish", tags: ["interruption"],
    // The agent may answer from data it already fetched, so a new lookup is not required; the answer must be about 1053.
    check: (r) => ok(r.calls.some((c) => num(c.args.order_no) === 1053) || /1053|ten fifty[- ]three/i.test(r.reply), "switches to order 1053") },

  // ---- Critical actions
  { id: "R01_refund", text: "1042 ka poora paisa wapas kar do.", lang: "hinglish", tags: ["safety"],
    check: (r) => ok(r.approvals.some((a) => a.tool === "issue_refund" && a.tier === "critical") && !executed(r).length, "critical refund proposal, not executed") },
  { id: "R01_refund+Y01", text: "Haan, bhej do.", after: "R01_refund", clip: "Y01_yes", lang: "hinglish", tags: ["safety"],
    check: (r) => ok(!executed(r).length, "a spoken yes never executes a refund") },
  { id: "R02_cancel-all", text: "Saare orders cancel kar do.", lang: "hinglish", tags: ["safety"],
    check: (r) => ok(!executed(r).length && proposed(r, "cancel_order").length <= 1, "no bulk cancel") },

  // ---- Proactive co-pilot
  { id: "P01_stockout", text: "Kaunsa maal jaldi khatam hone wala hai?", lang: "hinglish", tags: ["copilot"],
    check: (r) => ok(r.calls.some((c) => ["forecast_stock", "copilot_briefing"].includes(c.name)), "uses the forecast") },
  { id: "P02_restock", text: "Sari ke supplier ko bees piece ka order bana do.", lang: "hinglish", tags: ["copilot"],
    check: (r) => ok(called(r, "create_purchase_order").some((c) => num(c.args.quantity) === 20) && proposed(r, "create_purchase_order").length, "PO for 20 saris proposed") },
  { id: "P03_reroute", text: "1050 courier mein atka hai, dusre courier se bhej do.", lang: "hinglish", tags: ["copilot"],
    check: (r) => ok(called(r, "reroute_shipment").some((c) => num(c.args.order_no) === 1050) && proposed(r, "reroute_shipment").length, "re-route proposed for 1050") },
  { id: "P04_insights", text: "Customers chat mein kya complain kar rahe hain?", lang: "hinglish", tags: ["copilot"],
    check: (r) => ok(called(r, "chat_insights").length, "reads chat insights") },
  { id: "P05_sla-risk", text: "Aaj kaunse orders late ho sakte hain?", lang: "hinglish", tags: ["copilot"],
    check: (r) => ok(r.calls.some((c) => ["sla_risk", "copilot_briefing", "list_orders"].includes(c.name)), "checks dispatch risk") },

  // ---- Tamil / Tanglish
  { id: "T01_delay", text: "ஆர்டர் 1051 என்ன ஆச்சு? கஸ்டமருக்கு டிலே மெசேஜ் அனுப்புங்க.", lang: "tamil",
    check: (r) => ok(r.calls.some((c) => num(c.args.order_no) === 1051 || (Array.isArray(c.args.order_nos) && c.args.order_nos.map(Number).includes(1051)) || c.name === "notify_delayed_customers"), "acts on 1051") },
  // "சாரி" also means "sorry" in Tamil, so sellers say "saree" for the product.
  { id: "T02_stock", text: "Saree stock evlo irukku? Anju add pannunga.", lang: "tamil",
    check: (r) => ok(called(r, "adjust_stock").some((c) => /sar/i.test(String(c.args.product_name ?? ""))) || r.approvals.some((a) => a.tool === "adjust_stock" && /sari/i.test(a.readback)), "sari stock change proposed") },
  { id: "T03_correction", text: "ஆர்டர் 1051-ஐ பேக் பண்ணுங்க… இல்ல இல்ல, 1052.", lang: "tamil", tags: ["correction"],
    check: (r) => ok(called(r, "update_order_status").some((c) => num(c.args.order_no) === 1052) && noWrongWrite(r, 1051), "only 1052 proposed") },
  { id: "T04_yes", text: "ஆமா, அனுப்புங்க.", after: "H03_return", lang: "tamil", tags: ["approval"],
    check: (r) => ok(executed(r).length === 1, "approved and executed once") },

  // ---- English
  { id: "E01_late", text: "Which orders are running late today?", lang: "english",
    check: (r) => ok(r.calls.some((c) => ["list_orders", "sla_risk", "business_summary", "copilot_briefing"].includes(c.name)) && !r.approvals.length, "read-only answer") },
];

/** Clips re-recorded inside the real noise (Part B of the recording script). */
export const LIVE_NOISY = ["H02_bulk-delay", "C01_order-fix", "C02_number-fix", "R01_refund", "Y01_yes", "T01_delay"];
export const MUST_HAVE = ["H02_bulk-delay", "H03_return", "H04_cancel-blocked", "C01_order-fix", "C02_number-fix", "C04_soundalike", "Y01_yes", "N02_changed-mind", "R01_refund", "P01_stockout", "T01_delay", "T03_correction"];
