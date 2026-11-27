/**
 * Pre-demo health check: is the database up, are Gemini keys valid, is the Live model available,
 * is Nexconn configured. Never returns key values, only which slot passed.
 */
import { checkDatabaseReady } from "../db/pool";
import { nexconnConfigured } from "../nexconn";
import { configuredKeys, keyHealth, slotName } from "../gemini-keys";
import { geminiAttempts } from "./live";
import { vertexAccessToken, vertexConfigured, vertexLocation, vertexProject } from "../vertex";

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

  if (vertexConfigured()) {
    const token = await vertexAccessToken().catch(() => null);
    checks.push({
      name: "Vertex AI",
      ok: Boolean(token),
      detail: token ? `project ${vertexProject()}, region ${vertexLocation()}; voice and text go here first` : "no Google credentials found; falling back to API keys",
    });
  }
  const attempts = geminiAttempts();
  const models = [...new Set(attempts.map((a) => a.model))];
  const keys = configuredKeys();
  if (!keys.length && !vertexConfigured()) checks.push({ name: "Gemini key", ok: false, detail: "GEMINI_API_KEY is not set" });
  const health = new Map(keyHealth().map((h) => [h.slot, h]));
  const results = await Promise.all(keys.map(async ({ key, slot }) => ({ slot, ...(await keyCheck(key, models)) })));
  for (const r of results) {
    const resting = health.get(r.slot);
    const note = resting?.coolingDownSeconds ? ` · resting ${resting.coolingDownSeconds}s after a ${resting.reason} failure` : "";
    checks.push({ name: `Gemini ${slotName(r.slot)}`, ok: r.ok, detail: `${r.detail}${note}` });
  }
  const working = results.filter((r) => r.ok).length;
  if (keys.length) {
    checks.push({
      name: "Gemini key rotation",
      ok: working > 0,
      detail: `${working} of ${keys.length} key${keys.length > 1 ? "s" : ""} working; every call rotates through all of them and fails over to the next${keys.length === 1 ? ". Add GEMINI_API_KEY_BACKUP (and _2, _3…) so one bad key cannot stop voice" : ""}.`,
    });
  }
  checks.push({ name: "Chat service", ok: nexconnConfigured(), detail: nexconnConfigured() ? "configured" : "not configured; customer messages are recorded but not delivered" });
  // Ready when the database is up and Vertex or at least one Gemini key works.
  const dbOk = checks.find((c) => c.name === "Database")?.ok ?? false;
  const ai = checks.filter((c) => c.name === "Vertex AI" || c.name === "Gemini key rotation");
  const aiOk = ai.some((c) => c.ok) && !checks.some((c) => c.name === "Gemini key" && !c.ok);
  return { ok: dbOk && aiOk, checks };
}
