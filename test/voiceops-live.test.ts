import { PG_SKIP_REASON, postgresAvailable, resetTestSchema, safeTestDatabaseUrl, sql } from "./helpers";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const url = safeTestDatabaseUrl();
const available = await postgresAvailable(url);

describe("VoiceOps Live relay with a fake Gemini", { skip: available ? false : PG_SKIP_REASON }, () => {
  let http: Server;
  let fake: WebSocketServer;
  let closePool: () => Promise<void>;
  const geminiSaw: any[] = [];
  let onAudio: ((ws: WebSocket) => void) | null = null;
  const seller = { id: "useller", role: "volunteer", name: "Asha" } as any;

  before(async () => {
    await resetTestSchema(url);
    process.env.DATABASE_URL = url;
    const { applyMigrations } = await import("../server/db/migrate");
    await applyMigrations();
    for (const [id, role] of [["useller", "volunteer"], ["ubuyer", "member"]]) {
      await sql(url, "INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES ($1,$1,$1||'@t.io','x',$2,now())", [id, role]);
    }
    await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,channel_id,created_at) VALUES ('o1','ubuyer','useller','placed',500,'chan1',now() - interval '30 hours')");
    await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ('o1','p1','useller','item',1,500)");

    // Fake Gemini Live: setupComplete, then "CALL tool {json}" text -> toolCall; after toolResponse speak.
    fake = new WebSocketServer({ port: 0 });
    fake.on("connection", (ws, req) => {
      if ((req.url ?? "").includes("key=bad-key")) return void ws.close(1008, "API key not valid");
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        geminiSaw.push(msg);
        if (msg.setup) return ws.send(JSON.stringify({ setupComplete: {} }));
        const text: string | undefined = msg.realtimeInput?.text;
        if (text?.startsWith("CALL ")) {
          const [, name, json] = text.match(/^CALL (\w+) ?(.*)$/)!;
          ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: "" } } }));
          ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "c1", name, args: json ? JSON.parse(json) : {} }] } }));
        }
        if (msg.realtimeInput?.audio && onAudio) {
          const h = onAudio;
          onAudio = null;
          return h(ws as any);
        }
        if (msg.toolResponse || msg.realtimeInput?.audio) {
          ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString("base64"), mimeType: "audio/pcm;rate=24000" } }] }, outputTranscription: { text: "Theek hai." } } }));
          ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        }
      });
    });
    await new Promise<void>((r) => fake.on("listening", () => r()));
    process.env.GEMINI_API_KEY = "fake-key";
    process.env.GEMINI_LIVE_URL = `ws://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const { attachLiveRelay } = await import("../server/voiceops/live");
    ({ closePool } = await import("../server/db/pool"));
    http = createServer();
    attachLiveRelay(http, {
      authenticate: async (req) =>
        req.headers.cookie?.includes("sid=ok2") ? ({ id: "useller2", role: "volunteer", name: "Second" } as any) : req.headers.cookie?.includes("sid=ok") ? seller : null,
      notifier: async () => true,
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  });
  after(async () => {
    fake.close();
    http.closeAllConnections();
    http.close();
    await closePool?.();
  });

  const connect = async (cookie = "sid=ok") => {
    const port = (http.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voiceops/live`, { headers: { cookie } });
    const events: any[] = [];
    const binary: Buffer[] = [];
    ws.on("message", (data, isBinary) => (isBinary ? binary.push(data as Buffer) : events.push(JSON.parse(data.toString()))));
    const waitFor = async (pred: (e: any) => boolean, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout; saw ${JSON.stringify(events.map((e) => e.type))}`);
    };
    await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
    return { ws, events, binary, waitFor };
  };

  it("rejects unauthenticated and cross-site sockets", async () => {
    const port = (http.address() as AddressInfo).port;
    const anon = new WebSocket(`ws://127.0.0.1:${port}/api/voiceops/live`);
    await assert.rejects(new Promise((_, rej) => { anon.on("error", rej); anon.on("open", () => rej(new Error("opened"))); }), /401|Unexpected/);
    const evil = new WebSocket(`ws://127.0.0.1:${port}/api/voiceops/live`, { headers: { cookie: "sid=ok", origin: "https://evil.example" } });
    await assert.rejects(new Promise((_, rej) => { evil.on("error", rej); evil.on("open", () => rej(new Error("opened"))); }), /403|Unexpected/);
  });

  it("runs a read tool from a model tool call and streams audio back with a latency figure", async () => {
    const c = await connect();
    await c.waitFor((e) => e.type === "ready");
    c.ws.send(JSON.stringify({ type: "text", text: "CALL business_summary" }));
    const result = await c.waitFor((e) => e.type === "tool_result");
    assert.equal(result.result.status, "succeeded");
    assert.deepEqual(result.result.data.delayed.length, 1);
    await c.waitFor((e) => e.type === "turn_complete");
    assert.ok(c.binary.length >= 1, "audio frame relayed");
    await c.waitFor((e) => e.type === "latency");
    assert.ok(geminiSaw.some((m) => m.toolResponse?.functionResponses?.[0]?.response?.output?.status === "succeeded"));
    c.ws.send(JSON.stringify({ type: "end" }));
    await c.waitFor((e) => e.type === "closed");
  });

  it("write via model needs approval; button approve executes and tells the model", async () => {
    const c = await connect();
    await c.waitFor((e) => e.type === "ready");
    const no = (await sql(url, "SELECT order_no FROM voiceops_order_numbers")).rows[0]?.order_no ?? 1001;
    c.ws.send(JSON.stringify({ type: "text", text: "CALL list_orders" })); // assigns order numbers
    await c.waitFor((e) => e.type === "tool_result");
    const orderNo = (await sql(url, "SELECT order_no FROM voiceops_order_numbers")).rows[0].order_no ?? no;
    c.ws.send(JSON.stringify({ type: "text", text: `CALL update_order_status {"order_no":${orderNo},"status":"packed"}` }));
    const req = await c.waitFor((e) => e.type === "approval_required");
    assert.equal((await sql(url, "SELECT status FROM orders WHERE id='o1'")).rows[0].status, "placed");
    c.ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id }));
    const resolved = await c.waitFor((e) => e.type === "approval_resolved" && e.via === "tap");
    assert.equal(resolved.result.status, "succeeded");
    assert.equal((await sql(url, "SELECT status FROM orders WHERE id='o1'")).rows[0].status, "packed");
    assert.ok(geminiSaw.some((m) => /approved with the on-screen button/.test(m.realtimeInput?.text ?? "")));
    c.ws.send(JSON.stringify({ type: "end" }));
    await c.waitFor((e) => e.type === "closed");
  });

  it("does not trust the model's claim of what the seller said", async () => {
    const c = await connect();
    await c.waitFor((e) => e.type === "ready");
    const orderNo = (await sql(url, "SELECT order_no FROM voiceops_order_numbers")).rows[0].order_no;
    c.ws.send(JSON.stringify({ type: "text", text: `CALL update_order_status {"order_no":${orderNo},"status":"shipped"}` }));
    const req = await c.waitFor((e) => e.type === "approval_required");
    // The seller actually says "nahi ruko" (heard via transcription); the model lies and passes "haan kar do".
    onAudio = (g) => {
      g.send(JSON.stringify({ serverContent: { inputTranscription: { text: "nahi ruko" } } }));
      g.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "c2", name: "confirm_action", args: { approval_id: req.approval.id, user_words: "haan kar do" } }] } }));
    };
    c.ws.send(Buffer.alloc(3200), { binary: true });
    const res = await c.waitFor((e) => e.type === "tool_result" && e.name === "confirm_action");
    assert.equal(res.result.code, "NOT_CONFIRMED");
    assert.equal((await sql(url, "SELECT status FROM orders WHERE id='o1'")).rows[0].status, "packed");
    c.ws.send(JSON.stringify({ type: "end" }));
    await c.waitFor((e) => e.type === "closed");
  });

  it("falls back to the backup key when the primary key is rejected", async () => {
    const saved = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_BACKUP];
    process.env.GEMINI_API_KEY = "bad-key";
    process.env.GEMINI_API_KEY_BACKUP = "good-key";
    try {
      const c = await connect();
      const ready = await c.waitFor((e) => e.type === "ready" || e.type === "error", 6000);
      assert.equal(ready.type, "ready");
      c.ws.send(JSON.stringify({ type: "end" }));
      await c.waitFor((e) => e.type === "closed");
    } finally {
      [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_BACKUP] = saved as any;
    }
  });

  it("rotates through backup keys 2, 3… when earlier keys are rejected", async () => {
    const names = ["GEMINI_API_KEY", "GEMINI_API_KEY_BACKUP", "GEMINI_API_KEY_BACKUP_2"] as const;
    const saved = names.map((n) => process.env[n]);
    process.env.GEMINI_API_KEY = "bad-key";
    process.env.GEMINI_API_KEY_BACKUP = "bad-key-2";
    process.env.GEMINI_API_KEY_BACKUP_2 = "good-key";
    (await import("../server/gemini-keys")).resetKeyPool();
    try {
      const c = await connect();
      const ready = await c.waitFor((e) => e.type === "ready" || e.type === "error", 8000);
      assert.equal(ready.type, "ready");
      c.ws.send(JSON.stringify({ type: "end" }));
      await c.waitFor((e) => e.type === "closed");
      const health = (await import("../server/gemini-keys")).keyHealth();
      assert.deepEqual(health.filter((h) => h.coolingDownSeconds).map((h) => h.slot), [1, 2], "rejected keys rest; the working key does not");
    } finally {
      names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
      (await import("../server/gemini-keys")).resetKeyPool();
    }
  });

  it("reports a clean error when every key fails", async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "bad-key";
    const savedBackup = process.env.GEMINI_API_KEY_BACKUP;
    delete process.env.GEMINI_API_KEY_BACKUP;
    try {
      const c = await connect();
      const err = await c.waitFor((e) => e.type === "error", 6000);
      assert.equal(err.code, "AI_UNAVAILABLE");
    } finally {
      process.env.GEMINI_API_KEY = saved;
      if (savedBackup !== undefined) process.env.GEMINI_API_KEY_BACKUP = savedBackup;
    }
  });

  it("refuses new sessions beyond the concurrency cap", async () => {
    process.env.VOICEOPS_MAX_CONCURRENT = "1";
    try {
      const first = await connect("sid=ok");
      await first.waitFor((e) => e.type === "ready");
      const second = await connect("sid=ok2");
      const refused = await second.waitFor((e) => e.type === "error", 4000);
      assert.equal(refused.code, "BUSY");
      first.ws.send(JSON.stringify({ type: "end" }));
      await first.waitFor((e) => e.type === "closed");
    } finally {
      delete process.env.VOICEOPS_MAX_CONCURRENT;
    }
  });

  it("stores session usage and latencies on close", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const rows = (await sql(url, "SELECT ended_at, latencies FROM voiceops_sessions")).rows;
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((r) => r.ended_at));
    assert.ok(rows.some((r) => r.latencies.length > 0));
  });
});
