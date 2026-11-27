/** Pure business rules for VoiceOps. No I/O, so they are unit-tested directly. */
import { nextOrderStatus, type OrderStatus } from "../../shared/types";

export const DELAY_HOURS = 24;
export const RETURN_WINDOW_DAYS = 7;
export const LOW_STOCK_DEFAULT = 5;
export const MAX_STOCK_CHANGE = 500;
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type Verdict = { ok: true } | { ok: false; code: string; message: string };
const ok: Verdict = { ok: true };
const no = (code: string, message: string): Verdict => ({ ok: false, code, message });

export function hoursSince(iso: string, now = Date.now()): number {
  return (now - Date.parse(iso)) / 3_600_000;
}

/** Placed or packed and older than `hours` means the seller has not dispatched it in time. */
export function isDelayed(status: OrderStatus, createdAt: string, hours = DELAY_HOURS, now = Date.now()): boolean {
  return (status === "placed" || status === "packed") && hoursSince(createdAt, now) > hours;
}

export function statusChange(current: OrderStatus, requested: OrderStatus): Verdict {
  if (current === "cancelled") return no("ORDER_CANCELLED", "This order is already cancelled.");
  if (nextOrderStatus(current) === requested) return ok;
  return no("BAD_STATUS", `Order is ${current}; it can only move one step forward${nextOrderStatus(current) ? ` to ${nextOrderStatus(current)}` : ""}.`);
}

export function cancelEligibility(status: OrderStatus): Verdict {
  if (status === "placed" || status === "packed") return ok;
  if (status === "cancelled") return no("ORDER_CANCELLED", "This order is already cancelled.");
  return no(
    "ORDER_ALREADY_DISPATCHED",
    `Order is already ${status}, so it cannot be cancelled. Offer to send the customer a delay or status message, or start a return after delivery.`,
  );
}

export function returnEligibility(status: OrderStatus, updatedAt: string, hasOpenReturn: boolean, now = Date.now()): Verdict {
  if (hasOpenReturn) return no("DUPLICATE_RETURN", "A return is already open for this order.");
  if (status !== "delivered" && status !== "completed") {
    return no("NOT_DELIVERED", `Order is ${status}. Returns can only start after delivery.`);
  }
  if (hoursSince(updatedAt, now) > RETURN_WINDOW_DAYS * 24) {
    return no("RETURN_WINDOW_CLOSED", `The ${RETURN_WINDOW_DAYS}-day return window has passed.`);
  }
  return ok;
}

export function stockChange(current: number, delta: number): Verdict {
  if (!Number.isInteger(delta) || delta === 0) return no("BAD_QUANTITY", "Quantity change must be a non-zero whole number.");
  if (Math.abs(delta) > MAX_STOCK_CHANGE) return no("OUT_OF_POLICY", `Changes above ${MAX_STOCK_CHANGE} units need a human review.`);
  if (current + delta < 0) return no("NEGATIVE_STOCK", `Only ${current} in stock; that would go below zero.`);
  return ok;
}

