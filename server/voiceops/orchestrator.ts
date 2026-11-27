/**
 * VoiceOps orchestrator: the only path by which the voice model can touch business data.
 *
 * Flow for every write: prepare (auth + policy + read-back) -> approval row -> human decision
 * (tap or verified spoken yes) -> execute in a transaction -> audit. Reads execute immediately.
 * The model never gets a way to skip the approval step; approval ids are server-issued and bound
 * to the exact normalized arguments by hash.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { ORDER_STATUSES, type OrderStatus } from "../../shared/types";
import { getPool } from "../db/pool";
import { HttpError } from "../errors";
import type { UserRecord } from "../store-types";
import * as policy from "./policy";
import { buildTrace, type Facts, type Trace } from "../agents/reasoning";
import { courierConnector, supplierConnector } from "../copilot/connectors";
import { listPurchaseOrders, loadForecasts, loadShipments, loadSlaRisks, shipmentFor, supplierFor } from "../copilot/data";

/** Posts an order-chat event. `extra.card` asks for a rich card (for example the offer card) instead of plain text. */
export type Notifier = (channelId: string | null, text: string, extra?: { orderId: string; card?: "offer" }) => Promise<boolean>;
export type Ctx = { user: UserRecord; sessionId: string; notifier: Notifier };

export type ToolResult = {
  ok: boolean;
  status: "succeeded" | "awaiting_approval" | "blocked" | "failed";
  actionId: string;
  message: string;
  data?: unknown;
  code?: string;
  approval?: { id: string; readback: string; expiresAt: string; duplicate?: boolean; tier?: policy.ApprovalTier };
  latencyMs: number;
  /** Reasoning-engine decision trace: facts considered, rules checked, verdict and why. */
  trace?: Trace;
};

class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly kind: "blocked" | "failed" = "blocked") {
    super(message);
  }
}

const id = (prefix: string) => `${prefix}${randomBytes(6).toString("hex")}`;

async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertSeller(user: UserRecord): void {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "VoiceOps is for sellers.");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hashArgs = (userId: string, tool: string, args: unknown) =>
  createHash("sha256").update(`${userId}|${tool}|${canonical(args)}`).digest("hex");

// ---------------------------------------------------------------------------
// Order and product access (always scoped to the signed-in seller)
// ---------------------------------------------------------------------------

type OrderRow = {
  id: string;
  order_no: number;
  status: OrderStatus;
  total: number;
  created_at: string;
  updated_at: string | null;
  channel_id: string | null;
  buyer_name: string;
  items: Array<{ product_id: string; name: string; quantity: number }>;
};

async function ensureOrderNumbers(client: pg.PoolClient, sellerId: string): Promise<void> {
  await client.query(
    `INSERT INTO voiceops_order_numbers (order_id)
       SELECT id FROM orders WHERE seller_id = $1
        AND id NOT IN (SELECT order_id FROM voiceops_order_numbers)
        ORDER BY created_at
     ON CONFLICT DO NOTHING`,
    [sellerId],
  );
}

const ORDER_SELECT = `
  SELECT o.id, n.order_no, o.status, o.total, o.created_at, o.updated_at, o.channel_id, u.name AS buyer_name,
         COALESCE((SELECT json_agg(json_build_object('product_id', i.product_id, 'name', i.name, 'quantity', i.quantity))
                     FROM order_items i WHERE i.order_id = o.id), '[]') AS items
    FROM orders o
    JOIN voiceops_order_numbers n ON n.order_id = o.id
    JOIN users u ON u.id = o.buyer_id`;

function normRow(row: any): OrderRow {
  return {
    ...row,
    order_no: Number(row.order_no),
    total: Number(row.total),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function loadOrder(client: pg.PoolClient, sellerId: string, orderNo: unknown, lock = false): Promise<OrderRow> {
  const no = Number(orderNo);
  if (!Number.isInteger(no) || no <= 0) throw new ToolError("BAD_ORDER_NUMBER", "Ask the seller to repeat the order number.");
  await ensureOrderNumbers(client, sellerId);
  const res = await client.query(
    `${ORDER_SELECT} WHERE o.seller_id = $1 AND n.order_no = $2 ${lock ? "FOR UPDATE OF o" : ""}`,
    [sellerId, no],
  );
  if (!res.rows[0]) throw new ToolError("ORDER_NOT_FOUND", `No order ${no} found for this seller. Ask them to confirm the number.`);
  return normRow(res.rows[0]);
}

function summarize(order: OrderRow) {
  const age = Math.round(policy.hoursSince(order.created_at));
  return {
    order_no: order.order_no,
    status: order.status,
    total_inr: order.total,
    customer: order.buyer_name,
    items: order.items.map((item) => `${item.name} x${item.quantity}`),
    age_hours: age,
    delayed: policy.isDelayed(order.status, order.created_at),
  };
}

async function findProduct(client: pg.PoolClient, sellerId: string, args: Record<string, unknown>, lock = false) {
  if (typeof args.product_id === "string" && args.product_id) {
    const res = await client.query(
      `SELECT id, name, stock FROM products WHERE id = $1 AND seller_id = $2 ${lock ? "FOR UPDATE" : ""}`,
      [args.product_id, sellerId],
    );
    if (res.rows[0]) return res.rows[0] as { id: string; name: string; stock: number };
  }
  const term = policy.normalizeText(args.product_name, 80).toLowerCase();
  if (!term) throw new ToolError("MISSING_PRODUCT", "Ask which product they mean.");
  const res = await client.query(
    `SELECT id, name, stock FROM products WHERE seller_id = $1 AND lower(name) LIKE $2 ORDER BY name ${lock ? "FOR UPDATE" : ""}`,
    [sellerId, `%${term.replace(/[%_]/g, "")}%`],
  );
  if (res.rows.length === 0) throw new ToolError("PRODUCT_NOT_FOUND", `No product matching "${term}". Ask them to name it again.`);
  if (res.rows.length > 1) {
    throw new ToolError("AMBIGUOUS_PRODUCT", `Several products match: ${res.rows.map((r) => r.name).join(", ")}. Ask which one.`);
  }
  return res.rows[0] as { id: string; name: string; stock: number };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type Prepared = { args: Record<string, unknown>; readback: string };
type Executed = {
  data: unknown;
  message: string;
  undo?: Record<string, unknown>;
  notify?: Array<{ orderId: string; channelId: string | null; text: string; language?: string | null; card?: "offer" }>;
};

type WriteTool = {
  prepare(client: pg.PoolClient, ctx: Ctx, args: Record<string, unknown>): Promise<Prepared>;
  execute(client: pg.PoolClient, ctx: Ctx, args: Record<string, unknown>): Promise<Executed>;
};

const statusEvent = (status: OrderStatus) =>
  status === "packed" ? "Update · Packed by the seller."
  : status === "shipped" ? "Update · Shipped. On its way to the buyer."
  : status === "delivered" ? "Update · Delivered."
  : `Update · Order status changed to ${status}.`;

const writeTools: Record<string, WriteTool> = {};

writeTools.update_order_status = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const status = String(args.status ?? "") as OrderStatus;
    if (!(ORDER_STATUSES as readonly string[]).includes(status)) throw new ToolError("BAD_STATUS", "Status must be packed, shipped or delivered.");
    const verdict = policy.statusChange(order.status, status);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const courier = policy.normalizeText(args.courier, 60);
    const awb = policy.normalizeText(args.awb, 60);
    return {
      args: { order_no: order.order_no, status, ...(status === "shipped" && courier && awb ? { courier, awb } : {}) },
      readback: `Mark order ${order.order_no} (${order.buyer_name}) as ${status}${courier && awb ? ` with ${courier} tracking ${awb}` : ""}.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const status = args.status as OrderStatus;
    const verdict = policy.statusChange(order.status, status);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    await client.query(
      `UPDATE orders SET status = $2, updated_at = now(),
         courier = CASE WHEN $3::text IS NULL THEN courier ELSE $3 END,
         awb = CASE WHEN $4::text IS NULL THEN awb ELSE $4 END,
         shipped_at = CASE WHEN $2 = 'shipped' THEN now() ELSE shipped_at END WHERE id = $1`,
      [order.id, status, (args.courier as string) ?? null, (args.awb as string) ?? null],
    );
    if (status === "shipped" && args.courier && args.awb) {
      await client.query("INSERT INTO shipment_events (id, order_id, courier, awb, status, note) VALUES ($1,$2,$3,$4,'picked_up','Handed to the courier')", [id("shp"), order.id, args.courier, args.awb]);
    }
    return {
      data: { order_no: order.order_no, from: order.status, to: status },
      message: `Order ${order.order_no} is now ${status}.`,
      undo: { kind: "status", order_id: order.id, order_no: order.order_no, from: order.status, to: status },
      notify: [{ orderId: order.id, channelId: order.channel_id, text: statusEvent(status) }],
    };
  },
};

writeTools.cancel_order = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const verdict = policy.cancelEligibility(order.status);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    return {
      args: { order_no: order.order_no },
      readback: `Cancel order ${order.order_no} for ${order.buyer_name}, INR ${order.total}, and put the stock back.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const verdict = policy.cancelEligibility(order.status);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [order.id]);
    for (const item of order.items) {
      await client.query("UPDATE products SET stock = stock + $2 WHERE id = $1 AND seller_id = $3", [item.product_id, item.quantity, ctx.user.id]);
    }
    return {
      data: { order_no: order.order_no, previous: order.status },
      message: `Order ${order.order_no} is cancelled and stock restored.`,
      undo: { kind: "cancel", order_id: order.id, order_no: order.order_no, previous: order.status, items: order.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })) },
      notify: [{ orderId: order.id, channelId: order.channel_id, text: "Update · This order was cancelled by the seller." }],
    };
  },
};

