import "./helpers";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { generateText } from "../server/assist";
import { resetKeyPool } from "../server/gemini-keys";
import { geminiAttempts } from "../server/voiceops/live";
import { resetVertexToken, vertexGenerateUrl, vertexTextTargets } from "../server/vertex";

const realFetch = globalThis.fetch;
const ENV = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_LIVE", "VERTEX_TEXT_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) delete process.env[k];
  resetVertexToken();
  resetKeyPool();
});

/** A fake ADC file so the token comes from a mocked oauth2 call, never the developer's real login. */
function fakeAdc(): void {
  const dir = mkdtempSync(join(tmpdir(), "sb-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const answer = (text: string) => ok({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text }] } }] });

describe("Vertex AI", () => {
  it("builds regional and global endpoints", () => {
    assert.equal(
      vertexGenerateUrl("p1", "asia-south1", "gemini-3.5-flash"),
      "https://asia-south1-aiplatform.googleapis.com/v1/projects/p1/locations/asia-south1/publishers/google/models/gemini-3.5-flash:generateContent",
    );
    assert.match(vertexGenerateUrl("p1", "global", "m"), /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/p1\/locations\/global\//);
  });

  it("tries the regional models first and never repeats a target", () => {
    process.env.VERTEX_TEXT_MODEL = "gemini-3.5-flash-lite";
    const targets = vertexTextTargets();
    assert.equal(targets[0].location, "asia-south1");
    assert.equal(new Set(targets.map((t) => `${t.location}/${t.model}`)).size, targets.length);
  });

  it("text calls go to Vertex first and skip thought parts", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p1";
    process.env.GEMINI_API_KEY = "k1";
    fakeAdc();
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok");
      return answer("namaste");
    }) as typeof fetch;
    const r = await generateText({ system: "s", prompt: "p", temperature: 0, maxOutputTokens: 10, purpose: "test" });
    assert.equal(r.text, "namaste");
    assert.equal(r.model, "vertex/gemini-3.5-flash");
    assert.ok(!calls.some((u) => u.includes("generativelanguage")), "API key path not used");
  });

  it("falls back to the API key when every Vertex model fails", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p1";
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_MODEL = "gemini-x";
    fakeAdc();
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
      if (u.includes("aiplatform.googleapis.com")) return new Response("{}", { status: 503 });
      if (u.includes("/models?")) return ok({ models: [] });
      return answer("from key");
    }) as typeof fetch;
    const r = await generateText({ system: "s", prompt: "p", temperature: 0, maxOutputTokens: 10, purpose: "test" });
    assert.equal(r.text, "from key");
    assert.equal(r.model, "gemini-x");
  });

  it("Live puts Vertex first only with a token, and VERTEX_LIVE=0 turns it off", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p1";
    process.env.GEMINI_API_KEY = "k1";
    assert.equal(geminiAttempts(null)[0].kind, "key");
    const withVertex = geminiAttempts("tok");
    assert.deepEqual([withVertex[0].kind, withVertex[0].location, withVertex[0].model], ["vertex", "asia-south1", "gemini-3.8-live"]);
    assert.ok(withVertex.slice(1).every((a) => a.kind === "key"), "API keys stay as fallbacks");
    process.env.VERTEX_LIVE = "0";
    assert.ok(geminiAttempts("tok").every((a) => a.kind === "key"));
  });
});