// Gemini may transcribe Hindi in Devanagari or Latin script, so both are recognised. \b does not work
// for Devanagari, so word edges are Unicode-letter lookarounds.
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{M}])(?:${alts})(?![\\p{L}\\p{M}])`, "iu");
const YES = word(
  "haan|han|ha|haa|yes|yeah|yep|ok|okay|theek|thik|sahi|kar\\s*do|karo|confirm|confirmed|approve|bilkul|done|sure|go ahead|aage badho|jee|ji|" +
    "हाँ|हां|हा|जी|ठीक|सही|कर\\s*दो|करो|कर\\s*दीजिए|ओके|बिल्कुल|बिलकुल|कन्फर्म|अप्रूव|" +
    // Tamil and Tanglish: aama / sari / seri / anuppunga (send) / pannunga (do it)
    "aama|aamaa|aamam|sari|seri|anuppunga|pannunga|podunga|ஆமா|ஆமாம்|சரி|ஓகே|அனுப்புங்க|அனுப்பு|பண்ணுங்க|போடுங்க",
);
const NO = word(
  "nahi|nahin|nhi|no|mat|stop|ruko|ruk|wait|cancel|na|don'?t|galat|wrong|" +
    "नहीं|नही|मत|रुको|रुक|वेट|कैंसल|गलत|ना|" +
    "illa|illai|venda|vendam|venaam|niruthu|irunga|இல்ல|இல்லை|வேண்டாம்|வேணாம்|நிறுத்து|இருங்க",
);

/** Spoken confirmation must be clearly affirmative and contain no negation. */
export function isAffirmative(utterance: string): boolean {
  const text = utterance.trim();
  if (!text || text.length > 120) return false;
  return YES.test(text) && !NO.test(text);
}

export function normalizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A seller's special price: only before dispatch, lower than the original, at most 50% off, one open offer at a time. */
export function offerEligibility(status: string, base: number, amount: number, openState: string | null): Verdict {
  if (status !== "placed" && status !== "packed") return { ok: false, code: "OFFER_AFTER_DISPATCH", message: "Offers can only be made before the order ships." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, code: "BAD_AMOUNT", message: "Ask for the offer amount in rupees." };
  if (amount >= base) return { ok: false, code: "OFFER_NOT_LOWER", message: `An offer must be lower than the current price of INR ${Math.round(base)}.` };
  if (amount < base * 0.5) return { ok: false, code: "OFFER_TOO_DEEP", message: "That is more than 50% off; a human should approve discounts that deep. Suggest request_human_review." };
  if (openState === "open") return { ok: false, code: "OFFER_ALREADY_OPEN", message: "This order already has an open offer waiting for the customer." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Co-pilot actions: purchase orders, courier re-routing, refunds
// ---------------------------------------------------------------------------

export const MAX_PO_QTY = 500;
/** Purchase orders above this value need a human review instead of a voice approval. */
export const MAX_PO_VALUE_INR = 100_000;
export const REFUND_WINDOW_DAYS = 30;

export function purchaseOrderCheck(quantity: number, unitCost: number, minOrderQty: number, hasSupplier: boolean): Verdict {
  if (!hasSupplier) return no("NO_SUPPLIER", "No supplier is set up for this product. Add one on the Co-pilot tab, or ask a person.");
  if (!Number.isInteger(quantity) || quantity <= 0) return no("BAD_QUANTITY", "Ask how many pieces to order (a whole number).");
  if (quantity > MAX_PO_QTY) return no("OUT_OF_POLICY", `Orders above ${MAX_PO_QTY} pieces need a human review.`);
  if (quantity < minOrderQty) return no("BELOW_MOQ", `This supplier's minimum order is ${minOrderQty} pieces.`);
  if (quantity * unitCost > MAX_PO_VALUE_INR) return no("OUT_OF_POLICY", `That purchase is over INR ${MAX_PO_VALUE_INR.toLocaleString("en-IN")}; a person must approve it outside voice.`);
  return ok;
}

export function rerouteEligibility(status: OrderStatus, stuck: boolean): Verdict {
  if (status !== "shipped") return no("NOT_IN_TRANSIT", `Order is ${status}; only shipped parcels can be re-booked with another courier.`);
  if (!stuck) return no("NOT_STUCK", "Tracking shows the parcel moving normally, so re-booking is not needed. Offer to share the tracking update instead.");
  return ok;
}

/**
 * Refunds are simulated (no money moves in the prototype) and still the most guarded action: delivered
 * or completed orders within 30 days, at most the amount paid, one refund per order.
 */
export function refundEligibility(status: OrderStatus, paidTotal: number, amount: number, deliveredAt: string, alreadyRefunded: boolean, now = Date.now()): Verdict {
  if (alreadyRefunded) return no("ALREADY_REFUNDED", "This order has already been refunded.");
  if (status !== "delivered" && status !== "completed") return no("NOT_DELIVERED", `Order is ${status}. Cancel it instead if it has not shipped; refunds are for delivered orders.`);
  if (!Number.isFinite(amount) || amount <= 0) return no("BAD_AMOUNT", "Ask for the refund amount in rupees.");
  if (amount > paidTotal) return no("REFUND_TOO_HIGH", `The customer paid INR ${Math.round(paidTotal)}; a refund cannot be more than that.`);
  if (hoursSince(deliveredAt, now) > REFUND_WINDOW_DAYS * 24) return no("OUT_OF_POLICY", `Delivered more than ${REFUND_WINDOW_DAYS} days ago; a person must decide.`);
  return ok;
}

/**
 * Approval tiers.
 * "standard": a spoken yes that matches the read-back, or a tap.
 * "critical": money leaves the business, a price or an order is changed for good, or the action is large.
 *   Only a tap on Approve counts, because a spoken yes can be misheard in a noisy shop. No agent, and no
 *   model output, can approve either tier.
 */
export type ApprovalTier = "standard" | "critical";
export const CRITICAL_PO_VALUE_INR = 25_000;
export const CRITICAL_STOCK_DELTA = 100;
export const CRITICAL_BATCH_SIZE = 10;

