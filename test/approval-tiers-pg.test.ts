import { PG_SKIP_REASON, postgresAvailable, resetTestSchema, safeTestDatabaseUrl, sql } from "./helpers";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const url = safeTestDatabaseUrl();
const available = await postgresAvailable(url);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** Phase 4: critical edits are approved only by a tap, whatever the model or a spoken yes says. */
describe("Approval tiers (Postgres)", { skip: available ? false : PG_SKIP_REASON }, () => {
  let o: typeof import("../server/voiceops/orchestrator");
  let closePool: () => Promise<void>;
  const notifier = async () => true;
  const seller = { id: "tseller", role: "volunteer", name: "Meera" } as any;
  let ctx: import("../server/voiceops/orchestrator").Ctx;
  const no: Record<string, number> = {};
  const ask = (name: string, args: any = {}) => o.runTool(ctx, name, args);
  const voiceYes = (r: { approval?: { id: string } }, words = "haan, kar do") => o.decideApproval(ctx, r.approval!.id, "approve", "voice", words);
  const tap = (r: { approval?: { id: string } }) => o.decideApproval(ctx, r.approval!.id, "approve", "tap");
  const tierOf = async (id: string) => (await sql(url, "SELECT tier FROM voiceops_approvals WHERE id = $1", [id])).rows[0].tier;

  before(async () => {
    await resetTestSchema(url);
    process.env.DATABASE_URL = url;
    const { applyMigrations } = await import("../server/db/migrate");
    await applyMigrations();
    await sql(url, "INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES ('tseller','Meera','m@t.io','x','volunteer',now()), ('tbuyer','Ravi','r@t.io','x','member',now())");
    await sql(url, "INSERT INTO products (id,seller_id,name,description,category,price,stock,created_at,updated_at) VALUES ('tp1','tseller','Silk Saree','d','home',4000,50,now(),now())");
    await sql(url, "INSERT INTO suppliers (id,seller_id,name,lead_time_days) VALUES ('tsup','tseller','Weavers',4)");
    await sql(url, "INSERT INTO supplier_products (product_id,supplier_id,unit_cost,min_order_qty) VALUES ('tp1','tsup',2000,1)");
    for (const [id, st, c] of [["t_placed", "placed", 3], ["t_placed2", "placed", 2], ["t_deliv", "delivered", 60]] as const) {
      await sql(url, "INSERT INTO orders (id,buyer_id,seller_id,status,total,channel_id,created_at,updated_at) VALUES ($1,'tbuyer','tseller',$2,4000,NULL,$3,$3)", [id, st, hoursAgo(c)]);
      await sql(url, "INSERT INTO order_items (order_id,product_id,seller_id,name,quantity,price) VALUES ($1,'tp1','tseller','Silk Saree',1,4000)", [id]);
    }
    o = await import("../server/voiceops/orchestrator");
    ({ closePool } = await import("../server/db/pool"));
    ctx = { user: seller, sessionId: await o.startSession(seller), notifier };
    await ask("list_orders");
    for (const r of (await sql(url, "SELECT order_id, order_no FROM voiceops_order_numbers")).rows) no[r.order_id] = r.order_no;
  });
  after(async () => { await closePool?.(); });

  it("cancellation is critical: a spoken yes is refused, the order stays placed, a tap cancels it", async () => {
    const r = await ask("cancel_order", { order_no: no.t_placed });
    assert.equal(r.approval!.tier, "critical");
    assert.match(r.approval!.readback, /tap Approve/);
    assert.equal(await tierOf(r.approval!.id), "critical");
    assert.equal((await voiceYes(r)).code, "CRITICAL_NEEDS_TAP");
    assert.equal((await sql(url, "SELECT status FROM orders WHERE id = 't_placed'")).rows[0].status, "placed");
    assert.equal((await tap(r)).status, "succeeded");
    assert.equal((await sql(url, "SELECT status FROM orders WHERE id = 't_placed'")).rows[0].status, "cancelled");
  });

  it("the model cannot approve a critical action through confirm_action, even with perfect words", async () => {
    const r = await ask("make_offer", { order_no: no.t_placed2, amount: 3600 });
    assert.equal(r.approval!.tier, "critical");
    const viaModel = await ask("confirm_action", { approval_id: r.approval!.id, user_words: "yes, approve it" });
    assert.equal(viaModel.code, "CRITICAL_NEEDS_TAP");
    assert.equal((await sql(url, "SELECT offer_state FROM orders WHERE id = 't_placed2'")).rows[0].offer_state, null);
    assert.equal((await o.decideApproval(ctx, r.approval!.id, "reject", "tap")).code, "REJECTED_BY_HUMAN");
  });

  it("purchase orders: under INR 25,000 a spoken yes works; at or above it only a tap", async () => {
    const small = await ask("create_purchase_order", { product_name: "silk", quantity: 5 }); // 10,000
    assert.equal(small.approval!.tier, "standard");
    assert.equal((await voiceYes(small)).status, "succeeded");
    const big = await ask("create_purchase_order", { product_name: "silk", quantity: 20 }); // 40,000
    assert.equal(big.approval!.tier, "critical");
    assert.match(big.approval!.readback, /INR 40,000/);
    assert.equal((await voiceYes(big)).code, "CRITICAL_NEEDS_TAP");
    assert.equal((await tap(big)).status, "succeeded");
    assert.equal((await sql(url, "SELECT count(*)::int n FROM purchase_orders WHERE state = 'confirmed'")).rows[0].n, 2);
  });

  it("a supplier price change between approval and execution blocks the order", async () => {
    const r = await ask("create_purchase_order", { product_name: "silk", quantity: 3 });
    await sql(url, "UPDATE supplier_products SET unit_cost = 2500 WHERE product_id = 'tp1'");
    const done = await tap(r);
    assert.equal(done.status, "blocked");
    assert.equal(done.code, "STATE_CHANGED");
    await sql(url, "UPDATE supplier_products SET unit_cost = 2000 WHERE product_id = 'tp1'");
  });

  it("stock: small changes are standard, 100+ units are critical", async () => {
    assert.equal((await ask("adjust_stock", { product_name: "silk", delta: 5 })).approval!.tier, "standard");
    const big = await ask("adjust_stock", { product_name: "silk", delta: 120 });
    assert.equal(big.approval!.tier, "critical");
    assert.equal((await voiceYes(big)).code, "CRITICAL_NEEDS_TAP");
  });

  it("a waiting duplicate keeps its stored tier", async () => {
    const a = await ask("cancel_order", { order_no: no.t_placed2 });
    const b = await ask("cancel_order", { order_no: no.t_placed2 });
    assert.equal(b.approval!.duplicate, true);
    assert.equal(b.approval!.tier, "critical");
    assert.equal(a.approval!.id, b.approval!.id);
  });

  it("standard actions still accept a clear spoken yes, and never a hesitant one", async () => {
    const r = await ask("send_customer_message", { order_no: no.t_deliv, message: "Thank you for your order!" });
    assert.equal(r.approval!.tier, "standard");
    assert.equal((await voiceYes(r, "haan... nahi, ruko")).code, "NOT_CONFIRMED");
    assert.equal((await voiceYes(r, "haan bhej do")).status, "succeeded");
  });

  it("approvals list exposes the tier for the dashboard", async () => {
    const rows = await o.listApprovals(seller);
    assert.ok(rows.some((r: any) => r.tier === "critical"));
    assert.ok(rows.every((r: any) => r.tier === "critical" || r.tier === "standard"));
  });
});
