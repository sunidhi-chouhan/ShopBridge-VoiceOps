// Validation lab: real (or synthesised) speech streamed into the real voice agent, clean and with noise.
//
//   BASE=http://127.0.0.1:8795 node scripts/lab/run-lab.mjs [options]
//     --clips DIR          recordings (default real-voice-clips); files named <ID>.<ext>, <ID>_live-noisy.<ext>, NOISE*.<ext>
//     --conditions LIST    clean,snr10,snr5,snr0,live   (default clean,snr10,snr5,snr0; "live" = Part B recordings)
//     --only ID,ID         run these cases only        --must-have   the 12 must-have clips only
//     --repeat N           runs per case and condition (default 1)
//     --real-only          skip cases without a real recording (no synthesised speech)
//     --out DIR            results folder (default docs/voiceops/lab)
//     --allow-host HOST    required to run against a hosted service (never the public demo)
//
// Every case starts from a demo reset, so run it against a local server or a dedicated lab service,
// never the public demo. Latency = last speech sample sent -> first agent audio frame received here,
// so it includes end-of-speech detection, the model, tools and the network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { CASES, LIVE_NOISY, MUST_HAVE } from "./cases.mjs";

const arg = (name, dflt = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
const flag = (name) => process.argv.includes(name);
const BASE = (process.env.BASE || "http://127.0.0.1:8795").replace(/\/$/, "");
const CLIPS = arg("--clips", "real-voice-clips");
const OUT = arg("--out", "docs/voiceops/lab");
const CONDITIONS = arg("--conditions", "clean,snr10,snr5,snr0").split(",").map((s) => s.trim()).filter(Boolean);
const REPEAT = Math.max(1, Number(arg("--repeat", "1")));
const REAL_ONLY = flag("--real-only");
/** Hold-to-talk: the lab marks the start and end of each utterance itself, like a seller holding the talk button. */
const PTT = flag("--ptt");
const only = arg("--only") ? new Set(arg("--only").split(",")) : flag("--must-have") ? new Set(MUST_HAVE) : null;
const CACHE = "lab-cache";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A private (IAM-protected) Cloud Run lab service needs a Google identity token: LAB_ID_TOKEN=$(gcloud auth print-identity-token). */
// LAB_AUTH=gcloud fetches a fresh token (tokens last an hour) every 30 minutes from the signed-in gcloud.
let token = process.env.LAB_ID_TOKEN ?? null;
let tokenAt = Date.now();
const refreshToken = () => {
  if (process.env.LAB_AUTH !== "gcloud") return;
  if (token && Date.now() - tokenAt < 30 * 60_000) return;
  token = execFileSync(process.env.GCLOUD_BIN || "gcloud", ["auth", "print-identity-token"]).toString().trim();
  tokenAt = Date.now();
};
refreshToken();
const auth = () => { refreshToken(); return token ? { Authorization: `Bearer ${token}` } : {}; };

// ---- safety: never against the public demo
const host = new URL(BASE).hostname;
const local = ["127.0.0.1", "localhost", "::1"].includes(host);
if (!local && arg("--allow-host") !== host) {
  console.error(`Refusing to run against ${host}: every case resets the demo. Use a local server or a lab service and pass --allow-host ${host}.`);
  process.exit(1);
}
if (/shopbridge-122962889142|onrender\.com/.test(host)) { console.error("Refusing: that is the public demo."); process.exit(1); }

const env = {};
if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }

// ---------------------------------------------------------------- audio
const SR = 16000;
const rms = (pcm) => { let s = 0; const n = pcm.length / 2; for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / Math.max(n, 1)); };
/** RMS over 30 ms frames that contain speech (so pauses do not dilute the level used for SNR). */
function activeRms(pcm) {
  const frame = 480 * 2;
  const levels = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) levels.push(rms(pcm.subarray(i, i + frame)));
  const peak = Math.max(...levels, 1);
  const act = levels.filter((l) => l > peak * 0.1);
  return Math.sqrt(act.reduce((a, l) => a + l * l, 0) / Math.max(act.length, 1));
}
/** Byte offset just after the last voiced 30 ms frame (stricter than trim, so room tone does not count as speech). */
function voicedEnd(pcm) {
  const frame = 480 * 2;
  const levels = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) levels.push(rms(pcm.subarray(i, i + frame)));
  const peak = Math.max(...levels, 1);
  let last = levels.length - 1;
  while (last > 0 && levels[last] < Math.max(500, peak * 0.12)) last--;
  return Math.min(pcm.length, (last + 1) * frame);
}
function decode(file) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
}
/** Trim silence at both ends (keeps 150 ms), so "end of speech" is the real last spoken sample. */
function trim(pcm) {
  const frame = 480 * 2;
  const levels = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) levels.push(rms(pcm.subarray(i, i + frame)));
  const peak = Math.max(...levels, 1);
  const on = (l) => l > Math.max(250, peak * 0.06);
  const first = levels.findIndex(on);
  let last = levels.length - 1;
  while (last > 0 && !on(levels[last])) last--;
  if (first < 0) return pcm;
  return pcm.subarray(Math.max(0, (first - 5) * frame), Math.min(pcm.length, (last + 6) * frame));
}
function findFile(dir, stem) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => path.parse(f).name.toLowerCase() === stem.toLowerCase() && /\.(m4a|mp3|wav|ogg|opus|aac|webm|flac|amr|3gp)$/i.test(f));
  return hit ? path.join(dir, hit) : null;
}

