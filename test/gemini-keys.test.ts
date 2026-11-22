import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generateText } from "../server/assist";
import {
  COOLDOWN_MS,
  configuredKeys,
  failureFromClose,
  failureFromStatus,
  keyHealth,
  keyRotation,
  markKeyFailed,
  resetKeyPool,
} from "../server/gemini-keys";

const KEYS = ["GEMINI_API_KEY", "GEMINI_API_KEY_BACKUP", "GEMINI_API_KEY_BACKUP_2", "GEMINI_API_KEY_BACKUP_3", "GEMINI_API_KEY_BACKUP_4", "GEMINI_API_KEYS"];
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};

describe("Gemini key pool", () => {
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.GEMINI_API_KEY = "k1";
    process.env.GEMINI_API_KEY_BACKUP = "k2";
    process.env.GEMINI_API_KEY_BACKUP_2 = "k3";
    process.env.GEMINI_API_KEY_BACKUP_3 = '"k4"';
    process.env.GEMINI_API_KEY_BACKUP_4 = "k5";
    process.env.GEMINI_API_KEYS = "k2, k6";
    resetKeyPool();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    globalThis.fetch = realFetch;
    resetKeyPool();
  });

  it("reads every slot, strips quotes and drops duplicates", () => {
    assert.deepEqual(configuredKeys().map((k) => `${k.slot}:${k.key}`), ["1:k1", "2:k2", "3:k3", "4:k4", "5:k5", "6:k6"]);
  });

  it("rotates the starting key on every call and always includes every key", () => {
    const starts = Array.from({ length: 7 }, () => keyRotation()[0].key);
    assert.deepEqual(starts, ["k1", "k2", "k3", "k4", "k5", "k6", "k1"]);
    assert.equal(keyRotation().length, 6);
  });

  it("moves failing keys to the back until their cooldown ends", () => {
    const now = 1_000_000;
    markKeyFailed("k1", "invalid", now);
    markKeyFailed("k2", "quota", now);
    const order = keyRotation(now).map((k) => k.key);
    assert.deepEqual(order.slice(-2), ["k2", "k1"], "resting keys last, soonest-recovering first");
    assert.equal(order.length, 6);
    const later = keyRotation(now + COOLDOWN_MS.quota + 1).map((k) => k.key);
    assert.ok(later.indexOf("k2") < later.indexOf("k1"), "quota cooldown ended, invalid still resting");
    assert.deepEqual(keyHealth(now).filter((h) => h.coolingDownSeconds).map((h) => `${h.slot}:${h.reason}`), ["1:invalid", "2:quota"]);
  });

  it("classifies failures", () => {
    assert.equal(failureFromStatus(403), "invalid");
    assert.equal(failureFromStatus(429), "quota");
    assert.equal(failureFromStatus(503), null);
    assert.equal(failureFromStatus(404), null);
    assert.equal(failureFromClose(1008, "API key not valid"), "invalid");
    assert.equal(failureFromClose(1011, "Resource has been exhausted (quota)"), "quota");
    assert.equal(failureFromClose(1006, ""), "error");
  });

  it("fails over across all keys in one call, then starts the next call on a healthy key", async () => {
    const tried: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const key = ((init?.headers ?? {}) as Record<string, string>)["x-goog-api-key"];
      if (url.includes("/models?")) return new Response(JSON.stringify({ models: [] }));
      tried.push(key);
      if (key === "k1" || key === "k2") return new Response("{}", { status: 403 });
      if (key === "k3") return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    }) as typeof fetch;
    const first = await generateText({ system: "s", prompt: "p", temperature: 0, maxOutputTokens: 10, purpose: "test" });
    assert.equal(first.text, "ok");
    assert.deepEqual(tried, ["k1", "k2", "k3", "k4"], "one attempt per failing key, then success");
    tried.length = 0;
    await generateText({ system: "s", prompt: "p", temperature: 0, maxOutputTokens: 10, purpose: "test" });
    assert.equal(tried[0], "k4", "next call skips the three resting keys");
  });

  it("gives up only after every key has failed", async () => {
    const tried = new Set<string>();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/models?")) return new Response(JSON.stringify({ models: [] }));
      tried.add(((init?.headers ?? {}) as Record<string, string>)["x-goog-api-key"]);
      return new Response("{}", { status: 429 });
    }) as typeof fetch;
    await assert.rejects(generateText({ system: "s", prompt: "p", temperature: 0, maxOutputTokens: 10, purpose: "test" }), /busy or unavailable/);
    assert.equal(tried.size, 6);
  });
});