writeTools.create_return = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const open = await client.query("SELECT 1 FROM voiceops_returns WHERE order_id = $1 AND state = 'requested'", [order.id]);
    const verdict = policy.returnEligibility(order.status, order.updated_at ?? order.created_at, Boolean(open.rowCount));
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const reason = policy.normalizeText(args.reason, 300) || "Seller-initiated return";
    return {
      args: { order_no: order.order_no, reason },
      readback: `Start a return for order ${order.order_no} (${order.buyer_name}). Reason: ${reason}. No refund will be issued now.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const open = await client.query("SELECT 1 FROM voiceops_returns WHERE order_id = $1 AND state = 'requested'", [order.id]);
    const verdict = policy.returnEligibility(order.status, order.updated_at ?? order.created_at, Boolean(open.rowCount));
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const returnId = id("ret");
    await client.query(
      "INSERT INTO voiceops_returns (id, order_id, seller_id, reason) VALUES ($1, $2, $3, $4)",
      [returnId, order.id, ctx.user.id, args.reason],
    );
    return {
      data: { return_id: returnId, order_no: order.order_no, refund: "deferred" },
      message: `Return started for order ${order.order_no}. Refund is on hold.`,
      undo: { kind: "return", return_id: returnId },
      notify: [{ orderId: order.id, channelId: order.channel_id, text: `Update · A return was started for this order. Reason: ${args.reason}` }],
    };
  },
};

writeTools.send_customer_message = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    if (order.status === "cancelled") throw new ToolError("ORDER_CANCELLED", "This order is cancelled; no customer update is needed.");
    const message = policy.normalizeText(args.message, 500);
    if (message.length < 5) throw new ToolError("EMPTY_MESSAGE", "Draft the message text first, then ask for approval.");
    return {
      args: { order_no: order.order_no, message, language: policy.normalizeText(args.language, 20) || null },
      readback: `Send ${order.buyer_name} (order ${order.order_no}) this message: "${message}"`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    return {
      data: { order_no: order.order_no, customer: order.buyer_name },
      message: `Message sent to ${order.buyer_name} for order ${order.order_no}.`,
      notify: [{ orderId: order.id, channelId: order.channel_id, text: `Message from ${ctx.user.name}: ${String(args.message)}`, language: (args.language as string) ?? null }],
    };
  },
};

writeTools.adjust_stock = {
  async prepare(client, ctx, args) {
    const product = await findProduct(client, ctx.user.id, args);
    const delta = args.set_to !== undefined && args.set_to !== null ? Number(args.set_to) - Number(product.stock) : Number(args.delta);
    const verdict = policy.stockChange(Number(product.stock), delta);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    return {
      args: { product_id: product.id, delta },
      readback: `Change ${product.name} stock from ${product.stock} to ${Number(product.stock) + delta} (${delta > 0 ? "+" : ""}${delta}).`,
    };
  },
  async execute(client, ctx, args) {
    const product = await findProduct(client, ctx.user.id, { product_id: args.product_id }, true);
    const delta = Number(args.delta);
    const verdict = policy.stockChange(Number(product.stock), delta);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    await client.query("UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1", [product.id, delta]);
    return {
      data: { product: product.name, from: Number(product.stock), to: Number(product.stock) + delta },
      message: `${product.name} stock is now ${Number(product.stock) + delta}.`,
      undo: { kind: "stock", product_id: product.id, delta },
    };
  },
};

const inr = (n: number) => `INR ${Math.round(n).toLocaleString("en-IN")}`;

writeTools.make_offer = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const extra = (await client.query("SELECT original_total, offer_state FROM orders WHERE id = $1", [order.id])).rows[0] ?? {};
    const verdict = policy.offerEligibility(order.status, Number(extra.original_total ?? order.total), Number(args.amount), extra.offer_state ?? null);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const base = Number(extra.original_total ?? order.total);
    const amount = Math.round(Number(args.amount));
    const note = policy.normalizeText(args.note, 200);
    return {
      args: { order_no: order.order_no, amount, ...(note ? { note } : {}) },
      readback: `Offer ${order.buyer_name} a special price of ${inr(amount)} on order ${order.order_no} (was ${inr(base)})${note ? `, with the note "${note}"` : ""}. They can accept or decline it in the order chat.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const extra = (await client.query("SELECT original_total, offer_state FROM orders WHERE id = $1", [order.id])).rows[0] ?? {};
    const base = Number(extra.original_total ?? order.total);
    const verdict = policy.offerEligibility(order.status, base, Number(args.amount), extra.offer_state ?? null);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const offerId = id("f");
    await client.query(
      `UPDATE orders SET offer_id = $2, offer_amount = $3, offer_note = $4, offer_state = 'open',
              original_total = COALESCE(original_total, total), updated_at = now() WHERE id = $1`,
      [order.id, offerId, Number(args.amount), (args.note as string) ?? null],
    );
    return {
      data: { order_no: order.order_no, amount: Number(args.amount), was: base },
      message: `Offer of ${inr(Number(args.amount))} sent to ${order.buyer_name} for order ${order.order_no}.`,
      undo: { kind: "offer", order_id: order.id, offer_id: offerId },
      notify: [{ orderId: order.id, channelId: order.channel_id, text: `Offer · Special price ${inr(Number(args.amount))} (was ${inr(base)}).`, card: "offer" }],
    };
  },
};

const MAX_BATCH = 20;
const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** One approval, many customers: a delay update to every delayed order (or the listed ones). */
writeTools.notify_delayed_customers = {
  async prepare(client, ctx, args) {
    await ensureOrderNumbers(client, ctx.user.id);
    const all = (await client.query(`${ORDER_SELECT} WHERE o.seller_id = $1 ORDER BY n.order_no`, [ctx.user.id])).rows.map(normRow);
    const wanted = Array.isArray(args.order_nos) && args.order_nos.length ? new Set(args.order_nos.map(Number)) : null;
    const targets = all.filter((o) => policy.isDelayed(o.status, o.created_at) && (!wanted || wanted.has(o.order_no))).slice(0, MAX_BATCH);
    if (!targets.length) throw new ToolError("NO_DELAYED_ORDERS", "There are no delayed orders to notify right now.");
    const message = policy.normalizeText(args.message, 400);
    if (message.length < 10) throw new ToolError("EMPTY_MESSAGE", "Draft the delay message first (one or two polite sentences, no promises you cannot keep).");
    return {
      args: { order_nos: targets.map((o) => o.order_no), message, language: policy.normalizeText(args.language, 20) || null },
      readback: `Send ${targets.length} delayed customer${targets.length > 1 ? "s" : ""} (orders ${targets.map((o) => `${o.order_no} ${firstName(o.buyer_name)}`).join(", ")}) this update: "Hi <name>, ${message}"`,
    };
  },
  async execute(client, ctx, args) {
    await ensureOrderNumbers(client, ctx.user.id);
    const nos = (args.order_nos as number[]).map(Number);
    const rows = (await client.query(`${ORDER_SELECT} WHERE o.seller_id = $1 AND n.order_no = ANY($2)`, [ctx.user.id, nos])).rows.map(normRow);
    const live = rows.filter((o) => o.status !== "cancelled" && o.status !== "delivered");
    if (!live.length) throw new ToolError("STATE_CHANGED", "Those orders have changed since; nothing was sent.");
    return {
      data: { notified: live.map((o) => o.order_no), skipped: nos.filter((n) => !live.some((o) => o.order_no === n)) },
      message: `Delay update sent to ${live.length} customer${live.length > 1 ? "s" : ""}: orders ${live.map((o) => o.order_no).join(", ")}.`,
      notify: live.map((o) => ({
        orderId: o.id,
        channelId: o.channel_id,
        text: `Message from ${ctx.user.name}: Hi ${firstName(o.buyer_name)}, ${String(args.message)}`,
        language: (args.language as string) ?? null,
      })),
    };
  },
};

writeTools.request_human_review = {
  async prepare(_client, _ctx, args) {
    const reason = policy.normalizeText(args.reason, 300);
    if (!reason) throw new ToolError("MISSING_REASON", "Say why a human needs to look at this.");
    return { args: { reason }, readback: `Flag for human review: ${reason}` };
  },
  async execute(_client, _ctx, args) {
    return { data: { reason: args.reason }, message: "Flagged for human review." };
  },
};


// ---------------------------------------------------------------------------
// Co-pilot write tools: supplier restock, courier re-route, refund (critical)
// ---------------------------------------------------------------------------

writeTools.create_purchase_order = {
  async prepare(client, ctx, args) {
    const product = await findProduct(client, ctx.user.id, args);
    const supplier = await supplierFor(client, ctx.user.id, product.id);
    const forecast = (await loadForecasts(client, ctx.user.id)).find((f) => f.product_id === product.id);
    const asked = args.quantity === undefined || args.quantity === null || args.quantity === "" ? null : Number(args.quantity);
    if (asked === null && !forecast?.suggested_qty) {
      throw new ToolError("NO_REORDER_NEEDED", `${forecast?.reason ?? "Stock looks fine."} Ask how many pieces if they still want to order.`);
    }
    const quantity = asked ?? forecast!.suggested_qty;
    const verdict = policy.purchaseOrderCheck(quantity, supplier?.unit_cost ?? 0, supplier?.min_order_qty ?? 1, Boolean(supplier));
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const total = quantity * supplier!.unit_cost;
    return {
      args: { product_id: product.id, supplier_id: supplier!.id, quantity, total_inr: total },
      readback: `Send ${supplier!.name} a purchase order for ${quantity} × ${product.name} at ${inr(supplier!.unit_cost)} each, ${inr(total)} in total, expected in about ${supplier!.lead_time_days} days.${forecast ? ` Why: ${forecast.reason}` : ""}`,
    };
  },
  async execute(client, ctx, args) {
    const product = await findProduct(client, ctx.user.id, { product_id: args.product_id });
    const supplier = await supplierFor(client, ctx.user.id, product.id);
    if (!supplier || supplier.id !== args.supplier_id) throw new ToolError("STATE_CHANGED", "The supplier for this product has changed; nothing was ordered.");
    const quantity = Number(args.quantity);
    const verdict = policy.purchaseOrderCheck(quantity, supplier.unit_cost, supplier.min_order_qty, true);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const total = quantity * supplier.unit_cost;
    if (args.total_inr !== undefined && Math.round(Number(args.total_inr)) !== Math.round(total)) {
      throw new ToolError("STATE_CHANGED", "The supplier's price changed since you approved; nothing was ordered. Ask again for the new total.");
    }
    const poId = id("po");
    await client.query(
      `INSERT INTO purchase_orders (id, seller_id, supplier_id, product_id, product_name, quantity, unit_cost, total, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent')`,
      [poId, ctx.user.id, supplier.id, product.id, product.name, quantity, supplier.unit_cost, total],
    );
    const receipt = await supplierConnector().sendPurchaseOrder({ poId, supplier, product: product.name, quantity, unitCost: supplier.unit_cost });
    await client.query("UPDATE purchase_orders SET state = $2, supplier_ref = $3, eta = $4, updated_at = now() WHERE id = $1", [poId, receipt.state, receipt.supplierRef, receipt.eta]);
    return {
      data: { po_id: poId, supplier: supplier.name, product: product.name, quantity, total_inr: total, supplier_ref: receipt.supplierRef, eta: receipt.eta, simulated: receipt.simulated },
      message: `Purchase order ${receipt.supplierRef} sent to ${supplier.name}: ${quantity} × ${product.name}, ${inr(total)}. ${receipt.state === "confirmed" ? "Confirmed" : "Sent"}, arriving around ${new Date(receipt.eta).toDateString()}.`,
      undo: { kind: "po", po_id: poId },
    };
  },
};

