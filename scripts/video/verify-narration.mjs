// Transcribe each narration WAV with Gemini and compare it with the script text (word overlap).
// Usage: node scripts/video/verify-narration.mjs   -> prints score per scene; < 0.85 means regenerate.
import { readFileSync } from "node:fs";
const env = {};
for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, ...Array.from({ length: 8 }, (_, i) => env[`GEMINI_API_KEY_BACKUP_${i + 2}`])].filter(Boolean);
const models = ["gemini-3.5-transcribe", "gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.6-flash", "gemini-flash-latest"];
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
let unchecked = 0;
const only = process.argv.slice(2);
for (const s of cfg.scenes) {
  if (only.length && !only.includes(s.id)) continue;
  const heard = await transcribe(`video-build/narration/${s.id}.wav`);
  if (!heard) { unchecked++; console.log(`ERR could not transcribe ${s.id} (Gemini quota or outage); not regenerating`); continue; }
  // Recall: script words present. Precision: no extra words (e.g. an instruction read aloud).
  const want = words(s.text), heardWords = words(heard), got = new Set(heardWords), script = new Set(want);
  const recall = want.filter((w) => got.has(w)).length / want.length;
  const precision = heardWords.length ? heardWords.filter((w) => script.has(w)).length / heardWords.length : 0;
  const ok = recall >= 0.85 && precision >= 0.85;
  if (!ok) bad++;
  console.log(`${ok ? "OK " : "BAD"} recall ${recall.toFixed(2)} precision ${precision.toFixed(2)} ${s.id}${ok ? "" : `  heard: ${heard.slice(0, 160)}`}`);
}
process.exit(unchecked ? 2 : bad ? 1 : 0);
