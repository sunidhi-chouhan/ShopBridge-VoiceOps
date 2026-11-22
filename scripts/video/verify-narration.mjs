// Transcribe each narration WAV with Gemini and compare it with the script text (word overlap).
// Usage: node scripts/video/verify-narration.mjs   -> prints score per scene; < 0.85 means regenerate.
import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, ...Array.from({ length: 8 }, (_, i) => env[`GEMINI_API_KEY_BACKUP_${i + 2}`])].filter(Boolean);
const models = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-flash-latest"];
const cfg = JSON.parse(readFileSync("scripts/video/narration.json", "utf8"));
const NUM = { "1042": "ten forty two", "1050": "ten fifty", "1052": "ten fifty two", "1053": "ten fifty three", "1054": "ten fifty four", "7": "seven", "10": "ten" };
const words = (s) => s.toLowerCase().replace(/\b\d+\b/g, (n) => NUM[n] ?? n).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
async function transcribe(file) {
  const data = readFileSync(file).toString("base64");
  for (let round = 0; round < 3; round++) for (const m of models) for (const k of keys) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k }, body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data } }, { text: "Transcribe this audio exactly, in the language spoken. Output only the words." }] }] }) }).catch(() => null);
    if (!r?.ok) continue;
    const j = await r.json();
    const t = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (t) return t;
  }
  return "";
}
let bad = 0;
const only = process.argv.slice(2);
for (const s of cfg.scenes) {
  if (only.length && !only.includes(s.id)) continue;
  const heard = await transcribe(`video-build/narration/${s.id}.wav`);
  const want = words(s.text), got = new Set(words(heard));
  const score = want.filter((w) => got.has(w)).length / want.length;
  if (score < 0.85) bad++;
  console.log(`${score >= 0.85 ? "OK " : "BAD"} ${score.toFixed(2)} ${s.id}${score < 0.85 ? `  heard: ${heard.slice(0, 120)}` : ""}`);
}
process.exit(bad ? 1 : 0);
