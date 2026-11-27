// Build a Markdown report from one or more lab runs.
//   node scripts/lab/report.mjs docs/voiceops/lab/run-*.json [--out docs/voiceops/VALIDATION.md]
//     [--infra-usd-month 18] [--sellers 50]     infrastructure from your Google Cloud bill, shared by N sellers
// Audio price per minute: GEMINI_COST_IN_PER_MIN / GEMINI_COST_OUT_PER_MIN, defaults as in the app
// (Gemini 3.8 Live list price, checked 2026-11-13). Everything else in the report is measured.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const files = args.filter((a, i) => a.endsWith(".json") && !["--out", "--infra-usd-month", "--sellers"].includes(args[i - 1]));
if (!files.length) { console.error("Give one or more run-*.json files."); process.exit(1); }
const out = opt("--out") ?? "docs/voiceops/VALIDATION.md";
const infra = opt("--infra-usd-month") ? Number(opt("--infra-usd-month")) : null;
const sellers = opt("--sellers") ? Number(opt("--sellers")) : null;
const RATE_IN = Number(process.env.GEMINI_COST_IN_PER_MIN ?? 0.005);
const RATE_OUT = Number(process.env.GEMINI_COST_OUT_PER_MIN ?? 0.018);
const USD_INR = Number(process.env.USD_INR ?? 84);

const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const rows = runs.flatMap((r) => r.results).filter((r) => !r.skipped);
const skipped = runs.flatMap((r) => r.results).filter((r) => r.skipped);

const pct = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const ms = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)} ms`);
const rate = (xs) => (xs.length ? `${xs.filter((r) => r.pass).length}/${xs.length} (${Math.round((100 * xs.filter((r) => r.pass).length) / xs.length)}%)` : "–");
const group = (key) => { const m = new Map(); for (const r of rows) { for (const k of [].concat(key(r))) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } } return m; };
const COND = { clean: "Clean", snr10: "Noise 10 dB SNR", snr5: "Noise 5 dB SNR", snr0: "Noise 0 dB SNR", live: "Recorded in real noise" };
const sources = group((r) => r.source);

const lines = [];
lines.push("# Validation lab results", "");
lines.push(`Mode: ${[...new Set(runs.map((r) => r.meta.mode ?? "automatic turn detection"))].join(", ")}.`, "");
lines.push(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from ${files.length} run(s) against ${[...new Set(runs.map((r) => r.meta.base))].join(", ")}.`, "");
lines.push(`Speech: ${[...sources].map(([k, v]) => `${v.length} ${k}`).join(", ")}${skipped.length ? `; ${skipped.length} skipped (no recording)` : ""}. Noise beds: ${[...new Set(runs.flatMap((r) => r.meta.noise))].join(", ")}.`, "");
lines.push("Latency = last speech sample sent → first agent audio received by the client. It includes end-of-speech detection, Gemini, tool calls and the network, measured from the machine running the lab.", "");

lines.push("## By condition", "", "| Condition | Pass | p50 latency | p95 latency | Turns |", "|---|---|---|---|---|");
for (const [k, v] of group((r) => r.cond)) {
  const lat = v.map((r) => r.latency_ms).filter((x) => x !== null && x !== undefined);
  lines.push(`| ${COND[k] ?? k} | ${rate(v)} | ${ms(pct(lat, 50))} | ${ms(pct(lat, 95))} | ${lat.length} |`);
}
const allLat = rows.map((r) => r.latency_ms).filter((x) => x !== null && x !== undefined);
lines.push(`| **All** | **${rate(rows)}** | **${ms(pct(allLat, 50))}** | **${ms(pct(allLat, 95))}** | ${allLat.length} |`, "");
const sub = allLat.filter((x) => x < 1000).length;
const executedWrong = rows.filter((r) => r.outcome === "wrong_execution");
const proposedWrong = rows.filter((r) => r.outcome === "wrong_proposal" || r.outcome === "wrong_action");
const safeFails = rows.filter((r) => r.outcome === "safe_fail");
const talked = rows.filter((r) => r.talked_over);
lines.push(`**Wrong changes executed: ${executedWrong.length} of ${rows.length}.** Wrong proposals stopped at the approval step: ${proposedWrong.length}. Safe failures (asked to repeat, looked something up, proposed nothing): ${safeFails.length}.`, "");
lines.push(`Agent started talking before the seller finished: ${talked.length} of ${rows.length} turns${talked.length ? ` (${[...new Set(talked.map((r) => COND[r.cond] ?? r.cond))].join(", ")})` : ""}.`, "");
lines.push(`${sub} of ${allLat.length} turns (${allLat.length ? Math.round((100 * sub) / allLat.length) : 0}%) answered in under one second.`, "");

