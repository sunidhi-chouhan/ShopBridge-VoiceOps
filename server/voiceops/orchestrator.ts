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

export type Notifier = (channelId: string | null, text: string) => Promise<boolean>;
export type Ctx = { user: UserRecord; sessionId: string; notifier: Notifier };

export type ToolResult = {
  ok: boolean;
  status: "succeeded" | "awaiting_approval" | "blocked" | "failed";
  actionId: string;
  message: string;
  data?: unknown;
  code?: string;
  approval?: { id: string; readback: string; expiresAt: string; duplicate?: boolean };
  latencyMs: number;
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
  notify?: Array<{ orderId: string; channelId: string | null; text: string; language?: string | null }>;
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
         awb = CASE WHEN $4::text IS NULL THEN awb ELSE $4 END WHERE id = $1`,
      [order.id, status, (args.courier as string) ?? null, (args.awb as string) ?? null],
    );
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
  { name: "create_return", description: "Start a return for a delivered order inside the 7-day window. Never refunds money.", parameters: { type: "object", properties: { order_no: orderNo, reason: { type: "string" } }, required: ["order_no"] } },
  { name: "send_customer_message", description: "Send a short message to the customer in their order conversation. Draft the text yourself in the customer's language.", parameters: { type: "object", properties: { order_no: orderNo, message: { type: "string" }, language: { type: "string" } }, required: ["order_no", "message"] } },
  { name: "adjust_stock", description: "Change a product's stock by delta, or set it to an exact number.", parameters: { type: "object", properties: { product_name: { type: "string" }, delta: { type: "integer" }, set_to: { type: "integer" } }, required: ["product_name"] } },
  { name: "request_human_review", description: "Escalate when the request is unclear, out of policy or risky.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
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

export async function runTool(ctx: Ctx, name: string, rawArgs: unknown): Promise<ToolResult> {
  assertSeller(ctx.user);
  await ownSession(ctx);
  const started = Date.now();
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
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
      const actionId = await record(ctx, name, args, "succeeded", { result: out.data, ms });
      return { ok: true, status: "succeeded", actionId, message: out.message, data: out.data, latencyMs: ms };
    }
    const write = writeTools[name];
    if (!write) throw new ToolError("UNKNOWN_TOOL", `There is no tool called ${name}.`);

    const prepared = await tx((client) => write.prepare(client, ctx, args));
    const hash = hashArgs(ctx.user.id, name, prepared.args);
    const existing = await getPool().query(
      `SELECT id, readback, expires_at, state, decided_at FROM voiceops_approvals
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
      return { ok: true, status: "awaiting_approval", actionId, message: `Already waiting for approval: ${row.readback}`, approval: { id: row.id, readback: row.readback, expiresAt: new Date(row.expires_at).toISOString(), duplicate: true }, latencyMs: ms };
    }
    const approvalId = id("apr");
    const expiresAt = new Date(Date.now() + policy.APPROVAL_TTL_MS).toISOString();
    const ms = Date.now() - started;
    const actionId = await record(ctx, name, prepared.args, "awaiting_approval", { ms });
    await getPool().query(
      `INSERT INTO voiceops_approvals (id, session_id, user_id, tool, args, args_hash, readback, expires_at, action_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [approvalId, ctx.sessionId, ctx.user.id, name, JSON.stringify(prepared.args), hash, prepared.readback, expiresAt, actionId],
    );
    return {
      ok: true, status: "awaiting_approval", actionId, approval: { id: approvalId, readback: prepared.readback, expiresAt },
      message: `Read this back to the seller and wait for a clear yes: ${prepared.readback}`, latencyMs: ms,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const ms = Date.now() - started;
    if (error instanceof ToolError) {
      const actionId = await record(ctx, name, args, error.kind, { code: error.code, result: { message: error.message }, ms });
      return { ok: false, status: error.kind, actionId, code: error.code, message: error.message, latencyMs: ms };
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

  if (decision === "approve" && via === "voice" && !policy.isAffirmative(utterance)) {
    return fail("NOT_CONFIRMED", "That was not a clear yes. Ask again, or use the Approve button.");
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
      const sent = await ctx.notifier(n.channelId, n.text).catch(() => false);
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
        case "stock": {
          const r = await client.query("UPDATE products SET stock = stock - $2 WHERE id = $1 AND seller_id = $3 AND stock - $2 >= 0", [undo.product_id, undo.delta, ctx.user.id]);
          if (!r.rowCount) throw new ToolError("STOCK_CHANGED", "Stock has changed since, so it cannot be reversed safely.");
          return "Stock change reversed.";
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
 * database. Cost needs your Gemini rates (GEMINI_COST_IN_PER_MIN / GEMINI_COST_OUT_PER_MIN, USD per
 * audio minute); without them cost is null. The manual-time baseline is an assumption (seconds a
 * seller would spend doing the same job by tapping through screens), not a measurement.
 */
export const ASSUMED_MANUAL_SECONDS: Record<string, number> = {
  update_order_status: 90, cancel_order: 120, create_return: 240, send_customer_message: 150, adjust_stock: 90,
};
async function usageFor(client: pg.PoolClient, sellerId: string) {
  const sessions = (await client.query("SELECT input_audio_seconds, output_audio_seconds, latencies FROM voiceops_sessions WHERE user_id = $1", [sellerId])).rows;
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
  const manual = completed.reduce((a, r) => a + r.n * (ASSUMED_MANUAL_SECONDS[r.tool] ?? 0), 0);
  return {
    sessions: sessions.length,
    input_minutes: Math.round(inMin * 100) / 100,
    output_minutes: Math.round(outMin * 100) / 100,
    latency: { turns: lat.length, p50_ms: pct(50), p95_ms: pct(95) },
    workflows_completed: nCompleted,
    workflows_attempted: attempted.reduce((a, r) => a + r.n, 0),
    est_cost_usd: cost,
    est_cost_per_workflow_usd: cost !== null && nCompleted ? cost / nCompleted : null,
    assumed_manual_seconds: manual,
    voice_seconds: Math.round((inMin + outMin) * 60),
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
    `SELECT id, session_id, tool, args, readback, state, decided_via, created_at, decided_at, expires_at, action_id
       FROM voiceops_approvals WHERE user_id = $1 AND ($2::text IS NULL OR state = $2)
        AND NOT (state = 'pending' AND expires_at <= now())
      ORDER BY created_at DESC LIMIT 100`,
    [user.id, state],
  );
  return res.rows;
}