async function synth(text) {
  mkdirSync(CACHE, { recursive: true });
  const key = Buffer.from(text).toString("base64url").slice(0, 80);
  const file = path.join(CACHE, `${key}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  if (!env.GEMINI_API_KEY) throw new Error("No recording and no GEMINI_API_KEY to synthesise speech.");
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TTS timeout")), 30000);
    ws.on("open", () => ws.send(JSON.stringify({ setup: { model: `models/${env.GEMINI_LIVE_MODEL || "gemini-3.8-live"}`, generationConfig: { responseModalities: ["AUDIO"] }, systemInstruction: { parts: [{ text: "You are a text-to-speech engine. Say exactly the user's text aloud, at a natural pace, in a natural Indian voice, nothing else." }] } } })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
      for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData) chunks.push(Buffer.from(p.inlineData.data, "base64"));
      if (m.serverContent?.turnComplete) { clearTimeout(t); ws.close(); resolve(); }
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
  const trimmed = trim(out);
  writeFileSync(file, trimmed);
  return trimmed;
}

/** The clip for a case: real recording if present, else synthesised (unless --real-only). */
async function clipFor(id, text, live = false) {
  const file = findFile(CLIPS, live ? `${id}_live-noisy` : id);
  if (file) return { pcm: trim(decode(file)), source: live ? "real-live-noisy" : "real" };
  if (live || REAL_ONLY) return null;
  return { pcm: await synth(text), source: "synthetic" };
}

// Noise beds: the real recordings (NOISE*.ext) if present, else a synthetic godown mix (labelled as such).
const noiseFiles = existsSync(CLIPS) ? readdirSync(CLIPS).filter((f) => /^noise/i.test(f)).map((f) => path.join(CLIPS, f)) : [];
const noiseBeds = noiseFiles.map((f) => ({ name: path.parse(f).name, pcm: decode(f) }));
function syntheticNoise(samples, seed) {
  const out = Buffer.alloc(samples * 2);
  let x = seed >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  let brown = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / SR;
    brown = Math.max(-1, Math.min(1, brown + rnd() * 0.05));
    const hum = Math.sin(2 * Math.PI * 100 * t) * 0.3;
    const clank = Math.sin(2 * Math.PI * 1800 * t) * Math.max(0, Math.sin(2 * Math.PI * 0.7 * t)) ** 12 * 0.8;
    out.writeInt16LE(Math.round((rnd() * 0.5 + brown + hum + clank) * 6000), i * 2);
  }
  return out;
}
function noiseSegment(samples, k) {
  if (!noiseBeds.length) return { pcm: syntheticNoise(samples, 1000 + k), name: "synthetic godown mix" };
  const bed = noiseBeds[k % noiseBeds.length];
  const n = bed.pcm.length / 2;
  const out = Buffer.alloc(samples * 2);
  const start = Math.floor(((k * 7919) % Math.max(n - samples, 1)));
  for (let i = 0; i < samples; i++) out.writeInt16LE(bed.pcm.readInt16LE(((start + i) % n) * 2), i * 2);
  return { pcm: out, name: bed.name };
}
/** Speech + tail of the same noise, mixed at `snr` dB against the speech's active level. */
function withNoise(speech, snr, tailSamples, k) {
  const n = speech.length / 2 + tailSamples;
  const { pcm: noise, name } = noiseSegment(n, k);
  const gain = activeRms(speech) / 10 ** (snr / 20) / Math.max(rms(noise), 1);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = i < speech.length / 2 ? speech.readInt16LE(i * 2) : 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s + noise.readInt16LE(i * 2) * gain))), i * 2);
  }
  return { speech: out.subarray(0, speech.length), tail: out.subarray(speech.length), noise: name };
}

// ---------------------------------------------------------------- session
class Session {
  constructor(cookie) {
    this.events = []; this.frames = []; this.sent = 0; this.recvBytes = 0;
    this.ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/voiceops/live" + (PTT ? "?mode=ptt" : ""), { headers: { cookie, origin: BASE, ...auth() } });
    this.ws.on("message", (d, bin) => {
      if (bin) { this.frames.push(Date.now()); this.recvBytes += d.length; return; }
      const e = JSON.parse(d.toString()); e.at = Date.now(); this.events.push(e);
    });
  }
  async ready() { for (let i = 0; i < 300; i++) { const e = this.events.find((x) => x.type === "ready" || x.type === "error"); if (e) return e; await sleep(50); } return null; }
  /** Stream at real-time pace; returns when the chunk holding byte `mark` was sent (or the end). */
  async stream(pcm, mark = pcm.length) {
    let markedAt = null;
    for (let i = 0; i < pcm.length; i += 3200) {
      if (this.ws.readyState !== WebSocket.OPEN) break;
      this.ws.send(pcm.subarray(i, Math.min(i + 3200, pcm.length)), { binary: true });
      this.sent += Math.min(3200, pcm.length - i);
      if (markedAt === null && i + 3200 >= mark) markedAt = Date.now() - Math.round(((i + 3200 - mark) / 3200) * 100);
      await sleep(100);
    }
    return markedAt ?? Date.now();
  }
  async settle(quiet = 4000, max = 45000) {
    const end = Date.now() + max;
    while (Date.now() < end) { const last = Math.max(this.frames.at(-1) ?? 0, this.events.at(-1)?.at ?? 0); if (Date.now() - last > quiet) return; await sleep(200); }
  }
  async waitFrameAfter(t, max = 20000) { const end = Date.now() + max; while (Date.now() < end) { if (this.frames.some((f) => f >= t)) return true; await sleep(30); } return false; }
  async close() { try { this.ws.send(JSON.stringify({ type: "end" })); } catch {} await sleep(300); try { this.ws.close(); } catch {} }
}

/** Speak a clip (optionally noisy) then a tail of silence/noise like an open mic. Returns the speech-end time. */
async function speak(s, clip, cond, k) {
  const tailSamples = Math.floor(2.5 * SR);
  let speech = clip.pcm, tail = Buffer.alloc(tailSamples * 2), noise = null;
  const snr = cond.startsWith("snr") ? Number(cond.slice(3)) : null;
  if (snr !== null) ({ speech, tail, noise } = withNoise(clip.pcm, snr, tailSamples, k));
  const start = Date.now();
  if (PTT) s.ws.send(JSON.stringify({ type: "activity_start" }));
  // "end" = when the seller's last voiced sound left the client (measured on the clean clip).
  const end = await s.stream(speech, voicedEnd(clip.pcm));
  if (PTT) s.ws.send(JSON.stringify({ type: "activity_end" }));
  await s.stream(tail);
  return { start, end, noise };
}

/**
 * Reply latency: the first agent audio that starts after the seller stopped (after a gap of 250 ms+ with no
 * audio), so audio the agent was already playing does not count. Audio during the clip = talked over the seller.
 */
function replyLatency(frames, start, end) {
  const talkedOver = frames.some((f) => f > start + 300 && f < end);
  let prev = frames.filter((f) => f < end).at(-1) ?? 0;
  for (const f of frames.filter((x) => x >= end)) {
    if (f - prev > 250) return { latency: f - end, talkedOver };
    prev = f;
  }
  return { latency: null, talkedOver };
}

function collect(s, from, speechEnd, speechStart) {
  const ev = s.events.slice(from);
  const calls = [];
  for (const e of ev) {
    if (e.type === "tool_started") calls.push({ name: e.name, args: e.args ?? {}, status: null, readback: null });
    if (e.type === "tool_result") {
      const c = [...calls].reverse().find((x) => x.name === e.name && x.status === null);
      if (c) { c.status = e.result?.status; c.code = e.result?.code ?? null; c.readback = e.result?.approval?.readback ?? null; }
    }
  }
  const { latency, talkedOver } = replyLatency(s.frames, speechStart, speechEnd);
  const heard = ev.filter((e) => e.type === "transcript" && e.role === "user").map((e) => e.text).at(-1) ?? "";
  const said = ev.filter((e) => e.type === "transcript" && e.role === "agent").map((e) => e.text).at(-1) ?? "";
  return {
    calls,
    approvals: ev.filter((e) => e.type === "approval_required").map((e) => ({ tool: e.tool, readback: e.approval?.readback ?? "", tier: e.approval?.tier ?? "standard" })),
    resolved: ev.filter((e) => e.type === "approval_resolved"),
    interrupted: ev.some((e) => e.type === "interrupted"),
    transcript: heard, reply: said,
    latency_ms: latency,
    talked_over: talkedOver,
    server_latency_ms: ev.filter((e) => e.type === "latency").map((e) => e.ms),
  };
}

// ---------------------------------------------------------------- run
const login = await fetch(`${BASE}/api/demo`, { method: "POST", headers: { "Content-Type": "application/json", ...auth() }, body: JSON.stringify({ account: "seller" }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (!login.ok || !cookie) { console.error(`Sign-in failed (${login.status}).`); process.exit(1); }
const post = (p) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", cookie, origin: BASE, ...auth() }, body: "{}" });
const byId = new Map(CASES.map((c) => [c.id, c]));

const results = [];
let k = 0;
for (const cond of CONDITIONS) {
  for (const c of CASES) {
    if (only && !only.has(c.id)) continue;
    if (cond === "live" && !LIVE_NOISY.includes(c.clip ?? c.id)) continue;
    for (let rep = 0; rep < REPEAT; rep++) {
      k++;
      const main = await clipFor(c.clip ?? c.id, c.text, cond === "live");
      const pre = c.after ? await clipFor(byId.get(c.after).clip ?? c.after, byId.get(c.after).text) : null;
      if (!main || (c.after && !pre)) { results.push({ id: c.id, cond, rep, skipped: "no recording" }); continue; }
      const reset = await post("/api/voiceops/demo/reset");
      if (!reset.ok) { console.error(`Demo reset failed (${reset.status}); is VOICEOPS demo enabled?`); process.exit(1); }
      const s = new Session(cookie);
      const r0 = { id: c.id, cond, rep, source: main.source, lang: c.lang, tags: c.tags ?? [] };
      try {
        const ready = await s.ready();
        if (ready?.type !== "ready") throw new Error(ready?.message ?? "session did not open");
        r0.model = ready.model;
        if (pre) {
          const preCond = cond === "live" ? "clean" : cond;
          const { end } = await speak(s, pre, preCond, k + 5000);
          if (c.barge) {
            await s.waitFrameAfter(end, 20000);
            await sleep(600);
          } else {
            await s.settle(3500, 40000);
          }
        }
        const from = s.events.length;
        const { start, end, noise } = await speak(s, main, cond === "live" ? "clean" : cond, k);
        await s.settle(4000, 45000);
        const r = collect(s, from, end, start);
        const verdict = c.check(r);
        // A failure is "safe" when the agent proposed and executed nothing (it asked, refused or looked something up).
        // Failures: "wrong_execution" changed data, "wrong_proposal" only raised an approval (nothing changed), "safe_fail" did neither.
        const executedAny = r.resolved.some((x) => x.result?.status === "succeeded" && x.name === "confirm_action");
        const proposedAny = r.approvals.length > 0;
        Object.assign(r0, r, { noise, ptt: PTT, pass: verdict.pass, outcome: verdict.pass ? "pass" : executedAny ? "wrong_execution" : proposedAny ? "wrong_proposal" : "safe_fail", expect: verdict.why });
      } catch (error) {
        Object.assign(r0, { pass: false, error: error instanceof Error ? error.message : String(error) });
      }
      r0.audio_in_s = Math.round((s.sent / 2 / SR) * 10) / 10;
      r0.audio_out_s = Math.round((s.recvBytes / 2 / 24000) * 10) / 10;
      await s.close();
      results.push(r0);
      console.log(`${r0.pass ? "PASS" : r0.skipped ? "SKIP" : "FAIL"} ${cond.padEnd(6)} ${c.id.padEnd(22)} ${String(r0.latency_ms ?? "-").padStart(5)} ms  heard: ${(r0.transcript ?? "").slice(0, 70)}${r0.error ? `  ERROR ${r0.error}` : ""}`);
    }
  }
}

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const meta = { base: BASE, at: new Date().toISOString(), mode: PTT ? "hold-to-talk" : "automatic turn detection", conditions: CONDITIONS, repeat: REPEAT, noise: noiseBeds.length ? noiseBeds.map((b) => b.name) : ["synthetic godown mix"], clips_dir: CLIPS };
const file = path.join(OUT, `run-${stamp}.json`);
writeFileSync(file, JSON.stringify({ meta, results }, null, 2));
console.log(`\nSaved ${file}. Build the report with: node scripts/lab/report.mjs ${file}`);
