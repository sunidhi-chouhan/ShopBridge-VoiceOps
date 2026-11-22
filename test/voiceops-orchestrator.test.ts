import { PG_SKIP_REASON, postgresAvailable, resetTestSchema, safeTestDatabaseUrl, sql } from "./helpers";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const url = safeTestDatabaseUrl();
const available = await postgresAvailable(url);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("VoiceOps orchestrator (Postgres)", { skip: available ? false : PG_SKIP_REASON }, () => {
  let o: typeof import("../server/voiceops/orchestrator");
  let closePool: () => Promise<void>;
  const sent: Array<{ channel: string | null; text: string }> = [];
  const notifier = async (channel: string | null, text: string) => { sent.push({ channel, text }); return true; };
  const seller = { id: "useller", role: "volunteer", name: "Asha" } as any;
  const other = { id: "uother", role: "volunteer", name: "Other" } as any;
  const buyer = { id: "ubuyer", role: "member", name: "Ravi" } as any;
  let ctx: import("../server/voiceops/orchestrator").Ctx;
  let otherCtx: import("../server/voiceops/orchestrator").Ctx;
  const no: Record<string, number> = {};

  const stock = async (id: string) => Number((await sql(url, "SELECT stock FROM products WHERE id = $1", [id])).rows[0].stock);
  const status = async (id: string) => (await sql(url, "SELECT status FROM orders WHERE id = $1", [id])).rows[0].status as string;
  const ask = (name: string, args: any = {}) => o.runTool(ctx, name, args);
  const approve = (r: { approval?: { id: string } }) => o.decideApproval(ctx, r.approval!.id, "approve", "tap");

  before(async () => {
    await resetTestSchema(url);
    process.env.DATABASE_URL = url;
    const { applyMigrations } = await import("../server/db/migrate");
    await applyMigrations();
    for (const [id, role] of [["useller", "volunteer"], ["uother", "volunteer"], ["ubuyer", "member"]]) {
      await sql(url, "INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES ($1,$1,$1||'@t.io','x',$2,now())", [id, role]);
    }
    for (const [id, name, stock0, sid] of [["p1", "Cotton Saree", 10, "useller"], ["p2", "Cotton Tote", 3, "useller"], ["p3", "Brass Bowl", 8, "useller"], ["p4", "Foreign", 5, "uother"]] as const) {
      await sql(url, "INSERT INTO products (id,seller_id,name,description,category,price,stock,created_at,updated_at) VALUES ($1,$2,$3,'d','home',100,$4,now(),now())", [id, sid, name, stock0]);
    }
    const orders: Array<[string, string, string, number, number | null]> = [
      // id, seller, status, created h ago, updated h ago
      ["o_delayed", "useller", "placed", 30, null],
      ["o_shipped", "useller", "shipped", 40, 20],
      ["o_fresh_del", "useller", "delivered", 100, 24],
      ["o_old_del", "useller", "delivered", 400, 240],
      ["o_other", "uother", "placed", 50, null],
    ];
    for (const [id, sid, st, c, u] of orders) {
      await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,channel_id,created_at,updated_at) VALUES ($1,'ubuyer',$2,$3,500,'chan_'||$1,$4,$5)", [id, sid, st, hoursAgo(c), u === null ? null : hoursAgo(u)]);
      await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ($1,$2,$3,'item',2,100)", [id, sid === "uother" ? "p4" : "p1", sid]);
    }
    o = await import("../server/voiceops/orchestrator");
    ({ closePool } = await import("../server/db/pool"));
    const sessionId = await o.startSession(seller);
    ctx = { user: seller, sessionId, notifier };
    otherCtx = { user: other, sessionId: await o.startSession(other), notifier };
    await ask("list_orders");
    await o.runTool(otherCtx, "list_orders", {});
    for (const r of (await sql(url, "SELECT order_id, order_no FROM voiceops_order_numbers")).rows) no[r.order_id] = r.order_no;
  });
  after(async () => { await closePool?.(); });

  it("reads delayed orders and a summary without needing approval", async () => {
    const r = await ask("list_orders", { delayed_only: true });
    assert.equal(r.status, "succeeded");
    assert.deepEqual((r.data as any).orders.map((x: any) => x.order_no), [no.o_delayed]);
    const s: any = (await ask("business_summary")).data;
    assert.equal(s.awaiting_dispatch, 1);
    assert.deepEqual(s.delayed, [no.o_delayed]);
  });

  it("never changes data before approval; tap approval executes once", async () => {
    const r = await ask("update_order_status", { order_no: no.o_delayed, status: "packed" });
    assert.equal(r.status, "awaiting_approval");
    assert.match(r.approval!.readback, /packed/);
    assert.equal(await status("o_delayed"), "placed");
    const done = await approve(r);
    assert.equal(done.status, "succeeded");
    assert.equal(await status("o_delayed"), "packed");
    assert.ok(sent.some((m) => m.channel === "chan_o_delayed"));
    const again = await approve(r);
    assert.equal(again.code, "APPROVAL_NOT_PENDING");
    const action = (await sql(url, "SELECT human_involved, status FROM voiceops_actions WHERE id = $1", [r.actionId])).rows[0];
    assert.equal(action.status, "succeeded");
    assert.equal(action.human_involved, true);
  });

  it("blocks skipping steps and enforces ownership", async () => {
    assert.equal((await ask("update_order_status", { order_no: no.o_delayed, status: "delivered" })).code, "BAD_STATUS");
    const r = await o.runTool(otherCtx, "get_order", { order_no: no.o_delayed });
    assert.equal(r.code, "ORDER_NOT_FOUND");
    assert.equal((await ask("get_order", { order_no: no.o_other })).code, "ORDER_NOT_FOUND");
  });

  it("voice approval needs a clear yes", async () => {
    const r = await ask("update_order_status", { order_no: no.o_delayed, status: "shipped", courier: "Delhivery", awb: "D123" });
    const bad = await ask("confirm_action", { approval_id: r.approval!.id, user_words: "nahi ruko" });
    assert.equal(bad.code, "NOT_CONFIRMED");
    assert.equal(await status("o_delayed"), "packed");
    const good = await ask("confirm_action", { approval_id: r.approval!.id, user_words: "haan kar do" });
    assert.equal(good.status, "succeeded");
    assert.equal(await status("o_delayed"), "shipped");
  });

  it("the cancel-after-dispatch exception is blocked with a helpful alternative", async () => {
    const r = await ask("cancel_order", { order_no: no.o_shipped });
    assert.equal(r.status, "blocked");
    assert.equal(r.code, "ORDER_ALREADY_DISPATCHED");
    assert.match(r.message, /message/i);
    assert.equal(await status("o_shipped"), "shipped");
  });

  it("revised intent: message after exception requires approval, then sends", async () => {
    sent.length = 0;
    const r = await ask("send_customer_message", { order_no: no.o_shipped, message: "Aapka order raste mein hai, thodi deri hogi." });
    assert.equal(r.status, "awaiting_approval");
    assert.equal(sent.length, 0);
    await approve(r);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /deri/);
    const n = (await sql(url, "SELECT delivery FROM voiceops_notifications WHERE action_id = $1", [r.actionId])).rows[0];
    assert.equal(n.delivery, "sent");
  });

  it("rejecting leaves everything unchanged", async () => {
    const r = await ask("adjust_stock", { product_name: "brass", delta: 2 });
    const rej = await o.decideApproval(ctx, r.approval!.id, "reject", "tap");
    assert.equal(rej.code, "REJECTED_BY_HUMAN");
    assert.equal(await stock("p3"), 8);
  });

  it("stock: ambiguity, negative guard, apply and undo", async () => {
    assert.equal((await ask("adjust_stock", { product_name: "cotton", delta: 1 })).code, "AMBIGUOUS_PRODUCT");
    assert.equal((await ask("adjust_stock", { product_name: "tote", delta: -9 })).code, "NEGATIVE_STOCK");
    const r = await ask("adjust_stock", { product_name: "tote", set_to: 12 });
    assert.match(r.approval!.readback, /from 3 to 12/);
    await approve(r);
    assert.equal(await stock("p2"), 12);
    const u = await ask("undo_action");
    assert.equal(u.status, "succeeded");
    assert.equal(await stock("p2"), 3);
  });

  it("duplicate pending requests reuse one approval", async () => {
    const a = await ask("adjust_stock", { product_name: "bowl", delta: 1 });
    const b = await ask("adjust_stock", { product_name: "bowl", delta: 1 });
    assert.equal(b.approval!.id, a.approval!.id);
    assert.equal(b.approval!.duplicate, true);
    await approve(a);
    assert.equal(await stock("p3"), 9);
    assert.equal((await ask("adjust_stock", { product_name: "bowl", delta: 1 })).code, "DUPLICATE_ACTION");
  });

  it("returns: window and duplicate rules, refund stays deferred", async () => {
    assert.equal((await ask("create_return", { order_no: no.o_old_del })).code, "RETURN_WINDOW_CLOSED");
    assert.equal((await ask("create_return", { order_no: no.o_shipped })).code, "NOT_DELIVERED");
    const r = await ask("create_return", { order_no: no.o_fresh_del, reason: "damaged" });
    assert.match(r.approval!.readback, /No refund/);
    const done = await approve(r);
    assert.equal((done.data as any).refund, "deferred");
    assert.equal((await ask("create_return", { order_no: no.o_fresh_del })).code, "DUPLICATE_RETURN");
  });

  it("cancel restores stock and undo reverses it", async () => {
    await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,created_at) VALUES ('o_c','ubuyer','useller','placed',200,now())");
    await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ('o_c','p1','useller','item',3,100)");
    const before = await stock("p1");
    const listed: any = (await ask("list_orders", { limit: 20 })).data;
    const num = listed.orders.find((x: any) => x.items[0] === "item x3").order_no;
    await approve(await ask("cancel_order", { order_no: num }));
    assert.equal(await status("o_c"), "cancelled");
    assert.equal(await stock("p1"), before + 3);
    assert.equal((await ask("undo_action")).status, "succeeded");
    assert.equal(await status("o_c"), "placed");
    assert.equal(await stock("p1"), before);
  });

  it("expired approvals cannot be used", async () => {
    const r = await ask("adjust_stock", { product_name: "bowl", delta: 4 });
    await sql(url, "UPDATE voiceops_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [r.approval!.id]);
    assert.equal((await approve(r)).code, "APPROVAL_NOT_PENDING");
  });

  it("buyers cannot use VoiceOps", async () => {
    await assert.rejects(o.startSession(buyer), /sellers/);
  });

  it("records every call in the audit trail with latency", async () => {
    const rows = (await sql(url, "SELECT status, latency_ms FROM voiceops_actions WHERE user_id = 'useller'")).rows;
    assert.ok(rows.length > 15);
    assert.ok(rows.every((x) => x.latency_ms !== null));
    const ov: any = await o.overview(seller);
    assert.ok(ov.activity.blocked > 0 && ov.activity.succeeded > 0 && ov.activity.human > 0);
  });

  it("makes a guarded special-price offer that posts the offer card and can be withdrawn", async () => {
    await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,channel_id,created_at) VALUES ('o_offer','ubuyer','useller','placed',1000,'chan_offer',now())");
    await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ('o_offer','p3','useller','offer item',1,1000)");
    const n = ((await ask("list_orders", { limit: 20 })).data as any).orders.find((x: any) => x.items[0] === "offer item x1").order_no;
    assert.equal((await ask("make_offer", { order_no: n, amount: 400 })).code, "OFFER_TOO_DEEP");
    assert.equal((await ask("make_offer", { order_no: n, amount: 1200 })).code, "OFFER_NOT_LOWER");
    assert.equal((await ask("make_offer", { order_no: no.o_shipped, amount: 100 })).code, "OFFER_AFTER_DISPATCH");
    const r = await ask("make_offer", { order_no: n, amount: 850, note: "Festive price" });
    assert.match(r.approval!.readback, /INR 850 .* \(was INR 1,000\)/);
    assert.equal((await sql(url, "SELECT offer_state FROM orders WHERE id = 'o_offer'")).rows[0].offer_state, null, "nothing before approval");
    const before = sent.length;
    assert.equal((await approve(r)).status, "succeeded");
    const row = (await sql(url, "SELECT offer_state, offer_amount, original_total FROM orders WHERE id = 'o_offer'")).rows[0];
    assert.deepEqual([row.offer_state, Number(row.offer_amount), Number(row.original_total)], ["open", 850, 1000]);
    assert.equal(sent.at(-1)!.channel, "chan_offer");
    assert.ok(sent.length > before);
    assert.equal((await ask("make_offer", { order_no: n, amount: 800 })).code, "OFFER_ALREADY_OPEN");
    assert.equal((await ask("undo_action")).status, "succeeded");
    assert.equal((await sql(url, "SELECT offer_state FROM orders WHERE id = 'o_offer'")).rows[0].offer_state, null);
  });

  it("notifies every delayed customer with one approval", async () => {
    await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,channel_id,created_at) VALUES ('o_late2','ubuyer','useller','placed',300,'chan_late2',now() - interval '40 hours')");
    await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ('o_late2','p3','useller','late item',1,300)");
    const delayed = ((await ask("list_orders", { delayed_only: true, limit: 20 })).data as any).orders.map((o: any) => o.order_no);
    assert.ok(delayed.length >= 1);
    assert.equal((await ask("notify_delayed_customers", { message: "hi" })).code, "EMPTY_MESSAGE");
    const r = await ask("notify_delayed_customers", { message: "your order is running a day late. Sorry for the wait." });
    assert.equal(r.status, "awaiting_approval");
    assert.match(r.approval!.readback, new RegExp(`Send ${delayed.length} delayed customer`));
    const before = sent.length;
    const done: any = await approve(r);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.data.notified.sort(), delayed.sort());
    const batch = sent.slice(before);
    assert.equal(batch.length, delayed.length, "one message per delayed order, one approval");
    assert.ok(batch.every((m) => /Hi \S+, your order is running a day late/.test(m.text)));
  });

  it("prices time saved with measured manual runs, falling back to labelled assumptions", async () => {
    const before: any = (await o.overview(seller)).usage;
    assert.ok(before.baseline.every((b: any) => b.source === "assumed" && b.runs === 0));
    assert.equal(before.workflows_with_measured_baseline, 0);
    const statusDone = before.completed_by_task.update_order_status ?? 0;
    assert.ok(statusDone > 0);

    await assert.rejects(o.recordBaseline(seller, { task: "drop_tables", seconds: 30 }), /listed tasks/);
    await assert.rejects(o.recordBaseline(seller, { task: "update_order_status", seconds: 1 }), /between/);
    await assert.rejects(o.recordBaseline(buyer, { task: "update_order_status", seconds: 30 }), /sellers/);
    for (const [seconds, taps] of [[40, 10], [60, 14], [200, 30]]) await o.recordBaseline(seller, { task: "update_order_status", seconds, taps, keys: 5 });

    const after: any = (await o.overview(seller)).usage;
    const row = after.baseline.find((b: any) => b.task === "update_order_status");
    assert.deepEqual([row.source, row.runs, row.seconds, row.taps], ["measured", 3, 60, 14]); // medians
    assert.equal(after.workflows_with_measured_baseline, statusDone);
    assert.equal(after.manual_taps, statusDone * 14);
    assert.equal(after.manual_seconds - before.manual_seconds, statusDone * (60 - o.ASSUMED_MANUAL_SECONDS.update_order_status));
    assert.equal(after.baseline.find((b: any) => b.task === "adjust_stock").source, "assumed");

    const mine = await o.listBaselines(seller);
    assert.equal(mine.length, 3);
    await assert.rejects(o.deleteBaseline(other, mine[0].id), /not found/);
    await o.deleteBaseline(seller, mine[0].id);
    assert.equal((await o.listBaselines(seller)).length, 2);
  });

  it("keeps Overview working before the baselines migration has run", async () => {
    await sql(url, "ALTER TABLE voiceops_baselines RENAME TO voiceops_baselines_hidden");
    try {
      const u: any = (await o.overview(seller)).usage;
      assert.ok(u.baseline.every((b: any) => b.source === "assumed"));
      assert.deepEqual(await o.listBaselines(seller), []);
      await assert.rejects(o.recordBaseline(seller, { task: "adjust_stock", seconds: 30 }), /migration 007/);
    } finally {
      await sql(url, "ALTER TABLE voiceops_baselines_hidden RENAME TO voiceops_baselines");
    }
  });
});