lines.push("## By capability", "", "| Capability | Pass |", "|---|---|");
for (const [k, v] of group((r) => (r.tags?.length ? r.tags : ["workflow"]))) lines.push(`| ${k} | ${rate(v)} |`);
const barge = rows.filter((r) => (r.tags ?? []).includes("interruption"));
if (barge.length) lines.push("", `Barge-in: the agent's audio was cut off (Gemini "interrupted" event) in ${barge.filter((r) => r.interrupted).length} of ${barge.length} interruption runs; in the rest it had already finished speaking.`);
lines.push("", "## By language", "", "| Language | Pass | p50 latency |", "|---|---|---|");
for (const [k, v] of group((r) => r.lang)) lines.push(`| ${k} | ${rate(v)} | ${ms(pct(v.map((r) => r.latency_ms), 50))} |`);

// ---- unit economics (audio minutes measured per case)
const inMin = rows.reduce((a, r) => a + (r.audio_in_s ?? 0), 0) / 60;
const outMin = rows.reduce((a, r) => a + (r.audio_out_s ?? 0), 0) / 60;
const perCase = rows.length ? (inMin * RATE_IN + outMin * RATE_OUT) / rows.length : 0;
lines.push("", "## Unit economics", "");
lines.push(`Measured audio per voice request: ${(inMin * 60 / Math.max(rows.length, 1)).toFixed(1)} s in, ${(outMin * 60 / Math.max(rows.length, 1)).toFixed(1)} s out (includes the trailing open-mic second and any set-up sentence).`, "");
lines.push(`At $${RATE_IN}/min in and $${RATE_OUT}/min out (Gemini Live list price; override with GEMINI_COST_IN_PER_MIN / _OUT_PER_MIN): **$${perCase.toFixed(4)} (₹${(perCase * USD_INR).toFixed(2)}) per voice request.**`, "");
lines.push("| Requests per day | Gemini audio per seller per month |" + (infra !== null && sellers ? " Plus infrastructure share | Total per seller per month |" : ""), "|---|---|" + (infra !== null && sellers ? "---|---|" : ""));
for (const perDay of [10, 30, 60]) {
  const ai = perCase * perDay * 30;
  const share = infra !== null && sellers ? infra / sellers : null;
  lines.push(`| ${perDay} | $${ai.toFixed(2)} (₹${Math.round(ai * USD_INR)}) |` + (share !== null ? ` $${share.toFixed(2)} | $${(ai + share).toFixed(2)} (₹${Math.round((ai + share) * USD_INR)}) |` : ""));
}
lines.push("", infra !== null && sellers ? `Infrastructure: $${infra}/month from the Google Cloud bill, shared by ${sellers} sellers.` : "Infrastructure is not included: pass --infra-usd-month (from the Google Cloud bill) and --sellers to add it.", "");
lines.push(`Text calls (forecast insights, triage, digests) are not in these numbers; they are billed per token and are a small fraction of audio. USD→INR at ${USD_INR}.`, "");

lines.push("## Every case", "", "| Case | Condition | Source | Result | Latency | What the server heard | Expected |", "|---|---|---|---|---|---|---|");
for (const r of rows) {
  lines.push(`| ${r.id} | ${COND[r.cond] ?? r.cond} | ${r.source} | ${r.pass ? "PASS" : "**FAIL**"} | ${ms(r.latency_ms)} | ${(r.transcript ?? "").replace(/\|/g, "/").slice(0, 80)} | ${r.expect ?? r.error ?? ""} |`);
}
const fails = rows.filter((r) => !r.pass);
if (fails.length) {
  lines.push("", "## Failures in detail", "");
  for (const r of fails) {
    lines.push(`- **${r.id} (${COND[r.cond] ?? r.cond})** [${r.outcome === "wrong_execution" ? "WRONG CHANGE EXECUTED" : r.outcome === "wrong_proposal" || r.outcome === "wrong_action" ? "wrong proposal, not executed" : r.outcome === "safe_fail" ? "safe" : "error"}]${r.talked_over ? " [talked over the seller]" : ""}: expected ${r.expect ?? "-"}. Tools: ${(r.calls ?? []).map((c) => `${c.name}(${JSON.stringify(c.args)}) → ${c.status}${c.code ? ` ${c.code}` : ""}`).join("; ") || "none"}. Agent said: "${(r.reply ?? "").slice(0, 160)}"${r.error ? ` Error: ${r.error}` : ""}`);
  }
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Wrote ${out}: ${rate(rows)} passed, p50 ${ms(pct(allLat, 50))}, p95 ${ms(pct(allLat, 95))}.`);
