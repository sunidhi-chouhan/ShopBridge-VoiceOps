import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrace, inventedClaims } from "../server/agents/reasoning";
import { rulePlan } from "../server/agents/team";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const order = (over: Record<string, unknown> = {}) => ({ order_no: 1050, status: "placed", customer: "Asha", total: 1850, created_at: hoursAgo(30), updated_at: null, owned: true, ...over });

describe("Reasoning engine", () => {
  it("lets read-only lookups through and logs them", () => {
    const t = buildTrace("list_orders", { args: {} });
    assert.equal(t.verdict, "allowed");
  });

  it("passes a valid change but still requires a human yes", () => {
    const t = buildTrace("update_order_status", { args: { order_no: 1050, status: "packed" }, order: order() });
    assert.equal(t.verdict, "needs_approval");
    assert.ok(t.checks.every((c) => c.passed));
    assert.ok(t.checks.some((c) => /Human approval/.test(c.rule)));
  });

  it("blocks a cancel after dispatch and says why", () => {
    const t = buildTrace("cancel_order", { args: { order_no: 1050 }, order: order({ status: "shipped" }) });
    assert.equal(t.verdict, "blocked");
    assert.match(t.explanation, /already shipped/);
    assert.equal(t.checks.find((c) => c.rule === "Not yet dispatched")?.passed, false);
  });

  it("escalates out-of-policy requests to a person", () => {
    const late = buildTrace("create_return", { args: { order_no: 1054 }, order: order({ status: "delivered", updated_at: hoursAgo(24 * 12) }) });
    assert.equal(late.verdict, "escalate");
    const deep = buildTrace("make_offer", { args: { order_no: 1055, amount: 500 }, order: order({ total: 1850 }) });
    assert.equal(deep.verdict, "escalate");
    assert.equal(buildTrace("request_human_review", { args: { reason: "unclear" } }).verdict, "escalate");
  });

  it("blocks orders that are not the seller's", () => {
    const t = buildTrace("update_order_status", { args: { order_no: 9999, status: "packed" }, order: order({ owned: false, status: "unknown" }) });
    assert.equal(t.verdict, "blocked");
  });

  it("warns (but does not block) on unsupported promises in customer messages", () => {
    assert.deepEqual(inventedClaims("It will reach you on 12 Dec, tracking DL1234567890"), ["a delivery date", "a tracking number"]);
    const t = buildTrace("send_customer_message", { args: { order_no: 1050, message: "Refund kal mil jayega" }, order: order() });
    assert.equal(t.verdict, "needs_approval");
    assert.equal(t.checks.find((c) => c.rule === "No unsupported promises")?.passed, false);
    assert.match(t.explanation, /warning/);
  });

  it("checks stock limits", () => {
    const t = buildTrace("adjust_stock", { args: { set_to: 900 }, product: { name: "Tote", stock: 3, found: true } });
    assert.equal(t.verdict, "escalate");
  });
});

describe("Supervisor fallback plan", () => {
  it("assigns each kind of work to the right specialist, customers first", () => {
    const tasks = rulePlan({
      summary: { awaiting_dispatch: 3, delayed: [1051, 1052], low_stock_products: 1, open_returns: 0, pending_approvals: 0 },
      lowStock: [{ id: "p", name: "Tote", stock: 2 }],
      cases: [{ id: "r", orderId: "o", status: "requested", note: "torn" }],
    });
    assert.deepEqual(tasks.map((t) => t.agent), ["comms", "inventory", "triage"]);
    assert.deepEqual(rulePlan({ summary: { awaiting_dispatch: 0, delayed: [], low_stock_products: 0, open_returns: 0, pending_approvals: 0 }, lowStock: [], cases: [] }), []);
  });
});