writeTools.reroute_shipment = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const { health, city } = await shipmentFor(client, order.id);
    const verdict = policy.rerouteEligibility(order.status, Boolean(health?.stuck));
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const quotes = await courierConnector().quotes({ fromCity: city, currentCourier: health!.courier });
    const wanted = policy.normalizeText(args.courier, 40).toLowerCase();
    const quote = wanted ? quotes.find((q) => q.courier.toLowerCase().includes(wanted)) : quotes[0];
    if (!quote) throw new ToolError("UNKNOWN_COURIER", `Available couriers: ${quotes.map((q) => q.courier).join(", ")}. Ask which one.`);
    return {
      args: { order_no: order.order_no, courier: quote.courier },
      readback: `Re-book order ${order.order_no} (${order.buyer_name}) with ${quote.courier} ${quote.service}: about ${quote.eta_days} days, ${inr(quote.cost_inr)}. The ${health!.courier} parcel ${health!.awb} is stuck: ${health!.reason} ${order.buyer_name.split(/\s+/)[0]} gets the new tracking number.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const { health, city } = await shipmentFor(client, order.id);
    const verdict = policy.rerouteEligibility(order.status, Boolean(health?.stuck));
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const courier = courierConnector();
    const quote = (await courier.quotes({ fromCity: city, currentCourier: health!.courier })).find((q) => q.courier === args.courier);
    if (!quote) throw new ToolError("STATE_CHANGED", "That courier is no longer available; nothing was booked.");
    const booking = await courier.rebook({ orderId: order.id, courier: quote.courier, quote });
    await client.query("UPDATE orders SET courier = $2, awb = $3, eta = $4, updated_at = now() WHERE id = $1", [order.id, booking.courier, booking.awb, booking.eta]);
    await client.query(
      "INSERT INTO shipment_events (id, order_id, courier, awb, status, location, note) VALUES ($1,$2,$3,$4,'rebooked',$5,$6)",
      [id("shp"), order.id, booking.courier, booking.awb, city, `Re-booked from ${health!.courier} ${health!.awb}${booking.simulated ? " (simulated courier)" : ""}`],
    );
    return {
      data: { order_no: order.order_no, from: { courier: health!.courier, awb: health!.awb }, to: { courier: booking.courier, awb: booking.awb, eta: booking.eta }, cost_inr: quote.cost_inr, simulated: booking.simulated },
      message: `Order ${order.order_no} re-booked with ${booking.courier}, tracking ${booking.awb}, expected ${new Date(booking.eta).toDateString()}.`,
      notify: [{ orderId: order.id, channelId: order.channel_id, text: `Update · Your parcel was re-booked with ${booking.courier} to avoid a delay. New tracking: ${booking.awb}.` }],
    };
  },
};

async function refundFacts(client: pg.PoolClient, orderId: string) {
  const row = (await client.query(
    "SELECT EXISTS (SELECT 1 FROM refunds WHERE order_id = $1 AND state = 'issued') AS refunded",
    [orderId],
  )).rows[0];
  return { refunded: Boolean(row?.refunded) };
}

/** Critical tier: executes only after a tap on Approve (see decideApproval). Money is simulated in the prototype. */
writeTools.issue_refund = {
  async prepare(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const { refunded } = await refundFacts(client, order.id);
    const amount = args.amount === undefined || args.amount === null || args.amount === "" ? order.total : Math.round(Number(args.amount));
    const verdict = policy.refundEligibility(order.status, order.total, amount, order.updated_at ?? order.created_at, refunded);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const reason = policy.normalizeText(args.reason, 300) || "Seller-approved refund";
    return {
      args: { order_no: order.order_no, amount, reason },
      readback: `Refund ${inr(amount)} to ${order.buyer_name} for order ${order.order_no} (paid ${inr(order.total)}). Reason: ${reason}.`,
    };
  },
  async execute(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no, true);
    const { refunded } = await refundFacts(client, order.id);
    const amount = Number(args.amount);
    const verdict = policy.refundEligibility(order.status, order.total, amount, order.updated_at ?? order.created_at, refunded);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    const refundId = id("rfd");
    await client.query("INSERT INTO refunds (id, order_id, seller_id, amount, reason) VALUES ($1,$2,$3,$4,$5)", [refundId, order.id, ctx.user.id, amount, args.reason]);
    return {
      data: { refund_id: refundId, order_no: order.order_no, amount_inr: amount, simulated: true },
      message: `Refund of ${inr(amount)} recorded for order ${order.order_no} (simulated: no real money moved).`,
      notify: [{ orderId: order.id, channelId: order.channel_id, text: `Update · A refund of ${inr(amount)} was issued for this order.` }],
    };
  },
};

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

type ReadTool = (client: pg.PoolClient, ctx: Ctx, args: Record<string, unknown>) => Promise<{ data: unknown; message: string }>;

const readTools: Record<string, ReadTool> = {
  async list_orders(client, ctx, args) {
    await ensureOrderNumbers(client, ctx.user.id);
    const status = typeof args.status === "string" && (ORDER_STATUSES as readonly string[]).includes(args.status) ? args.status : null;
    const res = await client.query(`${ORDER_SELECT} WHERE o.seller_id = $1 AND ($2::text IS NULL OR o.status = $2) ORDER BY o.created_at DESC LIMIT 100`, [ctx.user.id, status]);
    let orders = res.rows.map(normRow).map(summarize);
    if (args.delayed_only) orders = orders.filter((o) => o.delayed);
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    return { data: { total: orders.length, orders: orders.slice(0, limit) }, message: `${orders.length} matching orders.` };
  },
  async get_order(client, ctx, args) {
    const order = await loadOrder(client, ctx.user.id, args.order_no);
    const returns = await client.query("SELECT id, state, reason FROM voiceops_returns WHERE order_id = $1", [order.id]);
    return { data: { ...summarize(order), returns: returns.rows }, message: `Order ${order.order_no} is ${order.status}.` };
  },
  async list_low_stock(client, ctx, args) {
    const threshold = Math.min(Math.max(Number(args.threshold) || policy.LOW_STOCK_DEFAULT, 0), 1000);
    const res = await client.query("SELECT name, stock FROM products WHERE seller_id = $1 AND stock <= $2 ORDER BY stock, name LIMIT 20", [ctx.user.id, threshold]);
    return { data: { threshold, products: res.rows }, message: `${res.rows.length} products at or below ${threshold}.` };
  },
  async run_agent_team(_client, ctx) {
    // Dynamic import: the team module itself calls this orchestrator.
    const { startTeamRun } = await import("../agents/team");
    const { runId, reused } = await startTeamRun(ctx.user, "voice", ctx.notifier);
    return {
      data: { run_id: runId, reused },
      message: reused ? "The agent team is already working; its proposals will appear for approval." : "The agent team has started: the supervisor will plan and the specialists will propose actions for approval on the Agent network tab.",
    };
  },
  async forecast_stock(client, ctx, args) {
    const all = await loadForecasts(client, ctx.user.id);
    const term = policy.normalizeText(args.product_name, 80).toLowerCase();
    const list = term ? all.filter((f) => f.name.toLowerCase().includes(term)) : all.filter((f) => f.status === "critical" || f.status === "warning");
    const rows = (list.length ? list : all.slice(0, 3)).slice(0, 8).map((f) => ({
      product: f.name, stock: f.stock, on_order: f.on_order, selling_per_day: f.velocity_per_day, trend: f.trend, days_left: f.days_of_cover,
      runs_out: f.stockout_date?.slice(0, 10) ?? null, status: f.status, suggested_order: f.suggested_qty, supplier: f.supplier?.name ?? null, lead_time_days: f.lead_time_days, why: f.reason,
    }));
    const urgent = all.filter((f) => f.status === "critical").length;
    return { data: { at_risk: rows }, message: urgent ? `${urgent} product(s) will run out before a restock could arrive.` : "No product is about to run out." };
  },
  async sla_risk(client, ctx) {
    const { risks, handling } = await loadSlaRisks(client, ctx.user.id);
    const flagged = risks.filter((r) => r.level !== "low");
    return {
      data: { typical_dispatch_hours: handling.hours, history_orders: handling.samples, orders: flagged.slice(0, 10).map((r) => ({ order_no: r.order_no, customer: r.customer, status: r.status, level: r.level, hours_left: r.hours_left, risk: r.risk, why: r.reason })) },
      message: `${flagged.filter((r) => r.level === "late").length} late, ${flagged.filter((r) => r.level !== "late").length} at risk of missing the 24 h dispatch promise.`,
    };
  },
  async track_shipment(client, ctx, args) {
    if (args.order_no !== undefined && args.order_no !== null) {
      const order = await loadOrder(client, ctx.user.id, args.order_no);
      const { health, events } = await shipmentFor(client, order.id);
      if (!health) return { data: { order_no: order.order_no, status: order.status }, message: `Order ${order.order_no} has no tracking yet (${order.status}).` };
      return { data: { order_no: order.order_no, ...health, scans: events.slice(-5) }, message: `${health.courier} ${health.awb}: ${health.reason}` };
    }
    const all = await loadShipments(client, ctx.user.id);
    return { data: { shipments: all.slice(0, 10).map(({ events: _e, ...rest }) => rest) }, message: `${all.filter((s) => s.stuck).length} stuck of ${all.length} parcel(s) in transit.` };
  },
  async chat_insights(client, ctx) {
    const rows = (await client.query(
      `SELECT kind, product_name, theme, suggestion, mentions, evidence, created_at FROM copilot_insights
        WHERE seller_id = $1 AND run_id = (SELECT run_id FROM copilot_insights WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 1)
        ORDER BY mentions DESC, kind`,
      [ctx.user.id],
    )).rows;
    if (!rows.length) return { data: { insights: [] }, message: "No chat insights yet. Ask the seller to open the Co-pilot tab and press Refresh insights." };
    return {
      data: { as_of: rows[0].created_at, insights: rows.map((r) => ({ kind: r.kind, product: r.product_name, theme: r.theme, suggestion: r.suggestion, mentions: r.mentions, example: (r.evidence as Array<{ quote: string }>)[0]?.quote ?? null })) },
      message: `${rows.length} theme(s) from customer chats.`,
    };
  },
  async copilot_briefing(_client, ctx) {
    // Dynamic import: the monitor itself calls this orchestrator.
    const { scanSeller } = await import("../copilot/monitor");
    const scan = await scanSeller(ctx.user, "voice");
    return { data: { top: scan.alerts.slice(0, 4).map((a) => ({ severity: a.severity, title: a.title, why: a.detail, suggestion: a.suggestion?.label ?? null })), counts: scan.counts }, message: scan.alerts.length ? `${scan.alerts.length} thing(s) the co-pilot spotted.` : "The co-pilot sees nothing urgent." };
  },
  async list_purchase_orders(client, ctx) {
    const rows = await listPurchaseOrders(client, ctx.user.id);
    return { data: { purchase_orders: rows.slice(0, 8) }, message: `${rows.filter((r) => r.state === "sent" || r.state === "confirmed").length} purchase order(s) on the way.` };
  },
  async business_summary(client, ctx) {
    const data = await summaryFor(client, ctx.user.id);
    return { data, message: "Business summary ready." };
  },
};

/** Lookups that do not change data. A batch of only these may run together. */
export const READ_TOOL_NAMES = new Set(Object.keys(readTools));

async function summaryFor(client: pg.PoolClient, sellerId: string) {
  await ensureOrderNumbers(client, sellerId);
  const orders = (await client.query(`${ORDER_SELECT} WHERE o.seller_id = $1`, [sellerId])).rows.map(normRow);
  const low = await client.query("SELECT count(*)::int AS n FROM products WHERE seller_id = $1 AND stock <= $2", [sellerId, policy.LOW_STOCK_DEFAULT]);
  const returns = await client.query("SELECT count(*)::int AS n FROM voiceops_returns WHERE seller_id = $1 AND state = 'requested'", [sellerId]);
  const pending = await client.query("SELECT count(*)::int AS n FROM voiceops_approvals WHERE user_id = $1 AND state = 'pending' AND expires_at > now()", [sellerId]);
  return {
    awaiting_dispatch: orders.filter((o) => o.status === "placed" || o.status === "packed").length,
    delayed: orders.filter((o) => policy.isDelayed(o.status, o.created_at)).map((o) => o.order_no),
    low_stock_products: low.rows[0].n,
    open_returns: returns.rows[0].n,
    pending_approvals: pending.rows[0].n,
    total_orders: orders.length,
  };
}

// ---------------------------------------------------------------------------
// Gemini function declarations
// ---------------------------------------------------------------------------

const orderNo = { type: "integer", description: "The 4-digit order number the seller says, e.g. 1042." };
export const toolDeclarations = [
  { name: "business_summary", description: "Counts of orders awaiting dispatch, delayed orders, low stock, open returns and pending approvals.", parameters: { type: "object", properties: {} } },
  { name: "list_orders", description: "List the seller's orders. Use delayed_only for orders not dispatched within 24 hours.", parameters: { type: "object", properties: { status: { type: "string", enum: [...ORDER_STATUSES] }, delayed_only: { type: "boolean" }, limit: { type: "integer" } } } },
  { name: "get_order", description: "Details of one order, including any return.", parameters: { type: "object", properties: { order_no: orderNo }, required: ["order_no"] } },
  { name: "list_low_stock", description: "Products at or below a stock threshold (default 5).", parameters: { type: "object", properties: { threshold: { type: "integer" } } } },
  { name: "update_order_status", description: "Move an order one step forward: packed, shipped or delivered. Needs seller approval; read the returned readback aloud and wait.", parameters: { type: "object", properties: { order_no: orderNo, status: { type: "string", enum: ["packed", "shipped", "delivered"] }, courier: { type: "string" }, awb: { type: "string" } }, required: ["order_no", "status"] } },
  { name: "cancel_order", description: "Cancel an order that is not yet shipped. Fails for shipped or delivered orders; then offer to message the customer instead.", parameters: { type: "object", properties: { order_no: orderNo }, required: ["order_no"] } },
  { name: "create_return", description: "Start a return for a delivered order inside the 7-day window. Never refunds money. The reason is optional; do not ask for one if the seller did not give it.", parameters: { type: "object", properties: { order_no: orderNo, reason: { type: "string", description: "Optional. Defaults to a seller-initiated return." } }, required: ["order_no"] } },
  { name: "send_customer_message", description: "Send a short message to the customer in their order conversation. Draft the text yourself in the customer's language.", parameters: { type: "object", properties: { order_no: orderNo, message: { type: "string" }, language: { type: "string" } }, required: ["order_no", "message"] } },
  { name: "adjust_stock", description: "Change a product's stock by delta, or set it to an exact number.", parameters: { type: "object", properties: { product_name: { type: "string" }, delta: { type: "integer" }, set_to: { type: "integer" } }, required: ["product_name"] } },
  { name: "run_agent_team", description: "Ask the team of AI agents (supervisor, comms, inventory, support triage) to check the whole shop and propose actions. Use when the seller asks the team to look after things, or for a full check. Their proposals still need the seller's approval.", parameters: { type: "object", properties: {} } },
  { name: "make_offer", description: "Offer the customer a special (lower) price on an order that has not shipped. Needs approval. The buyer accepts or declines in the order chat.", parameters: { type: "object", properties: { order_no: orderNo, amount: { type: "integer", description: "New total in rupees, lower than the current price." }, note: { type: "string" } }, required: ["order_no", "amount"] } },
  { name: "notify_delayed_customers", description: "Send ONE delay update to every delayed customer (or to the given order numbers) with a single approval. Draft a short, polite message without names; each customer's first name is added automatically.", parameters: { type: "object", properties: { message: { type: "string" }, order_nos: { type: "array", items: { type: "integer" } }, language: { type: "string" } }, required: ["message"] } },
  { name: "request_human_review", description: "Escalate when the request is unclear, out of policy or risky.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "copilot_briefing", description: "What the proactive co-pilot sees right now: predicted stockouts, orders at risk of missing dispatch, stuck shipments, each with a suggested next step. Use at session start and for 'kya dhyan dena hai'.", parameters: { type: "object", properties: {} } },
  { name: "forecast_stock", description: "Predict when products run out from recent sales, with days left, supplier lead time and a suggested order quantity. Give product_name for one product.", parameters: { type: "object", properties: { product_name: { type: "string" } } } },
  { name: "sla_risk", description: "Open orders that are late or likely to miss the 24 h dispatch promise, with how many hours are left.", parameters: { type: "object", properties: {} } },
  { name: "track_shipment", description: "Courier tracking for one shipped order (order_no), or every parcel in transit, including stuck ones.", parameters: { type: "object", properties: { order_no: orderNo } } },
  { name: "chat_insights", description: "Themes from customer chats (complaints, requests, praise) per product, with suggestions.", parameters: { type: "object", properties: {} } },
  { name: "list_purchase_orders", description: "Recent purchase orders to suppliers and their status.", parameters: { type: "object", properties: {} } },
  { name: "create_purchase_order", description: "Restock from the product's supplier. Quantity is optional: without it the forecast's suggested quantity is used. Needs approval.", parameters: { type: "object", properties: { product_name: { type: "string" }, quantity: { type: "integer" } }, required: ["product_name"] } },
  { name: "reroute_shipment", description: "Re-book a stuck parcel with another courier (optionally a named one). Only for shipped orders whose tracking shows them stuck. Needs approval.", parameters: { type: "object", properties: { order_no: orderNo, courier: { type: "string" } }, required: ["order_no"] } },
  { name: "issue_refund", description: "Propose a refund for a delivered order (amount optional, default the full amount paid). CRITICAL: only the seller's tap on Approve can execute it; a spoken yes never does.", parameters: { type: "object", properties: { order_no: orderNo, amount: { type: "integer" }, reason: { type: "string" } }, required: ["order_no"] } },
  { name: "confirm_action", description: "Call ONLY after the seller clearly said yes to the exact read-back. Pass their words in user_words.", parameters: { type: "object", properties: { approval_id: { type: "string" }, user_words: { type: "string" } }, required: ["approval_id", "user_words"] } },
  { name: "reject_action", description: "Call when the seller says no or changes their mind about a pending approval.", parameters: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] } },
  { name: "undo_action", description: "Undo the seller's most recent undoable action, or a specific action_id.", parameters: { type: "object", properties: { action_id: { type: "string" } } } },
];

// ---------------------------------------------------------------------------
// Audit helpers and public API
// ---------------------------------------------------------------------------

export async function startSession(user: UserRecord, languageHint: string | null = null): Promise<string> {
  assertSeller(user);
  const sessionId = id("vs");
  await getPool().query("INSERT INTO voiceops_sessions (id, user_id, language_hint) VALUES ($1, $2, $3)", [sessionId, user.id, languageHint]);
  return sessionId;
}

export async function endSession(user: UserRecord, sessionId: string, usage?: { inputAudioSeconds?: number; outputAudioSeconds?: number; inputTokens?: number; outputTokens?: number; latencies?: number[] }): Promise<void> {
  await getPool().query(
    `UPDATE voiceops_sessions SET ended_at = now(),
       input_audio_seconds = input_audio_seconds + $3, output_audio_seconds = output_audio_seconds + $4,
       input_tokens = input_tokens + $5, output_tokens = output_tokens + $6, latencies = $7::jsonb
      WHERE id = $1 AND user_id = $2`,
    [sessionId, user.id, usage?.inputAudioSeconds ?? 0, usage?.outputAudioSeconds ?? 0, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, JSON.stringify(usage?.latencies ?? [])],
  );
}

async function ownSession(ctx: Ctx): Promise<void> {
  const res = await getPool().query("SELECT 1 FROM voiceops_sessions WHERE id = $1 AND user_id = $2", [ctx.sessionId, ctx.user.id]);
  if (!res.rowCount) throw new HttpError(404, "NOT_FOUND", "Voice session not found.");
}

async function record(
  ctx: Ctx, tool: string, args: unknown, status: string,
  extra: { result?: unknown; code?: string; human?: boolean; undoOf?: string; ms: number },
): Promise<string> {
  const actionId = id("act");
  await getPool().query(
    `INSERT INTO voiceops_actions (id, session_id, user_id, tool, args, result, status, error_code, human_involved, undo_of, latency_ms)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`,
    [actionId, ctx.sessionId, ctx.user.id, tool, JSON.stringify(args ?? {}), extra.result === undefined ? null : JSON.stringify(extra.result), status, extra.code ?? null, extra.human ?? false, extra.undoOf ?? null, extra.ms],
  );
  return actionId;
}

/** Facts the reasoning engine needs for a proposal (read-only; failures become "not found" facts). */
async function gatherFacts(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<Facts> {
  const facts: Facts = { args };
  const client = await getPool().connect();
  try {
    if (args.order_no !== undefined) {
      try {
        const o = await loadOrder(client, ctx.user.id, args.order_no);
        const extra = (await client.query(
          `SELECT o.original_total, o.offer_state, EXISTS (SELECT 1 FROM voiceops_returns r WHERE r.order_id = o.id AND r.state = 'requested') AS open_return
             FROM orders o WHERE o.id = $1`, [o.id])).rows[0] ?? {};
        facts.order = { order_no: o.order_no, status: o.status, customer: o.buyer_name, total: o.total, created_at: o.created_at, updated_at: o.updated_at, owned: true,
          open_return: Boolean(extra.open_return), original_total: extra.original_total === null || extra.original_total === undefined ? null : Number(extra.original_total), offer_state: extra.offer_state ?? null };
      } catch {
        facts.order = { order_no: Number(args.order_no), status: "unknown", customer: "?", total: 0, created_at: new Date().toISOString(), updated_at: null, owned: false };
      }
    }
    if (name === "adjust_stock") {
      try {
        const p = await findProduct(client, ctx.user.id, args);
        facts.product = { name: p.name, stock: Number(p.stock), found: true, matches: 1 };
      } catch {
        facts.product = { name: String(args.product_name ?? ""), stock: 0, found: false };
      }
    }
    if (name === "create_purchase_order") {
      try {
        const p = await findProduct(client, ctx.user.id, args);
        const f = (await loadForecasts(client, ctx.user.id)).find((x) => x.product_id === p.id);
        facts.product = { name: p.name, stock: Number(p.stock), found: true, matches: 1 };
        if (f) facts.forecast = { status: f.status, reason: f.reason, suggested_qty: f.suggested_qty, supplier: f.supplier?.name ?? null, unit_cost: f.supplier?.unit_cost ?? 0, min_order_qty: f.supplier?.min_order_qty ?? 1 };
      } catch {
        facts.product = { name: String(args.product_name ?? ""), stock: 0, found: false };
      }
    }
    if (name === "reroute_shipment" && facts.order?.owned) {
      const o = await loadOrder(client, ctx.user.id, args.order_no);
      const { health } = await shipmentFor(client, o.id);
      facts.shipment = health ? { stuck: health.stuck, reason: health.reason, courier: health.courier, awb: health.awb } : null;
    }
    if (name === "issue_refund" && facts.order?.owned) {
      const o = await loadOrder(client, ctx.user.id, args.order_no);
      facts.refunded = (await refundFacts(client, o.id)).refunded;
    }
    if (name === "notify_delayed_customers") {
      await ensureOrderNumbers(client, ctx.user.id);
      const rows = (await client.query(`${ORDER_SELECT} WHERE o.seller_id = $1`, [ctx.user.id])).rows.map(normRow);
      const wanted = Array.isArray(args.order_nos) && args.order_nos.length ? new Set(args.order_nos.map(Number)) : null;
      facts.delayedCount = rows.filter((r) => policy.isDelayed(r.status, r.created_at) && (!wanted || wanted.has(r.order_no))).length;
    }
  } finally {
    client.release();
  }
  return facts;
}

export async function runTool(ctx: Ctx, name: string, rawArgs: unknown): Promise<ToolResult> {
  assertSeller(ctx.user);
  await ownSession(ctx);
  const started = Date.now();
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  let trace: Trace | undefined;
  try {
    if (name === "confirm_action") {
      return await decideApproval(ctx, String(args.approval_id ?? ""), "approve", "voice", String(args.user_words ?? ""));
    }
    if (name === "reject_action") return await decideApproval(ctx, String(args.approval_id ?? ""), "reject", "voice", "");
    if (name === "undo_action") return await undoAction(ctx, typeof args.action_id === "string" ? args.action_id : null);

    const read = readTools[name];
    if (read) {
      const out = await tx((client) => read(client, ctx, args));
      const ms = Date.now() - started;
      trace = buildTrace(name, { args });
      const actionId = await record(ctx, name, args, "succeeded", { result: out.data, ms });
      return { ok: true, status: "succeeded", actionId, message: out.message, data: out.data, latencyMs: ms, trace };
    }
    const write = writeTools[name];
    if (!write) throw new ToolError("UNKNOWN_TOOL", `There is no tool called ${name}.`);
    trace = buildTrace(name, await gatherFacts(ctx, name, args));

    const prepared = await tx((client) => write.prepare(client, ctx, args));
    const hash = hashArgs(ctx.user.id, name, prepared.args);
    const existing = await getPool().query(
      `SELECT id, readback, expires_at, state, decided_at, tier FROM voiceops_approvals
        WHERE user_id = $1 AND args_hash = $2 AND (state = 'pending' AND expires_at > now() OR (state = 'executed' AND decided_at > now() - interval '2 minutes'))
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.user.id, hash],
    );
    if (existing.rows[0]?.state === "executed") {
      throw new ToolError("DUPLICATE_ACTION", "That exact action was just completed. Ask if they want it done again.");
    }
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const ms = Date.now() - started;
      const actionId = await record(ctx, name, prepared.args, "awaiting_approval", { result: { duplicate_of: row.id }, ms });
      return { ok: true, status: "awaiting_approval", actionId, message: `Already waiting for approval: ${row.readback}`, approval: { id: row.id, readback: row.readback, expiresAt: new Date(row.expires_at).toISOString(), duplicate: true, tier: row.tier }, latencyMs: ms };
    }
    const approvalId = id("apr");
    const expiresAt = new Date(Date.now() + policy.APPROVAL_TTL_MS).toISOString();
    const ms = Date.now() - started;
    const { tier, reason: tierReason } = policy.approvalTierFor(name, prepared.args);
    const readback = tier === "critical" ? `${prepared.readback} Critical action (${tierReason.replace(/\.$/, "")}): tap Approve on screen; a spoken yes is not accepted.` : prepared.readback;
    if (trace) trace = { ...trace, checks: trace.checks.map((c) => (c.rule === "Human approval before any change" ? { ...c, detail: tier === "critical" ? `Critical: ${tierReason} Only a tap on Approve executes it; a spoken yes and the model's yes do not count.` : c.detail } : c)) };
    const actionId = await record(ctx, name, prepared.args, "awaiting_approval", { ms, result: { trace, tier } });
    await getPool().query(
      `INSERT INTO voiceops_approvals (id, session_id, user_id, tool, args, args_hash, readback, expires_at, action_id, tier)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [approvalId, ctx.sessionId, ctx.user.id, name, JSON.stringify(prepared.args), hash, readback, expiresAt, actionId, tier],
    );
    return {
      ok: true, status: "awaiting_approval", actionId, approval: { id: approvalId, readback, expiresAt, tier },
      message: tier === "critical"
        ? `Read this back, then ask the seller to TAP Approve on screen (a spoken yes cannot approve this): ${readback}`
        : `Read this back to the seller and wait for a clear yes: ${readback}`,
      latencyMs: ms, trace,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const ms = Date.now() - started;
    if (error instanceof ToolError) {
      const actionId = await record(ctx, name, args, error.kind, { code: error.code, result: { message: error.message, trace }, ms });
      return { ok: false, status: error.kind, actionId, code: error.code, message: error.message, latencyMs: ms, trace };
    }
    console.error(`VoiceOps tool ${name} failed:`, error);
    const actionId = await record(ctx, name, args, "failed", { code: "INTERNAL", ms });
    return { ok: false, status: "failed", actionId, code: "INTERNAL", message: "Something went wrong on our side. Nothing was changed.", latencyMs: ms };
  }
}

export async function decideApproval(
  ctx: Ctx, approvalId: string, decision: "approve" | "reject", via: "tap" | "voice", utterance = "",
): Promise<ToolResult> {
  assertSeller(ctx.user);
  const started = Date.now();
  const fail = async (code: string, message: string, status: "blocked" | "failed" = "blocked"): Promise<ToolResult> => {
    const ms = Date.now() - started;
    const actionId = await record(ctx, "confirm_action", { approval_id: approvalId }, status, { code, result: { message }, ms });
    return { ok: false, status, actionId, code, message, latencyMs: ms };
  };

  if (decision === "approve" && via === "voice") {
    const pending = (await getPool().query("SELECT tool, tier FROM voiceops_approvals WHERE id = $1 AND user_id = $2", [approvalId, ctx.user.id])).rows[0];
    if (pending && (pending.tier === "critical" || policy.approvalTier(pending.tool) === "critical")) {
      return fail("CRITICAL_NEEDS_TAP", "This is a critical action (refund, cancellation, price change or a large change), so only a tap on the Approve button approves it, never voice. Ask the seller to tap Approve.");
    }
    if (!policy.isAffirmative(utterance)) return fail("NOT_CONFIRMED", "That was not a clear yes. Ask again, or use the Approve button.");
  }
  const decided = await getPool().query(
    `UPDATE voiceops_approvals SET state = $3, decided_via = $4, decided_at = now()
      WHERE id = $1 AND user_id = $2 AND state = 'pending' AND expires_at > now() RETURNING *`,
    [approvalId, ctx.user.id, decision === "approve" ? "approved" : "rejected", via],
  );
  const row = decided.rows[0];
  if (!row) {
    await getPool().query("UPDATE voiceops_approvals SET state = 'expired' WHERE id = $1 AND user_id = $2 AND state = 'pending' AND expires_at <= now()", [approvalId, ctx.user.id]);
    return fail("APPROVAL_NOT_PENDING", "That approval is not waiting any more (expired, already handled, or unknown).");
  }
  const actionCtx = { ...ctx, sessionId: row.session_id };
  if (decision === "reject") {
    await getPool().query("UPDATE voiceops_actions SET status = 'blocked', error_code = 'REJECTED_BY_HUMAN', human_involved = true WHERE id = $1", [row.action_id]);
    const ms = Date.now() - started;
    return { ok: true, status: "blocked", actionId: row.action_id, code: "REJECTED_BY_HUMAN", message: "Okay, cancelled. Nothing was changed.", latencyMs: ms };
  }

  const tool = writeTools[row.tool];
  try {
    const executed = await tx(async (client) => {
      const claimed = await client.query("INSERT INTO voiceops_idempotency (key, user_id, result) VALUES ($1,$2,'{}'::jsonb) ON CONFLICT DO NOTHING", [`approval:${approvalId}`, ctx.user.id]);
      if (!claimed.rowCount) throw new ToolError("ALREADY_EXECUTED", "That approval was already executed.");
      const out = await tool.execute(client, actionCtx, row.args);
      await client.query("UPDATE voiceops_idempotency SET result = $2::jsonb WHERE key = $1", [`approval:${approvalId}`, JSON.stringify({ data: out.data })]);
      for (const n of out.notify ?? []) {
        await client.query("INSERT INTO voiceops_notifications (id, order_id, seller_id, language, body, action_id) VALUES ($1,$2,$3,$4,$5,$6)", [id("ntf"), n.orderId, ctx.user.id, n.language ?? null, n.text, row.action_id]);
      }
      return out;
    });
    await getPool().query("UPDATE voiceops_approvals SET state = 'executed' WHERE id = $1", [approvalId]);
    await getPool().query(
      "UPDATE voiceops_actions SET status = 'succeeded', result = $2::jsonb, human_involved = true, latency_ms = COALESCE(latency_ms,0) + $3 WHERE id = $1",
      [row.action_id, JSON.stringify({ data: executed.data, undo: executed.undo ?? null }), Date.now() - started],
    );
    for (const n of executed.notify ?? []) {
      const sent = await ctx.notifier(n.channelId, n.text, { orderId: n.orderId, card: n.card }).catch(() => false);
      await getPool().query("UPDATE voiceops_notifications SET delivery = $2 WHERE action_id = $1 AND order_id = $3 AND body = $4", [row.action_id, sent ? "sent" : "recorded", n.orderId, n.text]);
    }
    const ms = Date.now() - started;
    return { ok: true, status: "succeeded", actionId: row.action_id, message: executed.message, data: executed.data, latencyMs: ms };
  } catch (error) {
    await getPool().query("UPDATE voiceops_approvals SET state = 'rejected' WHERE id = $1", [approvalId]);
    await getPool().query("UPDATE voiceops_actions SET status = $2, error_code = $3, human_involved = true WHERE id = $1", [row.action_id, error instanceof ToolError ? "blocked" : "failed", error instanceof ToolError ? error.code : "INTERNAL"]);
    if (error instanceof ToolError) return { ok: false, status: "blocked", actionId: row.action_id, code: error.code, message: error.message, latencyMs: Date.now() - started };
    console.error("VoiceOps execute failed:", error);
    return { ok: false, status: "failed", actionId: row.action_id, code: "INTERNAL", message: "Something went wrong on our side. Nothing was changed.", latencyMs: Date.now() - started };
  }
}

export async function undoAction(ctx: Ctx, actionId: string | null): Promise<ToolResult> {
  assertSeller(ctx.user);
  const started = Date.now();
  const res = actionId
    ? await getPool().query("SELECT * FROM voiceops_actions WHERE id = $1 AND user_id = $2", [actionId, ctx.user.id])
    : await getPool().query("SELECT * FROM voiceops_actions WHERE user_id = $1 AND status = 'succeeded' AND result->'undo' IS NOT NULL AND result->>'undo' <> 'null' ORDER BY created_at DESC LIMIT 1", [ctx.user.id]);
  const action = res.rows[0];
  const undo = action?.result?.undo as Record<string, any> | undefined;
  const block = async (code: string, message: string): Promise<ToolResult> => {
    const ms = Date.now() - started;
    const id2 = await record(ctx, "undo_action", { action_id: actionId }, "blocked", { code, result: { message }, ms });
    return { ok: false, status: "blocked", actionId: id2, code, message, latencyMs: ms };
  };
  if (!action) return block("NOTHING_TO_UNDO", "There is nothing to undo.");
  if (action.status !== "succeeded" || !undo) return block("NOT_UNDOABLE", "That action cannot be undone (for example, a sent message).");
  try {
    const message = await tx(async (client) => {
      const claim = await client.query("UPDATE voiceops_actions SET status = 'undone' WHERE id = $1 AND status = 'succeeded'", [action.id]);
      if (!claim.rowCount) throw new ToolError("NOT_UNDOABLE", "That action was already undone.");
      switch (undo.kind) {
        case "status": {
          const r = await client.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND seller_id = $4 AND status = $3", [undo.order_id, undo.from, undo.to, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STATE_CHANGED", "The order has changed since, so it cannot be undone safely.");
          return `Order ${undo.order_no} is back to ${undo.from}.`;
        }
        case "cancel": {
          const r = await client.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND seller_id = $3 AND status = 'cancelled'", [undo.order_id, undo.previous, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STATE_CHANGED", "The order has changed since, so it cannot be undone safely.");
          for (const item of undo.items as Array<{ product_id: string; quantity: number }>) {
            const s = await client.query("UPDATE products SET stock = stock - $2 WHERE id = $1 AND seller_id = $3 AND stock >= $2", [item.product_id, item.quantity, ctx.user.id]);
            if (!s.rowCount) throw new ToolError("STOCK_CHANGED", "Stock has changed since, so the cancellation cannot be reversed automatically.");
          }
          return `Order ${undo.order_no} is restored.`;
        }
        case "return": {
          const r = await client.query("UPDATE voiceops_returns SET state = 'cancelled' WHERE id = $1 AND seller_id = $2 AND state = 'requested'", [undo.return_id, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STATE_CHANGED", "The return has changed since.");
          return "The return request is cancelled.";
        }
        case "offer": {
          const r = await client.query(
            "UPDATE orders SET offer_id = NULL, offer_amount = NULL, offer_note = NULL, offer_state = NULL, total = COALESCE(original_total, total), updated_at = now() WHERE id = $1 AND seller_id = $2 AND offer_id = $3 AND offer_state = 'open'",
            [undo.order_id, ctx.user.id, undo.offer_id],
          );
          if (!r.rowCount) throw new ToolError("STATE_CHANGED", "The buyer has already answered that offer, so it cannot be withdrawn.");
          return "The offer is withdrawn.";
        }
        case "stock": {
          const r = await client.query("UPDATE products SET stock = stock - $2 WHERE id = $1 AND seller_id = $3 AND stock - $2 >= 0", [undo.product_id, undo.delta, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STOCK_CHANGED", "Stock has changed since, so it cannot be reversed safely.");
          return "Stock change reversed.";
        }
        case "po": {
          const r = await client.query("UPDATE purchase_orders SET state = 'cancelled', updated_at = now() WHERE id = $1 AND seller_id = $2 AND state IN ('sent','confirmed')", [undo.po_id, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STATE_CHANGED", "That purchase order has already been received, so it cannot be cancelled here.");
          return "The purchase order is cancelled with the supplier.";
        }
        default:
          throw new ToolError("NOT_UNDOABLE", "That action cannot be undone.");
      }
    });
    const ms = Date.now() - started;
    const id2 = await record(ctx, "undo_action", { action_id: action.id }, "succeeded", { result: { message }, human: true, undoOf: action.id, ms });
    return { ok: true, status: "succeeded", actionId: id2, message, latencyMs: ms };
  } catch (error) {
    if (error instanceof ToolError) return block(error.code, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

export async function overview(user: UserRecord) {
  assertSeller(user);
  const client = await getPool().connect();
  try {
    const summary = await summaryFor(client, user.id);
    const stats = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE human_involved)::int AS human,
              count(*) FILTER (WHERE status = 'succeeded' AND NOT human_involved)::int AS auto_ok,
              count(*) FILTER (WHERE status = 'succeeded' AND human_involved)::int AS human_ok,
              COALESCE(round(avg(latency_ms))::int, 0) AS avg_latency_ms
         FROM voiceops_actions WHERE user_id = $1 AND tool NOT IN ('confirm_action','reject_action')`,
      [user.id],
    );
    return { summary, activity: stats.rows[0], usage: await usageFor(client, user.id) };
  } finally {
    client.release();
  }
}

