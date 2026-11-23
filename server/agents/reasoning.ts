/**
 * Reasoning engine: every proposed action, from the voice agent or any agent on the team, gets a decision trace.
 *
 * The model (Gemini) proposes; this engine decides. It evaluates the same pure business rules the server enforces
 * (server/voiceops/policy.ts) against the facts from the database and returns:
 *   facts considered · each rule checked (passed / failed, why) · verdict · plain-language explanation.
 * No I/O here: the orchestrator gathers the facts, so every rule is unit-tested directly.
 */
import * as policy from "../voiceops/policy";

export type Check = { rule: string; passed: boolean; detail: string; hard: boolean };
export type Verdict = "allowed" | "needs_approval" | "blocked" | "escalate";
export type Trace = {
  tool: string;
  intent: string;
  facts: Array<{ label: string; value: string }>;
  checks: Check[];
  verdict: Verdict;
  explanation: string;
};

export type OrderFacts = {
  order_no: number;
  status: string;
  customer: string;
  total: number;
  created_at: string;
  updated_at: string | null;
  owned: boolean;
  open_return?: boolean;
  original_total?: number | null;
  offer_state?: string | null;
};
export type ProductFacts = { name: string; stock: number; found: boolean; matches?: number };
export type Facts = {
  order?: OrderFacts | null;
  product?: ProductFacts | null;
  delayedCount?: number;
  args: Record<string, unknown>;
};

const READ_TOOLS = new Set(["business_summary", "list_orders", "get_order", "list_low_stock", "run_agent_team"]);
const ESCALATE_CODES = new Set(["OUT_OF_POLICY", "OFFER_TOO_DEEP", "RETURN_WINDOW_CLOSED"]);
const inr = (n: number) => `INR ${Math.round(n).toLocaleString("en-IN")}`;
const fromVerdict = (rule: string, v: policy.Verdict, passDetail: string, hard = true): Check & { code?: string } =>
  v.ok ? { rule, passed: true, detail: passDetail, hard } : { rule, passed: false, detail: v.message, hard, code: v.code };

/** Heuristic: a customer message must not state dates, tracking numbers or refund promises that the facts don't support. */
export function inventedClaims(message: string): string[] {
  const found: string[] = [];
  if (/\b\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(kal|parso|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message)) found.push("a delivery date");
  if (/\b(awb|tracking)\b[^.]{0,20}\b[a-z]{0,4}\d{5,}\b|\b[A-Z]{2,4}\d{7,}\b/i.test(message)) found.push("a tracking number");
  if (/\b(refund|paisa wapas|money back)\b/i.test(message)) found.push("a refund");
  return found;
}

