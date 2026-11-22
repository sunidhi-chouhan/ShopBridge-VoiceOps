/**
 * Gemini API key pool: every Gemini call (voice and text) gets its keys from here.
 *
 * Keys, in slot order:
 *   GEMINI_API_KEY, GEMINI_API_KEY_BACKUP, GEMINI_API_KEY_BACKUP_2 … GEMINI_API_KEY_BACKUP_9,
 *   then any extra comma-separated keys in GEMINI_API_KEYS. Duplicates are ignored.
 *
 * Rotation: each call starts at the next key in turn (round robin), so load and quota are spread
 * across all keys. Failover: if a key fails, the call moves on to the next key until every key has
 * been tried. Cooldown: a failing key is moved to the back of the line for a while, so the next
 * calls do not waste time on it; a success clears it straight away.
 *
 * Key values never leave the server and are never logged; logs and the preflight use "key #n".
 */

export type KeyFailure = "invalid" | "quota" | "error";

/** How long a failing key waits at the back of the line. */
export const COOLDOWN_MS: Record<KeyFailure, number> = {
  invalid: 10 * 60_000, // rejected by Google (bad, revoked or restricted key)
  quota: 2 * 60_000, // 429 / quota or rate limit
  error: 30_000, // timeouts, network errors, 5xx
};

const MAX_BACKUP_SLOTS = 9;

/** All configured keys with their 1-based slot number (used in logs instead of the key). */
export function configuredKeys(env: NodeJS.ProcessEnv = process.env): Array<{ key: string; slot: number }> {
  const raw = [
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_BACKUP,
    ...Array.from({ length: MAX_BACKUP_SLOTS - 1 }, (_, i) => env[`GEMINI_API_KEY_BACKUP_${i + 2}`]),
    ...(env.GEMINI_API_KEYS ?? "").split(","),
  ];
  const seen = new Set<string>();
  const out: Array<{ key: string; slot: number }> = [];
  for (const value of raw) {
    const key = value?.trim().replace(/^["']|["']$/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, slot: out.length + 1 });
  }
  return out;
}

export function hasGeminiKey(): boolean {
  return configuredKeys().length > 0;
}

export const slotName = (slot: number) => (slot === 1 ? "primary key" : slot === 2 ? "backup key" : `backup key ${slot - 1}`);

let cursor = 0;
const cooldownUntil = new Map<string, { until: number; reason: KeyFailure }>();

/**
 * Keys in the order one call should try them: healthy keys first, starting at the next key in the
 * rotation; keys still cooling down last (the one that recovers soonest first). Every key is always
 * included, so a call never gives up while an untried key remains.
 */
export function keyRotation(now = Date.now()): Array<{ key: string; slot: number }> {
  const keys = configuredKeys();
  if (!keys.length) return [];
  const start = cursor++ % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const cooling = (k: { key: string }) => {
    const c = cooldownUntil.get(k.key);
    return c && c.until > now ? c.until : 0;
  };
  const healthy = rotated.filter((k) => !cooling(k));
  const resting = rotated.filter((k) => cooling(k)).sort((a, b) => cooling(a) - cooling(b));
  return [...healthy, ...resting];
}

export function markKeyFailed(key: string, reason: KeyFailure, now = Date.now()): void {
  cooldownUntil.set(key, { until: now + COOLDOWN_MS[reason], reason });
}

export function markKeyOk(key: string): void {
  cooldownUntil.delete(key);
}

/** Classify an HTTP status from the Gemini REST API. null = not the key's fault (try another model). */
export function failureFromStatus(status: number): KeyFailure | null {
  if (status === 400 || status === 401 || status === 403) return "invalid";
  if (status === 429) return "quota";
  return null;
}

/** Classify a Gemini Live WebSocket close before setup completed. */
export function failureFromClose(code: number, reason: string): KeyFailure {
  if (/quota|exhaust|rate.?limit|resource/i.test(reason)) return "quota";
  if (code === 1008 || /api key|permission|unauthori[sz]ed|invalid/i.test(reason)) return "invalid";
  return "error";
}

/** For the preflight and Overview: which keys are resting right now (by slot, never by value). */
export function keyHealth(now = Date.now()): Array<{ slot: number; coolingDownSeconds: number; reason: KeyFailure | null }> {
  return configuredKeys().map(({ key, slot }) => {
    const c = cooldownUntil.get(key);
    const left = c && c.until > now ? Math.ceil((c.until - now) / 1000) : 0;
    return { slot, coolingDownSeconds: left, reason: left ? c!.reason : null };
  });
}

/** Tests only. */
export function resetKeyPool(): void {
  cursor = 0;
  cooldownUntil.clear();
}