/**
 * Measured usage plus clearly-labelled assumptions. Latency, audio minutes and counts come from the
 * database. Cost uses Gemini list rates (overridable via GEMINI_COST_IN_PER_MIN / GEMINI_COST_OUT_PER_MIN).
 * The manual-time baseline per task is the median of timed manual runs (voiceops_baselines, pooled across
 * sellers) when any exist; otherwise it falls back to the assumption below and is reported as "assumed".
 */
export const ASSUMED_MANUAL_SECONDS: Record<string, number> = {
  update_order_status: 90, cancel_order: 120, create_return: 240, send_customer_message: 150, adjust_stock: 90,
  make_offer: 120,
  /** One batch of delay updates; the manual way is one chat per delayed customer (about three in a typical day). */
  notify_delayed_customers: 450,
  /** Check stock, call or message the supplier, agree quantity and price. */
  create_purchase_order: 300,
  /** Read tracking, call the courier, book another one, share the new tracking number. */
  reroute_shipment: 480,
  /** Look up the payment, issue the refund, tell the customer. */
  issue_refund: 240,
};
export const BASELINE_TASKS = Object.keys(ASSUMED_MANUAL_SECONDS);
const isMissingTable = (error: unknown) => (error as { code?: string })?.code === "42P01";
const NOT_MIGRATED = () => new HttpError(503, "NOT_MIGRATED", "Manual timing needs a database update (migration 007). Ask the admin to run npm run db:migrate.");

