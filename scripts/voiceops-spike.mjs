// Spike: list Live-capable models for GEMINI_API_KEY, then open a Live session and time first audio.
// Usage: node scripts/voiceops-spike.mjs [model]   (reads GEMINI_API_KEY from .env or env)
import { readFileSync } from "node:fs";
import WebSocket from "ws";
try { for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^(GEMINI_API_KEY)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("GEMINI_API_KEY missing"); process.exit(1); }
const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=300", { headers: { "x-goog-api-key": key } });
const j = await r.json();
if (j.error) { console.error("Key rejected:", j.error.message); process.exit(1); }
const live = j.models.filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent")).map((m) => m.name);
console.log("Live models:\n" + live.join("\n"));
const model = process.argv[2] ?? live.find((n) => /native-audio/.test(n)) ?? live[0];
if (!model) process.exit(1);
console.log("\nTesting", model);
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`);
let t0 = 0, bytes = 0;
ws.on("open", () => ws.send(JSON.stringify({ setup: { model, generationConfig: { responseModalities: ["AUDIO"] }, outputAudioTranscription: {}, inputAudioTranscription: {} } })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.setupComplete) { t0 = Date.now(); ws.send(JSON.stringify({ realtimeInput: { text: "Namaste! Ek line mein Hinglish mein bolo: aap kaise ho?" } })); }
  const parts = m.serverContent?.modelTurn?.parts ?? [];
  for (const p of parts) if (p.inlineData) { if (!bytes) console.log("first audio ms:", Date.now() - t0, p.inlineData.mimeType); bytes += p.inlineData.data.length; }
  if (m.serverContent?.outputTranscription) process.stdout.write(m.serverContent.outputTranscription.text);
  if (m.serverContent?.turnComplete) { console.log("\nturnComplete, audio b64 chars:", bytes); ws.close(); }
});
ws.on("close", (c, r) => { console.log("closed", c, r.toString()); process.exit(0); });
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
