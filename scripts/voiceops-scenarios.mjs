// End-to-end VoiceOps scenarios with REAL Gemini Live and synthesized Hinglish speech streamed as mic audio.
// Usage: BASE=http://127.0.0.1:8791 node scripts/voiceops-scenarios.mjs [--only s3] [--out docs/voiceops/SCENARIO_RESULTS.md]
// Requires: server running against a LOCAL database seeded with `npm run seed`. Verifies outcomes in the DB.
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import WebSocket from "ws";

const BASE = process.env.BASE || "http://127.0.0.1:8791";
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const env = {};
for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const dbUrl = env.DATABASE_URL;
if (!dbUrl || !/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) { console.error("Refusing to run: DATABASE_URL must be a local database."); process.exit(1); }
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const q = async (text, params) => (await db.query(text, params)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMINI = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`;

// ---------- audio helpers ----------
const clipCache = new Map();
async function synth(text) {
  if (clipCache.has(text)) return clipCache.get(text);
  const ws = new WebSocket(GEMINI);
  const chunks = [];
  await new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ setup: { model: `models/${env.GEMINI_LIVE_MODEL || "gemini-3.8-live"}`, generationConfig: { responseModalities: ["AUDIO"] }, systemInstruction: { parts: [{ text: "You are a text-to-speech engine. Say exactly the user's text aloud, quickly, in a natural Indian voice, nothing else." }] } } })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
      for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData) chunks.push(Buffer.from(p.inlineData.data, "base64"));
      if (m.serverContent?.turnComplete) { ws.close(); resolve(); }
    });
    ws.on("error", reject);
  });
  const pcm24 = Buffer.concat(chunks);
  const n24 = pcm24.length / 2, n16 = Math.floor((n24 * 2) / 3), out = Buffer.alloc(n16 * 2);
  for (let i = 0; i < n16; i++) {
    const pos = i * 1.5, i0 = Math.floor(pos), f = pos - i0;
    const a = pcm24.readInt16LE(i0 * 2), b = pcm24.readInt16LE(Math.min(i0 + 1, n24 - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  // trim trailing silence from the synthesized clip so "end of speech" is the real last spoken sample
  let end = out.length;
  const win = 800; // 50 ms
  while (end > win * 2) {
    let sum = 0;
    for (let i = end - win; i < end; i += 2) { const v = out.readInt16LE(i); sum += v * v; }
    if (Math.sqrt(sum / (win / 2)) > 250) break;
    end -= win;
  }
  const trimmed = out.subarray(0, end);
  clipCache.set(text, trimmed);
  return trimmed;
}
const rmsOf = (buf) => { let s = 0; const n = buf.length / 2; for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / Math.max(n, 1)); };
// warehouse-style noise: broadband + 100 Hz machine hum + occasional clank bursts, at a given SNR vs the speech RMS
function noiseFor(samples, speechRms, snrDb, offset = 0) {
  const target = speechRms / 10 ** (snrDb / 20);
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = (i + offset) / 16000;
    const white = (Math.random() * 2 - 1) * 1.7;
    const hum = Math.sin(2 * Math.PI * 100 * t) * 0.9 + Math.sin(2 * Math.PI * 220 * t) * 0.4;
    const clank = Math.sin(2 * Math.PI * 1800 * t) * Math.max(0, Math.sin(2 * Math.PI * 0.7 * t)) ** 12 * 2;
    out[i] = (white + hum + clank) * target * 0.55;
  }
  return out;
}
function mixNoise(speech, snrDb) {
  const n = speech.length / 2;
  const noise = noiseFor(n, rmsOf(speech), snrDb);
  const out = Buffer.alloc(speech.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(speech.readInt16LE(i * 2) + noise[i]))), i * 2);
  return out;
}

// ---------- session helper ----------
class Agent {
  constructor(cookie) {
    this.events = []; this.frames = []; this.t0 = Date.now(); this.noiseSnr = null; this.noiseRms = 0; this.pos = 0;
    this.ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/voiceops/live", { headers: { cookie } });
    this.ws.on("message", (d, bin) => {
      if (bin) return void this.frames.push(Date.now());
      const e = JSON.parse(d.toString()); e.at = Date.now(); this.events.push(e);
    });
  }
  async ready() { await this.wait((e) => e.type === "ready", 15000); }
  async wait(pred, ms = 30000, from = 0) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = this.events.slice(from).find(pred); if (hit) return hit; await sleep(50); }
    return null;
  }
  mark() { return this.events.length; }
  /** Wait until the agent has gone quiet (no events/audio) for `quiet` ms. */
  async settle(quiet = 5000, max = 70000) {
    const end = Date.now() + max;
    while (Date.now() < end) {
      const last = Math.max(this.frames.at(-1) ?? 0, this.events.at(-1)?.at ?? 0);
      if (Date.now() - last > quiet) return;
      await sleep(250);
    }
  }
  /** Stream speech (with optional noise) paced like a mic, then trailing noise/silence. Returns time the last speech chunk was sent. */
  async speak(text, { snr = null, tail = 2500 } = {}) {
    let pcm = await synth(text);
    if (snr !== null) pcm = mixNoise(pcm, snr);
    const speechRms = rmsOf(pcm);
    for (let i = 0; i < pcm.length; i += 3200) { this.ws.send(pcm.subarray(i, Math.min(i + 3200, pcm.length)), { binary: true }); await sleep(100); }
    const speechEnd = Date.now();
    const tailSamples = Math.floor((tail / 1000) * 16000);
    const tailBuf = Buffer.alloc(tailSamples * 2);
    if (snr !== null) { const nz = noiseFor(tailSamples, speechRms, snr, 99999); for (let i = 0; i < tailSamples; i++) tailBuf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(nz[i]))), i * 2); }
    for (let i = 0; i < tailBuf.length; i += 3200) { if (this.ws.readyState !== WebSocket.OPEN) break; this.ws.send(tailBuf.subarray(i, Math.min(i + 3200, tailBuf.length)), { binary: true }); await sleep(100); }
    return speechEnd;
  }
  firstFrameAfter(t) { return this.frames.find((f) => f >= t) ?? null; }
  async close() { try { this.ws.send(JSON.stringify({ type: "end" })); } catch {} await sleep(300); this.ws.close(); }
}

const login = await fetch(`${BASE}/api/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "seller" }) });
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) { console.error("login failed"); process.exit(1); }
const post = (path, body = {}) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) }).then((r) => r.json());
const orderStatus = async (no) => (await q("SELECT o.status FROM orders o JOIN voiceops_order_numbers n ON n.order_id=o.id WHERE n.order_no=$1", [no]))[0]?.status;
const toolEvents = (a, name) => a.events.filter((e) => e.type === "tool_result" && e.name === name);
const approvalsFor = (a, tool) => a.events.filter((e) => e.type === "approval_required" && e.tool === tool);

const results = [];
async function scenario(id, title, fn) {
  if (only && only !== id) return;
  console.log(`\n=== ${id}: ${title}`);
  await post("/api/voiceops/demo/reset");
  const agent = new Agent(cookie);
  const r = { id, title, pass: false, notes: [], metrics: {} };
  try { await agent.ready(); await fn(agent, r); } catch (e) { r.notes.push(`ERROR ${e.message}`); }
  if (process.env.DEBUG_EVENTS && r.speechEnd) console.log('  speechEnd at', r.speechEnd - agent.t0, 'first frame after', (agent.firstFrameAfter(r.speechEnd) ?? 0) - agent.t0);
  if (process.env.DEBUG_EVENTS) for (const e of agent.events) if (!(e.type === 'transcript' && !e.final && !process.env.VERBOSE)) console.log('  ev', String(e.at - agent.t0).padStart(6), e.type, e.name ?? '', e.type === 'tool_result' || e.type === 'approval_resolved' ? `${e.result.status} ${e.result.code ?? ''} ${e.result.message ?? ''}` : (e.text ?? e.approval?.readback ?? ''));
  await agent.close();
  r.sessionSeconds = ((Date.now() - agent.t0) / 1000).toFixed(0);
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${id}`, r.notes.join(" | "), JSON.stringify(r.metrics));
}
const lat = (a, r, speechEnd, key = "speech_end_to_first_audio_ms") => { const f = a.firstFrameAfter(speechEnd); if (f) r.metrics[key] = f - speechEnd; };

// S1: daily operations
await scenario("s1", "Daily operations (Hinglish): pending orders, delayed, low stock", async (a, r) => {
  const end = await a.speak("Aaj ke pending orders aur low stock check karo. Jo orders chaubees ghante se dispatch nahi hue unko batao.");
  lat(a, r, end);
  await a.settle();
  const tools = a.events.filter((e) => e.type === "tool_result").map((e) => e.name);
  const delayedCalled = a.events.some((e) => e.type === "tool_result" && (e.name === "business_summary" || (e.name === "list_orders" && e.result.data?.orders?.some((o) => o.delayed))));
  const agentSpoke = a.events.some((e) => e.type === "transcript" && e.role === "agent" && /105[123]/.test(e.text));
  r.metrics.tools = tools.join(",");
  r.notes.push(`tools: ${[...new Set(tools)].join(", ") || "none"}`, agentSpoke ? "spoke delayed order numbers" : "did not name delayed orders");
  r.pass = tools.length >= 2 && delayedCalled && a.frames.length > 0 && (await q("SELECT count(*)::int n FROM voiceops_actions WHERE status='succeeded' AND tool NOT IN ('business_summary','list_orders','list_low_stock','get_order')"))[0].n === 0;
});

// S2: return with refund deferred, approved BY VOICE
await scenario("s2", "Return resolution: 1042, refund on hold, spoken approval", async (a, r) => {
  const end = await a.speak("Order 1042 ka return initiate karo, lekin refund abhi mat karna.");
  lat(a, r, end);
  const req = await a.wait((e) => e.type === "approval_required" && e.tool === "create_return", 45000);
  r.notes.push(req ? `approval: "${req.approval.readback}"` : "no approval raised");
  if (!req) return;
  const readbackOk = /1042/.test(req.approval.readback) && /no refund/i.test(req.approval.readback);
  await a.wait((e) => e.type === "turn_complete" && e.at > req.at, 30000);
  const m = a.mark();
  const end2 = await a.speak("Haan, kar do.");
  lat(a, r, end2, "voice_approval_to_first_audio_ms");
  const done = await a.wait((e) => e.type === "approval_resolved" && e.result?.status === "succeeded", 30000, m);
  const ret = (await q("SELECT r.refund_deferred, r.state FROM voiceops_returns r JOIN voiceops_order_numbers n ON n.order_id=r.order_id WHERE n.order_no=1042"))[0];
  const confirm = a.events.find((e) => e.type === "tool_result" && e.name === "confirm_action");
  r.notes.push(`voice approval ${done ? "accepted" : "NOT accepted"}`, ret ? `return row state=${ret.state} refund_deferred=${ret.refund_deferred}` : "no return row");
  r.pass = Boolean(readbackOk && done && ret && ret.refund_deferred && confirm);
});

// S3: exception + interruption + revised intent + human approval
await scenario("s3", "Exception: cancel 1050 (already shipped) + spoken interruption -> delay message", async (a, r) => {
  await synth("Wait! Cancel nahi karna. Customer ko delay ka message bhejo."); // pre-render so synthesis time is not counted
  const end = await a.speak("Order 1050 cancel kar do.");
  lat(a, r, end);
  const blocked = await a.wait((e) => e.type === "tool_result" && e.name === "cancel_order", 45000);
  r.notes.push(blocked ? `cancel_order -> ${blocked.result.status} ${blocked.result.code ?? ""}` : "cancel_order not called");
  // anchor on the agent's first audio AFTER the block result (its explanation), then barge in 300 ms later
  const t1 = Date.now();
  let firstFrame = null;
  const since = blocked ? blocked.at : end;
  while (!(firstFrame = a.firstFrameAfter(since)) && Date.now() - t1 < 30000) await sleep(20);
  const talking = Boolean(firstFrame);
  if (firstFrame) await sleep(Math.max(0, firstFrame + 300 - Date.now()));
  const mi = a.mark();
  const interruptAt = Date.now();
  await a.speak("Wait! Cancel nahi karna. Customer ko delay ka message bhejo.", { tail: 3000 });
  const interrupted = await a.wait((e) => e.type === "interrupted", 8000, mi);
  r.metrics.interrupted_event_ms = interrupted ? interrupted.at - interruptAt : null;
  r.notes.push(interrupted ? "agent audio cut off (interrupted event)" : talking ? "no interrupted event (agent may already have finished)" : "agent never spoke before barge-in");
  let req = await a.wait((e) => e.type === "approval_required" && e.tool === "send_customer_message", 40000, mi);
  if (!req) {
    r.notes.push("needed a nudge");
    const mn = a.mark();
    await a.speak("Haan, bas chhota sa delay ka message bhej do.");
    req = await a.wait((e) => e.type === "approval_required" && e.tool === "send_customer_message", 40000, mn);
  }
  if (!req) { r.notes.push("no message approval"); return; }
  r.notes.push(`message approval: "${req.approval.readback.slice(0, 110)}"`);
  a.ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id }));
  const done = await a.wait((e) => e.type === "approval_resolved" && e.via === "tap" && e.result.status === "succeeded", 20000);
  const ntf = await q("SELECT body, delivery FROM voiceops_notifications n JOIN voiceops_order_numbers x ON x.order_id=n.order_id WHERE x.order_no=1050");
  r.notes.push(`tap approval ${done ? "ok" : "failed"}`, `notification rows=${ntf.length}`);
  // Correct exception handling is either: cancel attempted and blocked by policy, OR the agent checked the order,
  // saw it had shipped and never attempted the cancel. Either way the order must stay shipped.
  const checkedShipped = toolEvents(a, "get_order").some((e) => e.result?.data?.status === "shipped") && toolEvents(a, "cancel_order").length === 0;
  const exceptionHandled = (blocked && blocked.result.code === "ORDER_ALREADY_DISPATCHED") || checkedShipped;
  if (!blocked && checkedShipped) r.notes.push("agent checked the order, saw it shipped and did not attempt a cancel (safe)");
  r.pass = Boolean(exceptionHandled && done && ntf.length === 1 && (await orderStatus(1050)) === "shipped" && /1050/.test(req.approval.readback));
});

// S4: noisy warehouse, 8 dB SNR
await scenario("s4", "Noisy warehouse (8 dB SNR): mark 1051 packed", async (a, r) => {
  const end = await a.speak("Order 1051 ko packed mark kar do.", { snr: 8 });
  lat(a, r, end);
  const req = await a.wait((e) => e.type === "approval_required", 45000);
  const heard = a.events.filter((e) => e.type === "transcript" && e.role === "user").at(-1)?.text ?? "";
  r.notes.push(`heard: "${heard}"`);
  const wrongWrite = (await q("SELECT count(*)::int n FROM voiceops_actions WHERE status='succeeded' AND tool='update_order_status'"))[0].n;
  if (req) {
    const no = /(\d{4})/.exec(req.approval.readback)?.[1];
    r.notes.push(`agent proposed: "${req.approval.readback}"`);
    r.metrics.proposed_order = no;
    r.pass = no === "1051" && wrongWrite === 0; // understood correctly, and nothing executed without approval
  } else {
    const asked = a.events.some((e) => e.type === "transcript" && e.role === "agent" && /repeat|dobara|phir se|confirm|kaun|which|kya aap/i.test(e.text));
    r.notes.push(asked ? "asked the seller to repeat/confirm (safe)" : "no approval and no clarification");
    r.pass = asked && wrongWrite === 0; // acceptable safe behavior
  }
});

// S5: spoken self-correction mid-sentence
await scenario("s5", "Spoken correction: '1052... nahi, 1053' -> ship with tracking", async (a, r) => {
  const end = await a.speak("Order 1052 ko... nahi nahi, order 1053 ko shipped mark karo, Delhivery se, tracking number D L 9 9 9.");
  lat(a, r, end);
  r.speechEnd = end;
  const req = await a.wait((e) => e.type === "approval_required" && e.tool === "update_order_status", 45000);
  const heard = a.events.filter((e) => e.type === "transcript" && e.role === "user").at(-1)?.text ?? "";
  r.notes.push(`heard: "${heard}"`, req ? `agent proposed: "${req.approval.readback}"` : "no approval");
  const wrong = approvalsFor(a, "update_order_status").some((e) => /1052/.test(e.approval.readback));
  r.pass = Boolean(req && /1053/.test(req.approval.readback) && !wrong && /shipped/.test(req.approval.readback));
});

// S6: Tamil / Tanglish
await scenario("s6", "Tamil/Tanglish: message customer of order 1053 in Tamil", async (a, r) => {
  const end = await a.speak("Order 1053 oda customer Lakshmi-kku, order konjam late aagum nu Tamil-la oru message anuppu.");
  lat(a, r, end);
  const req = await a.wait((e) => e.type === "approval_required" && e.tool === "send_customer_message", 50000);
  const heard = a.events.filter((e) => e.type === "transcript" && e.role === "user").at(-1)?.text ?? "";
  r.notes.push(`heard: "${heard}"`);
  if (!req) { r.notes.push("no message approval"); return; }
  const tamilScript = /[஀-௿]/.test(req.approval.readback);
  r.notes.push(`proposed: "${req.approval.readback.slice(0, 120)}"`, tamilScript ? "message in Tamil script" : "message not in Tamil script");
  r.metrics.tamil_script = tamilScript;
  r.pass = /1053/.test(req.approval.readback);
});

await db.end();
const md = [
  `# VoiceOps scenario results`, ``,
  `Run: ${new Date().toISOString()} against ${BASE}, model ${env.GEMINI_LIVE_MODEL || "gemini-3.8-live"}.`,
  `Speech is synthesized by Gemini and streamed as 16 kHz mic audio (not human recordings). Latency = last speech sample sent -> first agent audio frame received at the client, so it includes end-of-turn detection, tool calls and network.`, ``,
  `| # | Scenario | Result | Latency (ms) | Notes |`, `|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.pass ? "PASS" : "FAIL"} | ${r.metrics.speech_end_to_first_audio_ms ?? "n/a"} | ${r.notes.join("; ").replace(/\|/g, "/")} |`),
  ``, `Passed ${results.filter((r) => r.pass).length} of ${results.length}.`, ``,
].join("\n");
console.log("\n" + md);
if (outFile) writeFileSync(outFile, md);
process.exit(results.every((r) => r.pass) ? 0 : 2);