/** Store one timed manual run of a task (the seller did it by hand while a stopwatch ran). */
export async function recordBaseline(user: UserRecord, input: { task?: unknown; seconds?: unknown; taps?: unknown; keys?: unknown }) {
  assertSeller(user);
  const task = String(input.task ?? "");
  const seconds = Number(input.seconds);
  const taps = Number(input.taps ?? 0);
  const keys = Number(input.keys ?? 0);
  if (!BASELINE_TASKS.includes(task)) throw new HttpError(422, "VALIDATION_ERROR", "Choose one of the listed tasks.");
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 1800) throw new HttpError(422, "VALIDATION_ERROR", "A timed run must last between 3 seconds and 30 minutes.");
  if (!Number.isInteger(taps) || taps < 0 || taps > 1000 || !Number.isInteger(keys) || keys < 0 || keys > 20000) {
    throw new HttpError(422, "VALIDATION_ERROR", "Tap and key counts must be whole numbers.");
  }
  const baselineId = id("bl_");
  try {
    await getPool().query("INSERT INTO voiceops_baselines (id, user_id, task, seconds, taps, keys) VALUES ($1,$2,$3,$4,$5,$6)", [baselineId, user.id, task, seconds, taps, keys]);
  } catch (error) {
    if (isMissingTable(error)) throw NOT_MIGRATED();
    throw error;
  }
  return { id: baselineId, task, seconds, taps, keys };
}

