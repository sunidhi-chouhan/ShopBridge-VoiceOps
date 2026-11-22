// Generate the demo-video narration with Gemini text-to-speech.
// Usage: node scripts/video/tts.mjs [--force] [sceneId ...]
// Reads Gemini keys from .env (GEMINI_API_KEY, _BACKUP, _BACKUP_2..9); writes video-build/narration/<id>.wav (24 kHz mono).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, ...Array.from({ length: 8 }, (_, i) => env[`GEMINI_API_KEY_BACKUP_${i + 2}`])].filter(Boolean);
if (!keys.length) { console.error("No Gemini key in .env"); process.exit(1); }
const MODELS = (process.env.TTS_MODELS || "gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts").split(",");

const cfg = JSON.parse(readFileSync("scripts/video/narration.json", "utf8"));
const force = process.argv.includes("--force");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
mkdirSync("video-build/narration", { recursive: true });

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function speak(text) {
  let last = "";
  for (const model of MODELS) {
    for (const key of keys) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${cfg.style}${text}` }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } } },
        }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (!res.ok) { last = `${model} HTTP ${res.status}`; continue; }
      const json = await res.json();
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) { last = `${model}: no audio`; continue; }
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
      return { pcm: Buffer.from(part.inlineData.data, "base64"), rate, model };
    }
  }
  throw new Error(`TTS failed: ${last}`);
}

for (const scene of cfg.scenes) {
  if (only.length && !only.includes(scene.id)) continue;
  const out = `video-build/narration/${scene.id}.wav`;
  if (existsSync(out) && !force) { console.log("skip", scene.id); continue; }
  const { pcm, rate, model } = await speak(scene.text);
  writeFileSync(out, wav(pcm, rate));
  console.log(`${scene.id}: ${(pcm.length / 2 / rate).toFixed(1)} s (${model})`);
}
