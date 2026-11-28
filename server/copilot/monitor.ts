/**
 * Operations monitor: the proactive half of the co-pilot.
 *
 * A scan (scheduled every 15 minutes, at voice-session start, or on demand) turns forecasts, SLA risk and
 * courier tracking into alerts. Each alert carries a suggested next step expressed as an orchestrator tool
 * call. Nothing happens on its own: "Prepare" runs that tool through the orchestrator, which applies the
 * same ownership checks, rules, reasoning trace and human approval as a spoken request.
 *
 * Alerts resolve themselves when the condition clears (for example a purchase order puts stock on order).
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { getPool } from "../db/pool";
import { HttpError } from "../errors";
import type { UserRecord } from "../store-types";
import * as orchestrator from "../voiceops/orchestrator";
import { courierConnector } from "./connectors";
import { listPurchaseOrders, loadForecasts, loadShipments, loadSlaRisks } from "./data";
import { listInsights } from "./insights";

const id = (p: string) => `${p}${randomBytes(6).toString("hex")}`;

export type Suggestion = { tool: string; args: Record<string, unknown>; label: string };
type Candidate = { kind: "stockout" | "sla_risk" | "stuck_shipment"; subject: string; severity: "critical" | "warning" | "info"; title: string; detail: string; data: unknown; suggestion: Suggestion | null };
export type AlertView = Candidate & { id: string; state: string; approval_id: string | null; approval_state: string | null; updated_at: string; created_at: string };

/** Messages the monitor suggests. They promise nothing the facts do not support (no dates, no tracking numbers). */
const HEADS_UP = "your order is being prepared and we will share tracking as soon as it ships. Thank you for your patience!";
const LATE_NOTE = "your order is running a little late. We are sorry for the wait and will share tracking as soon as it ships.";

const days = (d: number | null) => (d === null ? "" : d < 1 ? "in under a day" : `in about ${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`);

async function candidates(client: pg.PoolClient, sellerId: string, now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const f of await loadForecasts(client, sellerId, now)) {
    if (f.status !== "critical" && f.status !== "warning") continue;
    out.push({
      kind: "stockout", subject: f.product_id, severity: f.status,
      title: `${f.name} runs out ${days(f.days_of_cover)}`,
      detail: f.supplier ? f.reason : `${f.reason} No supplier is set up for it yet.`,
      data: f,
      suggestion: f.supplier && f.suggested_qty > 0
        ? { tool: "create_purchase_order", args: { product_name: f.name, quantity: f.suggested_qty }, label: `Order ${f.suggested_qty} from ${f.supplier.name}` }
        : null,
    });
  }
  const { risks } = await loadSlaRisks(client, sellerId, now);
  const late = risks.filter((r) => r.level === "late");
  if (late.length) {
    out.push({
      kind: "sla_risk", subject: "late", severity: "critical",
      title: `${late.length} order${late.length > 1 ? "s" : ""} past the 24 h dispatch promise`,
      detail: `Orders ${late.map((r) => r.order_no).join(", ")}. The customers have not heard from you.`,
      data: { orders: late },
      suggestion: { tool: "notify_delayed_customers", args: { message: LATE_NOTE }, label: `Tell ${late.length > 1 ? `all ${late.length}` : "the"} customer${late.length > 1 ? "s" : ""}` },
    });
  }
  for (const r of risks.filter((x) => x.level === "high")) {
    out.push({
      kind: "sla_risk", subject: r.order_id, severity: "warning",
      title: `Order ${r.order_no} may miss today's dispatch`,
      detail: `${r.reason} Pack it first, or let ${r.customer.split(/\s+/)[0]} know.`,
      data: r,
      suggestion: { tool: "send_customer_message", args: { order_no: r.order_no, message: `Hi ${r.customer.split(/\s+/)[0]}, ${HEADS_UP}` }, label: "Send a heads-up" },
    });
  }
  for (const s of (await loadShipments(client, sellerId, now)).filter((x) => x.stuck)) {
    const best = (await courierConnector().quotes({ fromCity: s.last_location ?? "origin", currentCourier: s.courier }))[0];
    out.push({
      kind: "stuck_shipment", subject: s.order_id, severity: "critical",
      title: `Order ${s.order_no} is stuck with ${s.courier}`,
      detail: s.reason,
      data: { ...s, best_alternative: best ?? null },
      suggestion: best ? { tool: "reroute_shipment", args: { order_no: s.order_no, courier: best.courier }, label: `Re-book with ${best.courier} (${best.eta_days} days, INR ${best.cost_inr})` } : null,
    });
  }
  return out;
}

const RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Scan one seller, upsert open alerts, resolve cleared ones. Returns the live alert list. */
export async function scanSeller(user: UserRecord, trigger: "schedule" | "voice" | "dashboard" | "agents", now = Date.now()) {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "The co-pilot is for sellers.");
  const started = Date.now();
  const client = await getPool().connect();
  let raised = 0;
  let resolved = 0;
  try {
    await client.query("BEGIN");
    const found = await candidates(client, user.id, now);
    for (const c of found) {
      const r = await client.query(
        `INSERT INTO copilot_alerts (id, seller_id, kind, subject, severity, title, detail, data, suggestion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT (seller_id, kind, subject) WHERE state IN ('open','proposed')
         DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail, data = EXCLUDED.data,
                       suggestion = CASE WHEN copilot_alerts.state = 'open' THEN EXCLUDED.suggestion ELSE copilot_alerts.suggestion END,
                       updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [id("alr"), user.id, c.kind, c.subject, c.severity, c.title, c.detail, JSON.stringify(c.data), c.suggestion ? JSON.stringify(c.suggestion) : null],
      );
      if (r.rows[0]?.inserted) raised++;
    }
    const keep = found.map((c) => `${c.kind}|${c.subject}`);
    resolved = (await client.query(
      `UPDATE copilot_alerts SET state = 'resolved', updated_at = now()
        WHERE seller_id = $1 AND state IN ('open','proposed') AND NOT ((kind || '|' || subject) = ANY($2))`,
      [user.id, keep],
    )).rowCount ?? 0;
    // A proposal the seller rejected (or let expire) goes back to open, so it can be prepared again.
    await client.query(
      `UPDATE copilot_alerts c SET state = 'open', approval_id = NULL, updated_at = now()
         FROM voiceops_approvals a
        WHERE c.seller_id = $1 AND c.state = 'proposed' AND a.id = c.approval_id
          AND (a.state IN ('rejected','expired') OR (a.state = 'pending' AND a.expires_at <= now()))`,
      [user.id],
    );
    await client.query("INSERT INTO copilot_scans (id, seller_id, trigger, raised, resolved, ms) VALUES ($1,$2,$3,$4,$5,$6)", [id("scn"), user.id, trigger, raised, resolved, Date.now() - started]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const alerts = (await listAlerts(user.id)).filter((a) => a.state === "open" || a.state === "proposed");
  const counts = {
    stockout: alerts.filter((a) => a.kind === "stockout").length,
    sla_risk: alerts.filter((a) => a.kind === "sla_risk").length,
    stuck_shipment: alerts.filter((a) => a.kind === "stuck_shipment").length,
  };
  return { alerts, counts, raised, resolved, ms: Date.now() - started };
}

export async function listAlerts(sellerId: string): Promise<AlertView[]> {
  const rows = (await getPool().query(
    `SELECT c.*, CASE WHEN a.state = 'pending' AND a.expires_at <= now() THEN 'expired' ELSE a.state END AS approval_state
       FROM copilot_alerts c LEFT JOIN voiceops_approvals a ON a.id = c.approval_id
      WHERE c.seller_id = $1 AND (c.state IN ('open','proposed') OR c.updated_at > now() - interval '24 hours')
      ORDER BY (c.state IN ('open','proposed')) DESC, c.updated_at DESC LIMIT 50`,
    [sellerId],
  )).rows;
  return rows
    .map((r) => ({
      id: r.id, kind: r.kind, subject: r.subject, severity: r.severity, title: r.title, detail: r.detail, data: r.data, suggestion: r.suggestion,
      state: r.state, approval_id: r.approval_id, approval_state: r.approval_state ?? null,
      updated_at: new Date(r.updated_at).toISOString(), created_at: new Date(r.created_at).toISOString(),
    }))
    .sort((a, b) => Number(b.state === "open" || b.state === "proposed") - Number(a.state === "open" || a.state === "proposed") || RANK[a.severity] - RANK[b.severity]);
}

/** Turn an alert's suggestion into a real proposal (approval) through the orchestrator. */
export async function proposeFromAlert(user: UserRecord, alertId: string, notifier: orchestrator.Notifier): Promise<orchestrator.ToolResult> {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "The co-pilot is for sellers.");
  const row = (await getPool().query("SELECT * FROM copilot_alerts WHERE id = $1 AND seller_id = $2", [alertId, user.id])).rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "That alert was not found.");
  if (row.state !== "open" && row.state !== "proposed") throw new HttpError(409, "ALERT_CLOSED", "That alert is already resolved.");
  const suggestion = row.suggestion as Suggestion | null;
  if (!suggestion) throw new HttpError(409, "NO_SUGGESTION", "There is no automatic next step for this alert.");
  const sessionId = await orchestrator.startSession(user, "copilot");
  const result = await orchestrator.runTool({ user, sessionId, notifier }, suggestion.tool, suggestion.args);
  if (result.approval) {
    await getPool().query("UPDATE copilot_alerts SET state = 'proposed', approval_id = $3, updated_at = now() WHERE id = $1 AND seller_id = $2", [alertId, user.id, result.approval.id]);
  }
  return result;
}

export async function dismissAlert(user: UserRecord, alertId: string) {
  const r = await getPool().query("UPDATE copilot_alerts SET state = 'dismissed', updated_at = now() WHERE id = $1 AND seller_id = $2 AND state IN ('open','proposed')", [alertId, user.id]);
  if (!r.rowCount) throw new HttpError(404, "NOT_FOUND", "That alert is not open.");
  return { ok: true };
}

/** Everything the Co-pilot tab shows, in one call. */
export async function copilotOverview(user: UserRecord) {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "The co-pilot is for sellers.");
  const client = await getPool().connect();
  try {
    const [forecasts, sla, shipments, purchaseOrders] = [
      await loadForecasts(client, user.id), await loadSlaRisks(client, user.id), await loadShipments(client, user.id), await listPurchaseOrders(client, user.id),
    ];
    const lastScan = (await client.query("SELECT trigger, raised, resolved, ms, created_at FROM copilot_scans WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 1", [user.id])).rows[0] ?? null;
    return {
      alerts: await listAlerts(user.id), forecasts, sla: sla.risks, handling: sla.handling, shipments, purchase_orders: purchaseOrders,
      insights: await listInsights(user.id), last_scan: lastScan,
    };
  } finally {
    client.release();
  }
}

/** Scheduled sweep (Cloud Scheduler): every seller who has orders. */
export async function scanAllSellers(): Promise<{ sellers: number; raised: number; resolved: number; failed: number }> {
  const sellers = (await getPool().query(
    "SELECT u.* FROM users u WHERE u.role = 'volunteer' AND EXISTS (SELECT 1 FROM orders o WHERE o.seller_id = u.id)",
  )).rows as UserRecord[];
  let raised = 0;
  let resolved = 0;
  let failed = 0;
  for (const seller of sellers) {
    try {
      const r = await scanSeller(seller, "schedule");
      raised += r.raised;
      resolved += r.resolved;
    } catch (error) {
      failed++;
      console.error(`Co-pilot scan failed for a seller:`, error instanceof Error ? error.message : error);
    }
  }
  return { sellers: sellers.length, raised, resolved, failed };
}