export type TierReason = { tier: ApprovalTier; reason: string };

/** Tier of a prepared action (its normalised, hash-bound arguments). */
export function approvalTierFor(tool: string, args: Record<string, unknown> = {}): TierReason {
  switch (tool) {
    case "issue_refund":
      return { tier: "critical", reason: "Refunds move money to the customer." };
    case "cancel_order":
      return { tier: "critical", reason: "Cancelling tells the customer their order is off." };
    case "make_offer":
      return { tier: "critical", reason: "A price change reaches the customer and cuts revenue." };
    case "create_purchase_order": {
      const total = Number(args.total_inr ?? 0);
      return total >= CRITICAL_PO_VALUE_INR
        ? { tier: "critical", reason: `Purchase of INR ${Math.round(total).toLocaleString("en-IN")} (INR ${CRITICAL_PO_VALUE_INR.toLocaleString("en-IN")} or more).` }
        : { tier: "standard", reason: "Small purchase order." };
    }
    case "adjust_stock":
      return Math.abs(Number(args.delta ?? 0)) >= CRITICAL_STOCK_DELTA
        ? { tier: "critical", reason: `Stock change of ${CRITICAL_STOCK_DELTA} units or more.` }
        : { tier: "standard", reason: "Small stock change." };
    case "notify_delayed_customers": {
      const n = Array.isArray(args.order_nos) ? args.order_nos.length : 0;
      return n >= CRITICAL_BATCH_SIZE
        ? { tier: "critical", reason: `One message to ${n} customers (${CRITICAL_BATCH_SIZE} or more).` }
        : { tier: "standard", reason: "Small batch of customer updates." };
    }
    default:
      return { tier: "standard", reason: "Routine change." };
  }
}

export function approvalTier(tool: string, args: Record<string, unknown> = {}): ApprovalTier {
  return approvalTierFor(tool, args).tier;
}


// ---------------------------------------------------------------------------
// Spoken product names: tolerant to Hinglish spellings and plurals
// ---------------------------------------------------------------------------

/**
 * A rough sound key for one word, so "saree", "sari" and "saari", or "jhumke", "jhumka" and "jhumkas"
 * compare equal: lower case, long vowels shortened, aspirated consonants flattened, doubled letters
 * collapsed, trailing plural/inflection letters dropped.
 */
export function soundKey(word: string): string {
  let w = word.normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");
  w = w.replace(/ee|ii/g, "i").replace(/aa/g, "a").replace(/oo|uu/g, "u").replace(/ph/g, "f").replace(/w/g, "v").replace(/z/g, "j");
  w = w.replace(/([kgcjtdpb])h/g, "$1").replace(/sh/g, "s");
  w = w.replace(/(.)\1+/g, "$1");
  w = w.replace(/(es|s)$/, "").replace(/[aeiouy]+$/, "");
  return w;
}

const STOP = new Set(["ka", "ki", "ke", "the", "of", "a", "and", "set", "two", "ml", "wala", "wali", "vala", "stock"]);
const keys = (text: string) => text.split(/[^\p{L}\p{N}]+/u).map(soundKey).filter((k) => k.length >= 2 && !STOP.has(k));

/** How well a spoken term matches a product name: share of the term's words found in the name (0..1). */
export function productMatchScore(term: string, name: string): number {
  const want = keys(term);
  if (!want.length) return 0;
  const have = keys(name);
  const hit = want.filter((k) => have.some((h) => h === k || (k.length >= 4 && (h.startsWith(k) || k.startsWith(h))))).length;
  return hit / want.length;
}

/** Best matches for a spoken product term: every product with the top score (if it is at least 0.5). */
export function matchProducts<T extends { name: string }>(term: string, products: T[]): T[] {
  const scored = products.map((p) => ({ p, s: productMatchScore(term, p.name) }));
  const top = Math.max(0, ...scored.map((x) => x.s));
  if (top < 0.5) return [];
  return scored.filter((x) => x.s === top).map((x) => x.p);
}

/** Order numbers one digit away from what was heard (e.g. 1353 → 1053), for "did you mean" prompts. */
export function nearOrderNumbers(heard: number, existing: number[]): number[] {
  const h = String(heard);
  return existing.filter((n) => {
    const e = String(n);
    if (e.length !== h.length || e === h) return false;
    let diff = 0;
    for (let i = 0; i < e.length; i++) if (e[i] !== h[i]) diff++;
    return diff === 1;
  });
}
