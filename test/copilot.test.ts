import "./helpers";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dailyBuckets, demandFromDaily, forecastProduct, median, shipmentHealth, slaRisk } from "../server/copilot/forecast";
import { verifyInsights, type Source } from "../server/copilot/insights";
import { simulatedCourier, simulatedSupplier } from "../server/copilot/connectors";
import * as policy from "../server/voiceops/policy";
import { buildTrace } from "../server/agents/reasoning";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const H = 3_600_000;
const flat = (perDay: number, days = 28) => new Array(days).fill(perDay);

describe("co-pilot: demand and stock forecast", () => {
  it("weights the last week more and detects a rising trend", () => {
    const d = demandFromDaily([...flat(1, 21), ...flat(2, 7)]);
    assert.equal(d.last7, 2);
    assert.equal(d.prior21, 1);
    assert.equal(d.trend, "rising");
    assert.ok(Math.abs(d.velocity - (0.6 * 2 + 0.4 * 1.25)) < 1e-9);
    assert.equal(d.units28, 35);
  });

  it("buckets sales by day and ignores sales outside the 28-day window", () => {
    const b = dailyBuckets([
      { at: new Date(NOW - 1 * H).toISOString(), quantity: 2 },
      { at: new Date(NOW - 30 * H).toISOString(), quantity: 1 },
      { at: new Date(NOW - 40 * 24 * H).toISOString(), quantity: 9 },
    ], NOW);
    assert.equal(b.length, 28);
    assert.equal(b[27], 2, "today");
    assert.equal(b[26], 1, "yesterday");
    assert.equal(b.reduce((a, x) => a + x, 0), 3);
  });

  it("is critical when stock runs out before a restock could arrive, and rounds the order up to the minimum", () => {
    const f = forecastProduct({ product_id: "p", name: "Sari", stock: 5, daily: [...flat(1, 21), ...flat(2, 7)], lead_time_days: 4, min_order_qty: 5, now: NOW });
    assert.equal(f.status, "critical");
    assert.ok(f.days_of_cover! < 4);
    assert.ok(f.suggested_qty > 0 && f.suggested_qty % 5 === 0);
    assert.match(f.reason, /runs out in/);
    assert.ok(Date.parse(f.stockout_date!) > NOW);
  });

  it("a low count on a slow seller is fine: thresholds alone would cry wolf", () => {
    const daily = new Array(28).fill(0);
    daily[3] = 1; daily[20] = 1; daily[26] = 1; // about one sale a week
    const f = forecastProduct({ product_id: "p", name: "Kantha", stock: 2, daily, lead_time_days: 4, now: NOW });
    assert.equal(f.status, "ok");
    assert.equal(f.suggested_qty, 0);
  });

  it("stock on order counts, so an open purchase order clears the alarm", () => {
    const input = { product_id: "p", name: "Tote", stock: 3, daily: flat(1), lead_time_days: 4, now: NOW };
    assert.equal(forecastProduct(input).status, "critical");
    assert.equal(forecastProduct({ ...input, on_order: 30 }).status, "ok");
  });

  it("no sales means no suggestion", () => {
    const f = forecastProduct({ product_id: "p", name: "Cup", stock: 0, daily: flat(0), now: NOW });
    assert.equal(f.status, "no_demand");
    assert.equal(f.days_of_cover, null);
    assert.equal(f.suggested_qty, 0);
  });
});

describe("co-pilot: dispatch SLA risk", () => {
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
  it("an old placed order with little time left is high risk before it is late", () => {
    const r = slaRisk({ order_no: 1056, status: "placed", created_at: at(21), handling_p50_hours: 16, now: NOW });
    assert.equal(r.level, "high");
    assert.ok(r.hours_left > 0 && r.hours_left < 4);
    assert.match(r.reason, /your typical 16 h/);
  });
  it("a fresh order is low risk and a past-SLA order is late", () => {
    assert.equal(slaRisk({ order_no: 1, status: "placed", created_at: at(2), handling_p50_hours: 16, now: NOW }).level, "low");
    const late = slaRisk({ order_no: 2, status: "packed", created_at: at(30), handling_p50_hours: 16, now: NOW });
    assert.equal(late.level, "late");
    assert.equal(late.risk, 1);
  });
  it("packed orders need less time than placed ones", () => {
    const placed = slaRisk({ order_no: 3, status: "placed", created_at: at(20), handling_p50_hours: 10, now: NOW });
    const packed = slaRisk({ order_no: 3, status: "packed", created_at: at(20), handling_p50_hours: 10, now: NOW });
    assert.ok(packed.risk < placed.risk);
  });
  it("falls back to an assumed handling time without history", () => {
    assert.match(slaRisk({ order_no: 4, status: "placed", created_at: at(1), handling_p50_hours: null, now: NOW }).reason, /assumed/);
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
});

describe("co-pilot: shipment health", () => {
  const ev = (status: string, hoursAgo: number, location = "Indore") => ({ courier: "Delhivery", awb: "DL1", status, location, note: null, at: new Date(NOW - hoursAgo * H).toISOString() });
  it("stuck when the courier says so", () => {
    const h = shipmentHealth([ev("picked_up", 20), ev("stuck", 14, "Bhopal")], NOW)!;
    assert.equal(h.stuck, true);
    assert.match(h.reason, /Bhopal/);
  });
  it("stuck when an in-transit parcel has no scan for 36 h, healthy otherwise", () => {
    assert.equal(shipmentHealth([ev("in_transit", 40)], NOW)!.stuck, true);
    assert.equal(shipmentHealth([ev("in_transit", 10)], NOW)!.stuck, false);
    assert.equal(shipmentHealth([ev("stuck", 30), ev("rebooked", 1)], NOW)!.stuck, false, "a re-booked parcel is moving again");
    assert.equal(shipmentHealth([], NOW), null);
  });
});

describe("co-pilot: policy and approval tiers", () => {
  it("purchase orders: supplier, quantity, minimum and value limits", () => {
    assert.equal(policy.purchaseOrderCheck(10, 100, 5, false).ok, false);
    assert.deepEqual(policy.purchaseOrderCheck(3, 100, 5, true), { ok: false, code: "BELOW_MOQ", message: "This supplier's minimum order is 5 pieces." });
    assert.equal((policy.purchaseOrderCheck(600, 1, 1, true) as { code: string }).code, "OUT_OF_POLICY");
    assert.equal((policy.purchaseOrderCheck(100, 2000, 1, true) as { code: string }).code, "OUT_OF_POLICY", "over INR 1 lakh");
    assert.equal(policy.purchaseOrderCheck(20, 2400, 5, true).ok, true);
  });
  it("re-route only shipped parcels that are stuck", () => {
    assert.equal((policy.rerouteEligibility("placed", true) as { code: string }).code, "NOT_IN_TRANSIT");
    assert.equal((policy.rerouteEligibility("shipped", false) as { code: string }).code, "NOT_STUCK");
    assert.equal(policy.rerouteEligibility("shipped", true).ok, true);
  });
  it("refunds: delivered, within 30 days, at most the amount paid, once", () => {
    const recent = new Date(NOW - 2 * 24 * H).toISOString();
    assert.equal(policy.refundEligibility("delivered", 4800, 4800, recent, false, NOW).ok, true);
    assert.equal((policy.refundEligibility("shipped", 4800, 100, recent, false, NOW) as { code: string }).code, "NOT_DELIVERED");
    assert.equal((policy.refundEligibility("delivered", 4800, 5000, recent, false, NOW) as { code: string }).code, "REFUND_TOO_HIGH");
    assert.equal((policy.refundEligibility("delivered", 4800, 100, recent, true, NOW) as { code: string }).code, "ALREADY_REFUNDED");
    assert.equal((policy.refundEligibility("delivered", 4800, 100, new Date(NOW - 40 * 24 * H).toISOString(), false, NOW) as { code: string }).code, "OUT_OF_POLICY");
  });
  it("tiers: refunds, cancellations and offers are always critical; size makes the rest critical", () => {
    for (const t of ["issue_refund", "cancel_order", "make_offer"]) assert.equal(policy.approvalTier(t), "critical", t);
    assert.equal(policy.approvalTier("create_purchase_order", { total_inr: 24_999 }), "standard");
    assert.equal(policy.approvalTier("create_purchase_order", { total_inr: 25_000 }), "critical");
    assert.equal(policy.approvalTier("adjust_stock", { delta: 99 }), "standard");
    assert.equal(policy.approvalTier("adjust_stock", { delta: -100 }), "critical");
    assert.equal(policy.approvalTier("notify_delayed_customers", { order_nos: [1, 2, 3] }), "standard");
    assert.equal(policy.approvalTier("notify_delayed_customers", { order_nos: Array.from({ length: 10 }, (_, i) => i) }), "critical");
    for (const t of ["update_order_status", "send_customer_message", "reroute_shipment", "create_return"]) assert.equal(policy.approvalTier(t), "standard", t);
    assert.match(policy.approvalTierFor("issue_refund").reason, /money/);
  });
  it("the reasoning trace for a refund checks eligibility and says the money is simulated", () => {
    const t = buildTrace("issue_refund", {
      args: { order_no: 1042 },
      order: { order_no: 1042, status: "delivered", customer: "Ravi", total: 4800, created_at: new Date(NOW - 90 * H).toISOString(), updated_at: new Date(Date.now() - 48 * H).toISOString(), owned: true },
      refunded: false,
    });
    assert.equal(t.verdict, "needs_approval");
    assert.ok(t.checks.some((c) => /simulated/i.test(c.rule)));
  });
});

describe("co-pilot: chat insights keep only verified quotes", () => {
  const sources: Source[] = [
    { ref: "S1", label: "Order chat · order 1042", product: "Sari", lines: [
      { role: "buyer", text: "साड़ी मिल गई, धन्यवाद। लेकिन किनारे की ज़री एक जगह से उधड़ी हुई है।" },
      { role: "seller", text: "Sorry! The border will be fixed." },
    ] },
    { ref: "S2", label: "Order chat · order 1050", product: "Jhumkas", lines: [{ role: "buyer", text: "Do these come with a gift box?" }] },
  ];
  it("keeps verbatim buyer quotes (Devanagari too), drops invented, seller-side and unknown-source quotes", () => {
    const out = verifyInsights({
      insights: [
        { kind: "complaint", product: "Sari", theme: "Zari border fraying", suggestion: "Check borders before packing", evidence: [
          { ref: "S1", quote: "किनारे की ज़री एक जगह से उधड़ी हुई है", translation: "The zari on the border has come undone in one place" },
          { ref: "S1", quote: "The border will be fixed" }, // the seller said this, not the customer
          { ref: "S9", quote: "anything" }, // no such source
        ] },
        { kind: "request", product: "Jhumkas", theme: "Gift packaging", evidence: [{ ref: "S2", quote: "do these come with a GIFT box?" }] },
        { kind: "complaint", product: "Tote", theme: "Strap broke", evidence: [{ ref: "S2", quote: "the strap broke on day one" }] }, // invented
        { kind: "rant", theme: "Bad kind", evidence: [{ ref: "S2", quote: "gift box" }] }, // unknown kind
      ],
    }, sources);
    assert.deepEqual(out.map((i) => i.theme), ["Zari border fraying", "Gift packaging"]);
    assert.equal(out[0].evidence.length, 1);
    assert.equal(out[0].evidence[0].translation, "The zari on the border has come undone in one place");
    assert.equal(out[0].mentions, 1);
  });
  it("garbage model output yields no insights", () => {
    assert.deepEqual(verifyInsights(null, sources), []);
    assert.deepEqual(verifyInsights({ insights: "nope" }, sources), []);
  });
});

describe("co-pilot: simulated connectors", () => {
  it("the supplier confirms with its lead time and a stable reference", async () => {
    const req = { poId: "po1", supplier: { id: "s", name: "Weavers", lead_time_days: 4 }, product: "Sari", quantity: 20, unitCost: 2400 };
    const a = await simulatedSupplier.sendPurchaseOrder(req, NOW);
    const b = await simulatedSupplier.sendPurchaseOrder(req, NOW);
    assert.equal(a.supplierRef, b.supplierRef);
    assert.match(a.supplierRef, /^SIM-PO-\d{6}$/);
    assert.equal(Date.parse(a.eta) - NOW, 4 * 24 * H);
    assert.equal(a.simulated, true);
  });
  it("the courier never offers the courier the parcel is stuck with, fastest first", async () => {
    const q = await simulatedCourier.quotes({ fromCity: "Indore", currentCourier: "delhivery" });
    assert.ok(!q.some((x) => x.courier === "Delhivery"));
    assert.ok(q.every((x, i) => i === 0 || q[i - 1].eta_days <= x.eta_days));
    const booking = await simulatedCourier.rebook({ orderId: "o1", courier: q[0].courier, quote: q[0] }, NOW);
    assert.equal(booking.courier, q[0].courier);
    assert.match(booking.awb, /^[A-Z]{2}\d{8}$/);
  });
});
