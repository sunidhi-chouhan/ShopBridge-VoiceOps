import "./helpers";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as p from "../server/voiceops/policy";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("VoiceOps policy", () => {
  it("flags only undispatched orders older than 24h as delayed", () => {
    assert.equal(p.isDelayed("placed", hoursAgo(30)), true);
    assert.equal(p.isDelayed("packed", hoursAgo(25)), true);
    assert.equal(p.isDelayed("placed", hoursAgo(5)), false);
    assert.equal(p.isDelayed("shipped", hoursAgo(90)), false);
  });
  it("allows one forward step only", () => {
    assert.equal(p.statusChange("placed", "packed").ok, true);
    assert.equal(p.statusChange("placed", "shipped").ok, false);
    assert.equal(p.statusChange("cancelled", "packed").ok, false);
  });
  it("blocks cancelling dispatched orders", () => {
    assert.equal(p.cancelEligibility("packed").ok, true);
    const v = p.cancelEligibility("shipped");
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.code, "ORDER_ALREADY_DISPATCHED");
  });
  it("enforces the return window and duplicates", () => {
    assert.equal(p.returnEligibility("delivered", hoursAgo(24), false).ok, true);
    assert.equal(!p.returnEligibility("delivered", hoursAgo(24 * 10), false).ok, true);
    assert.equal(!p.returnEligibility("shipped", hoursAgo(1), false).ok, true);
    assert.equal(!p.returnEligibility("delivered", hoursAgo(1), true).ok, true);
  });
  it("guards stock changes", () => {
    assert.equal(p.stockChange(5, 10).ok, true);
    assert.equal(p.stockChange(5, -6).ok, false);
    assert.equal(p.stockChange(5, 0).ok, false);
    assert.equal(p.stockChange(5, 501).ok, false);
  });
  it("accepts only clear spoken yes", () => {
    for (const yes of ["haan kar do", "Yes", "ok confirm", "haan theek hai", "bilkul", "हाँ, कर दो।", "हां ठीक है", "जी, भेज दो। करो"]) assert.equal(p.isAffirmative(yes), true, yes);
    for (const no of ["nahi nahi ruko", "wait cancel karo", "", "haan lekin nahi", "mat karo", "kya?", "नहीं, रुको", "हाँ लेकिन मत करो", "refund abhi mat karna"]) assert.equal(p.isAffirmative(no), false, no);
  });
});