export function buildTrace(tool: string, facts: Facts): Trace {
  const a = facts.args;
  const checks: Array<Check & { code?: string }> = [];
  const factList: Trace["facts"] = [];
  const o = facts.order;
  let intent = tool.replace(/_/g, " ");

  if (o) {
    factList.push({ label: "Order", value: `${o.order_no} · ${o.status} · ${o.customer} · ${inr(o.total)}` });
    factList.push({ label: "Age", value: `${Math.round(policy.hoursSince(o.created_at))} h since placed` });
    checks.push({ rule: "Order belongs to this seller", passed: o.owned, detail: o.owned ? "Looked up in the seller's own orders." : "Not found among this seller's orders.", hard: true });
  }
  if (facts.product) {
    const p = facts.product;
    factList.push({ label: "Product", value: p.found ? `${p.name} · ${p.stock} in stock` : "not found" });
    checks.push({ rule: "Product identified unambiguously", passed: p.found && (p.matches ?? 1) === 1, detail: p.found ? `Matched "${p.name}".` : "No single product matches; ask the seller.", hard: true });
  }

  if (READ_TOOLS.has(tool)) {
    return { tool, intent: `Look up: ${intent}`, facts: factList, checks: [{ rule: "Read-only lookup", passed: true, detail: "Does not change any data, so it runs at once.", hard: false }], verdict: "allowed", explanation: "Read-only: runs immediately and is logged." };
  }

  switch (tool) {
    case "update_order_status": {
      intent = `Mark order ${o?.order_no} as ${a.status}`;
      if (o) checks.push(fromVerdict("One step forward only", policy.statusChange(o.status as never, String(a.status) as never), `${o.status} → ${a.status} is the next step.`));
      if (a.status === "shipped") checks.push({ rule: "Tracking recorded when shipping", passed: Boolean(a.courier && a.awb), detail: a.courier && a.awb ? `${a.courier} ${a.awb}` : "No courier or tracking number given; the buyer will see none.", hard: false });
      break;
    }
    case "cancel_order": {
      intent = `Cancel order ${o?.order_no}`;
      if (o) checks.push(fromVerdict("Not yet dispatched", policy.cancelEligibility(o.status as never), `Order is ${o.status}, so it can still be cancelled; stock goes back.`));
      break;
    }
    case "create_return": {
      intent = `Start a return for order ${o?.order_no}`;
      if (o) {
        const v = policy.returnEligibility(o.status as never, o.updated_at ?? o.created_at, Boolean(o.open_return));
        const days = Math.floor(policy.hoursSince(o.updated_at ?? o.created_at) / 24);
        factList.push({ label: "Since delivery", value: o.status === "delivered" ? `${days} day(s); window ${policy.RETURN_WINDOW_DAYS} days` : "not delivered" });
        checks.push(fromVerdict(`Delivered, within ${policy.RETURN_WINDOW_DAYS} days, no open return`, v, `Delivered ${days} day(s) ago, inside the window.`));
      }
      checks.push({ rule: "Refunds are never automatic", passed: true, detail: "The return is recorded with the refund on hold for a person.", hard: true });
      break;
    }
    case "send_customer_message": {
      const msg = String(a.message ?? "");
      intent = `Message the customer of order ${o?.order_no}`;
      checks.push({ rule: "Order still active", passed: o?.status !== "cancelled", detail: o?.status === "cancelled" ? "Cancelled orders need no update." : "Order is active.", hard: true });
      checks.push({ rule: "Message has real content", passed: msg.trim().length >= 5, detail: `${msg.trim().length} characters.`, hard: true });
      const claims = inventedClaims(msg);
      checks.push({ rule: "No unsupported promises", passed: claims.length === 0, detail: claims.length ? `Mentions ${claims.join(", ")}; check it is true before approving.` : "No dates, tracking numbers or refunds promised.", hard: false });
      break;
    }
    case "notify_delayed_customers": {
      const msg = String(a.message ?? "");
      const n = facts.delayedCount ?? 0;
      intent = `Send one delay update to ${n} delayed customer(s)`;
      factList.push({ label: "Delayed orders", value: `${n} not dispatched within ${policy.DELAY_HOURS} h` });
      checks.push({ rule: "There are delayed orders", passed: n > 0, detail: n ? `${n} order(s) qualify.` : "Nothing is delayed.", hard: true });
      checks.push({ rule: "Batch size within limit (20)", passed: n <= 20, detail: `${n} recipient(s).`, hard: true });
      checks.push({ rule: "Message has real content", passed: msg.trim().length >= 10, detail: `${msg.trim().length} characters.`, hard: true });
      const claims = inventedClaims(msg);
      checks.push({ rule: "No unsupported promises", passed: claims.length === 0, detail: claims.length ? `Mentions ${claims.join(", ")}.` : "No dates, tracking numbers or refunds promised.", hard: false });
      break;
    }
    case "adjust_stock": {
      const p = facts.product;
      const delta = a.set_to !== undefined && a.set_to !== null && p ? Number(a.set_to) - p.stock : Number(a.delta);
      intent = `Change ${p?.name ?? "a product"} stock by ${delta > 0 ? "+" : ""}${delta}`;
      if (p?.found) checks.push(fromVerdict(`Within ±${policy.MAX_STOCK_CHANGE} and not below zero`, policy.stockChange(p.stock, delta), `${p.stock} → ${p.stock + delta}.`));
      break;
    }
    case "make_offer": {
      const base = Number(o?.original_total ?? o?.total ?? 0);
      const amount = Number(a.amount);
      intent = `Offer ${inr(amount)} on order ${o?.order_no}`;
      if (o) {
        factList.push({ label: "Discount", value: base ? `${Math.round((1 - amount / base) * 100)}% off ${inr(base)}` : "unknown base" });
        checks.push(fromVerdict("Before dispatch, lower price, at most 50% off, one open offer", policy.offerEligibility(o.status, base, amount, o.offer_state ?? null), `${inr(base)} → ${inr(amount)}.`));
      }
      break;
    }
    case "request_human_review": {
      intent = "Escalate to a person";
      checks.push({ rule: "Judgement needed", passed: true, detail: String(a.reason ?? "The agent was unsure or the request is out of policy."), hard: false });
      return { tool, intent, facts: factList, checks, verdict: "escalate", explanation: "Handed to a person: the agent does not improvise when a request is unclear or out of policy." };
    }
    default:
      break;
  }

  checks.push({ rule: "Human approval before any change", passed: true, detail: "The action waits for a spoken or tapped yes; the model's yes does not count.", hard: true });
  const failedHard = checks.filter((c) => c.hard && !c.passed);
  const warnings = checks.filter((c) => !c.hard && !c.passed);
  if (failedHard.length) {
    const escalate = failedHard.some((c) => c.code && ESCALATE_CODES.has(c.code));
    return {
      tool, intent, facts: factList, checks, verdict: escalate ? "escalate" : "blocked",
      explanation: `${escalate ? "Out of policy: a person decides." : "Blocked by the rules engine."} ${failedHard.map((c) => c.detail).join(" ")}`,
    };
  }
  return {
    tool, intent, facts: factList, checks, verdict: "needs_approval",
    explanation: `All ${checks.filter((c) => c.hard).length} required rules pass${warnings.length ? `, with ${warnings.length} warning(s) to review` : ""}. Waiting for the seller's yes.`,
  };
}
