/**
 * Vertex AI access for Gemini (text and Live), billed to the Google Cloud project.
 *
 * Auth, no secret in env:
 *  - On Cloud Run: the attached service account, via the metadata server.
 *  - Locally: Application Default Credentials from `gcloud auth application-default login`
 *    (an authorized_user refresh token in ~/.config/gcloud).
 *
 * Config: GOOGLE_CLOUD_PROJECT (required), GOOGLE_CLOUD_LOCATION (default asia-south1),
 * VERTEX_TEXT_MODEL / VERTEX_LITE_MODEL, VERTEX_DISABLED=1 to fall back to API keys only.
 * Tokens are cached in memory and never logged.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function vertexProject(): string | null {
  if (process.env.VERTEX_DISABLED === "1") return null;
  return process.env.GOOGLE_CLOUD_PROJECT?.trim() || null;
}

export function vertexConfigured(): boolean {
  return vertexProject() !== null;
}

export function vertexLocation(): string {
  return process.env.GOOGLE_CLOUD_LOCATION?.trim() || "asia-south1";
}

export function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/** Text models to try on Vertex, in order. Regional first (lowest latency), then a global fallback. */
export function vertexTextTargets(): Array<{ location: string; model: string }> {
  const loc = vertexLocation();
  const out = [
    { location: loc, model: process.env.VERTEX_TEXT_MODEL?.trim() || "gemini-3.5-flash" },
    { location: loc, model: process.env.VERTEX_LITE_MODEL?.trim() || "gemini-3.5-flash-lite" },
    { location: "global", model: process.env.VERTEX_GLOBAL_MODEL?.trim() || "gemini-3.7-flash" },
  ];
  const seen = new Set<string>();
  return out.filter((t) => {
    const id = `${t.location}/${t.model}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function vertexGenerateUrl(project: string, location: string, model: string): string {
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

let cached: { token: string; expiresAt: number } | null = null;

async function fetchJson(url: string, init: RequestInit, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tokenFromMetadata(): Promise<{ token: string; ttl: number } | null> {
  const json = await fetchJson(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
    1500,
  );
  if (!json || typeof json.access_token !== "string") return null;
  return { token: json.access_token, ttl: Number(json.expires_in ?? 300) };
}

async function tokenFromAdcFile(): Promise<{ token: string; ttl: number } | null> {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  let creds: Record<string, string>;
  try {
    creds = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (creds.type !== "authorized_user" || !creds.refresh_token) return null;
  const json = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }),
  });
  if (!json || typeof json.access_token !== "string") return null;
  return { token: json.access_token, ttl: Number(json.expires_in ?? 300) };
}

/** A Google OAuth access token, or null when none is available (Vertex is then skipped). */
export async function vertexAccessToken(now = Date.now()): Promise<string | null> {
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const onCloudRun = Boolean(process.env.K_SERVICE);
  const got = onCloudRun ? (await tokenFromMetadata()) ?? (await tokenFromAdcFile()) : (await tokenFromAdcFile()) ?? (await tokenFromMetadata());
  if (!got) return null;
  cached = { token: got.token, expiresAt: now + got.ttl * 1000 };
  return got.token;
}

/** Tests only. */
export function resetVertexToken(): void {
  cached = null;
}
