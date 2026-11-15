// Real end-to-end smoke test of the relay against Gemini Live.
// Usage: BASE=http://127.0.0.1:8791 node scripts/voiceops-live-smoke.mjs "text to say" [--audio]
// --audio: synthesize the sentence with Gemini Live itself, resample 24k->16k and stream it as "mic" audio.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const say = process.argv[2] || "Aaj ke pending orders aur low stock check karo.";
const audioMode = process.argv.includes("--audio");
let env = {};
try { for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); } } catch {}

async function synth(text) {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`);
  const chunks = [];
  await new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ setup: { model: `models/${env.GEMINI_LIVE_MODEL || "gemini-3.8-live"}`, generationConfig: { responseModalities: ["AUDIO"] }, systemInstruction: { parts: [{ text: "You are a text-to-speech engine. Say exactly the user's text aloud in a natural Indian voice, nothing else." }] } } })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
      for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData) chunks.push(Buffer.from(p.inlineData.data, "base64"));
      if (m.serverContent?.turnComplete) { ws.close(); resolve(); }
    });
    ws.on("error", reject);
  });
  const pcm24 = Buffer.concat(chunks);
  const n24 = pcm24.length / 2, n16 = Math.floor((n24 * 2) / 3);
  const out = Buffer.alloc(n16 * 2);
  for (let i = 0; i < n16; i++) {
    const pos = (i * 3) / 2, i0 = Math.floor(pos), f = pos - i0;
    const a = pcm24.readInt16LE(i0 * 2), b = pcm24.readInt16LE(Math.min(i0 + 1, n24 - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

const login = await fetch(`${BASE}/api/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "seller" }) });
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) { console.error("login failed", await login.text()); process.exit(1); }
const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/voiceops/live", { headers: { cookie } });
const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(5)}ms]`;
let audioBytes = 0, idleTimer;
const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { console.log(stamp(), "idle, closing; audio bytes from agent:", audioBytes); ws.send(JSON.stringify({ type: "end" })); }, 9000); };
ws.on("message", async (d, bin) => {
  bump();
  if (bin) { audioBytes += d.length; return; }
  const e = JSON.parse(d.toString());
  if (e.type === "transcript" && !e.final && !process.env.VERBOSE) return;
  console.log(stamp(), e.type, e.name ?? "", e.type === "tool_result" ? `${e.result.status} ${e.result.latencyMs}ms ${e.result.message}` : e.text ?? e.ms ?? e.message ?? e.approval?.readback ?? "");
  if (e.type === "ready") {
    if (audioMode) {
      clearTimeout(idleTimer);
      const pcm = await synth(say);
      console.log(stamp(), "synthesized", (pcm.length / 32000).toFixed(1), "s of speech; streaming as mic");
      for (let i = 0; i < pcm.length; i += 3200) { ws.send(pcm.subarray(i, i + 3200), { binary: true }); await new Promise((r) => setTimeout(r, 100)); }
      bump();
      for (let i = 0; i < 20; i++) { ws.send(Buffer.alloc(3200), { binary: true }); await new Promise((r) => setTimeout(r, 100)); } // paced silence so VAD closes the turn
    } else ws.send(JSON.stringify({ type: "text", text: say }));
  }
});
ws.on("close", () => { console.log(stamp(), "socket closed"); process.exit(0); });
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });

