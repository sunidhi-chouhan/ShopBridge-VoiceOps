/**
 * Pre-demo health check: is the database up, are Gemini keys valid, is the Live model available,
 * is Nexconn configured. Never returns key values, only which slot passed.
 */
import { checkDatabaseReady } from "../db/pool";
import { nexconnConfigured } from "../nexconn";
import { geminiAttempts } from "./live";

export type PreflightCheck = { name: string; ok: boolean; detail: string };

async function keyCheck(key: string, models: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=300", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) return { ok: false, detail: "rate limited or quota exhausted (429)" };
    if (!res.ok) return { ok: false, detail: `rejected by Google (HTTP ${res.status})` };
    const json = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    const live = new Set((json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent")).map((m) => m.name.replace(/^models\//, "")));
    const missing = models.filter((m) => !live.has(m));
    return missing.length === models.length
      ? { ok: false, detail: `key works but none of ${models.join(", ")} is available for Live` }
      : { ok: true, detail: `key valid; Live models available: ${models.filter((m) => live.has(m)).join(", ")}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error && error.name === "TimeoutError" ? "timed out reaching Google" : "could not reach Google" };
  }
}

export async function runPreflight(): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const checks: PreflightCheck[] = [];
  const db = await checkDatabaseReady().catch(() => ({ ready: false }));
  checks.push({ name: "Database", ok: db.ready, detail: db.ready ? "connected" : "not reachable" });

  const attempts = geminiAttempts();
  const models = [...new Set(attempts.map((a) => a.model))];
  const slots = [...new Set(attempts.map((a) => a.keyIndex))];
  if (!slots.length) checks.push({ name: "Gemini key", ok: false, detail: "GEMINI_API_KEY is not set" });
  for (const slot of slots) {
    const key = attempts.find((a) => a.keyIndex === slot)!.key;
    const r = await keyCheck(key, models);
    checks.push({ name: slot === 0 ? "Gemini primary key" : "Gemini backup key", ok: r.ok, detail: r.detail });
  }
  if (slots.length === 1) checks.push({ name: "Gemini backup key", ok: false, detail: "not configured (GEMINI_API_KEY_BACKUP); a quota or key failure would end voice" });
  checks.push({ name: "Nexconn chat", ok: nexconnConfigured(), detail: nexconnConfigured() ? "configured" : "not configured; customer messages are recorded but not delivered" });
  const required = checks.filter((c) => c.name !== "Gemini backup key" && c.name !== "Nexconn chat");
  return { ok: required.every((c) => c.ok), checks };
}