/** Timed manual runs by this seller (newest first), for review and deletion. */
export async function listBaselines(user: UserRecord) {
  assertSeller(user);
  const res = await getPool()
    .query("SELECT id, task, seconds, taps, keys, created_at FROM voiceops_baselines WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200", [user.id])
    .catch((error) => { if (isMissingTable(error)) return { rows: [] as any[] }; throw error; });
  return res.rows.map((r) => ({ ...r, seconds: Number(r.seconds) }));
}

export async function deleteBaseline(user: UserRecord, baselineId: string) {
  assertSeller(user);
  const res = await getPool().query("DELETE FROM voiceops_baselines WHERE id = $1 AND user_id = $2", [baselineId, user.id]);
  if (!res.rowCount) throw new HttpError(404, "NOT_FOUND", "That timing was not found.");
  return { ok: true };
}

export type BaselineRow = { task: string; seconds: number; taps: number | null; keys: number | null; runs: number; source: "measured" | "assumed" };

/** Median manual seconds/taps/keys per task over every seller's timed runs; assumption where none exist. */
async function baselineTable(client: pg.PoolClient): Promise<BaselineRow[]> {
  // Until migration 007 has run, the table is missing: report every task as assumed instead of failing Overview.
  let rows: any[] = [];
  try {
    rows = (await client.query(
      `SELECT task, count(*)::int AS runs,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS seconds,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY taps) AS taps,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY keys) AS keys
         FROM voiceops_baselines GROUP BY task`,
    )).rows;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  const measured = new Map(rows.map((r) => [r.task as string, r]));
  return BASELINE_TASKS.map((task) => {
    const m = measured.get(task);
    return m
      ? { task, seconds: Math.round(Number(m.seconds)), taps: Math.round(Number(m.taps)), keys: Math.round(Number(m.keys)), runs: m.runs, source: "measured" as const }
      : { task, seconds: ASSUMED_MANUAL_SECONDS[task], taps: null, keys: null, runs: 0, source: "assumed" as const };
  });
}

async function usageFor(client: pg.PoolClient, sellerId: string) {
  const sessions = (await client.query("SELECT input_audio_seconds, output_audio_seconds, latencies FROM voiceops_sessions WHERE user_id = $1 ORDER BY started_at", [sellerId])).rows;
  // Most recent reply times in the order they happened, for the dashboard's latency chart.
  const recent = sessions.flatMap((s) => ((s.latencies as number[]) ?? []).map(Number)).slice(-40);
  const lat = sessions.flatMap((s) => (s.latencies as number[]) ?? []).map(Number).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
  const inMin = sessions.reduce((a, s) => a + Number(s.input_audio_seconds), 0) / 60;
  const outMin = sessions.reduce((a, s) => a + Number(s.output_audio_seconds), 0) / 60;
  const writes = Object.keys(ASSUMED_MANUAL_SECONDS);
  const rows = (await client.query("SELECT tool, status, count(*)::int n FROM voiceops_actions WHERE user_id = $1 AND tool = ANY($2) GROUP BY tool, status", [sellerId, writes])).rows;
  const completed = rows.filter((r) => r.status === "succeeded" || r.status === "undone");
  const attempted = rows.filter((r) => ["succeeded", "undone", "blocked", "failed"].includes(r.status));
  const nCompleted = completed.reduce((a, r) => a + r.n, 0);
  // Defaults are Google's published paid-tier list price for Gemini 3.8 Live audio (USD per minute), checked
  // 2026-11-13 at aistudio.google.com/docs/pricing. Override with GEMINI_COST_IN_PER_MIN / GEMINI_COST_OUT_PER_MIN.
  // This is an audio-minutes estimate: text tokens for prompts and tool calls are not included.
  const rateIn = process.env.GEMINI_COST_IN_PER_MIN ? Number(process.env.GEMINI_COST_IN_PER_MIN) : 0.005;
  const rateOut = process.env.GEMINI_COST_OUT_PER_MIN ? Number(process.env.GEMINI_COST_OUT_PER_MIN) : 0.018;
  const cost = Number.isFinite(rateIn) && Number.isFinite(rateOut) ? inMin * rateIn + outMin * rateOut : null;
  const baseline = await baselineTable(client);
  const byTask = new Map(baseline.map((b) => [b.task, b]));
  const doneByTask = new Map<string, number>();
  for (const r of completed) doneByTask.set(r.tool, (doneByTask.get(r.tool) ?? 0) + r.n);
  let manual = 0;
  let measuredWorkflows = 0;
  let manualTaps = 0;
  for (const [task, n] of doneByTask) {
    const b = byTask.get(task)!;
    manual += n * b.seconds;
    if (b.source === "measured") { measuredWorkflows += n; manualTaps += n * (b.taps ?? 0); }
  }
  // Taps the seller still made in voice workflows (approvals confirmed by tapping instead of speaking),
  // counted over the same tasks as manual_taps so the two numbers compare like for like.
  const measuredTasks = baseline.filter((b) => b.source === "measured").map((b) => b.task);
  const approvals = (await client.query(
    `SELECT count(*) FILTER (WHERE decided_via = 'tap')::int AS tap, count(*) FILTER (WHERE decided_via = 'voice')::int AS voice
       FROM voiceops_approvals WHERE user_id = $1 AND state = 'executed' AND tool = ANY($2)`,
    [sellerId, measuredTasks],
  )).rows[0];
  return {
    sessions: sessions.length,
    input_minutes: Math.round(inMin * 100) / 100,
    output_minutes: Math.round(outMin * 100) / 100,
    latency: { turns: lat.length, p50_ms: pct(50), p95_ms: pct(95), recent_ms: recent },
    workflows_completed: nCompleted,
    workflows_attempted: attempted.reduce((a, r) => a + r.n, 0),
    est_cost_usd: cost,
    est_cost_per_workflow_usd: cost !== null && nCompleted ? cost / nCompleted : null,
    rate_in_per_min_usd: rateIn,
    rate_out_per_min_usd: rateOut,
    /** Manual seconds the completed workflows would have taken (measured medians where available). */
    manual_seconds: manual,
    /** How many completed workflows were priced with a measured (not assumed) baseline. */
    workflows_with_measured_baseline: measuredWorkflows,
    /** Taps the measured manual runs needed for the same completed workflows. */
    manual_taps: manualTaps,
    voice_taps: approvals.tap,
    voice_approvals: approvals.voice,
    voice_seconds: Math.round((inMin + outMin) * 60),
    completed_by_task: Object.fromEntries(doneByTask),
    baseline,
  };
}

/** Audio minutes recorded by sessions that ended today (used as a daily spend kill switch). */
export async function audioMinutesToday(): Promise<number> {
  const res = await getPool().query(
    "SELECT COALESCE(sum(input_audio_seconds + output_audio_seconds), 0) AS s FROM voiceops_sessions WHERE started_at >= date_trunc('day', now())",
  );
  return Number(res.rows[0].s) / 60;
}

export async function listActivity(user: UserRecord, limit = 50) {
  assertSeller(user);
  const res = await getPool().query(
    `SELECT id, session_id, tool, args, result, status, error_code, human_involved, undo_of, latency_ms, created_at
       FROM voiceops_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [user.id, Math.min(Math.max(limit, 1), 200)],
  );
  return res.rows;
}

export async function listApprovals(user: UserRecord, state: string | null = null) {
  assertSeller(user);
  const res = await getPool().query(
    `SELECT id, session_id, tool, args, readback, state, decided_via, created_at, decided_at, expires_at, action_id, tier
       FROM voiceops_approvals WHERE user_id = $1 AND ($2::text IS NULL OR state = $2)
        AND NOT (state = 'pending' AND expires_at <= now())
      ORDER BY created_at DESC LIMIT 100`,
    [user.id, state],
  );
  return res.rows;
}
