/**
 * Co-pilot read models built from the seller's own data: stock forecasts, SLA risk for open orders,
 * shipment health. Read-only; every query is scoped to one seller. Used by orchestrator read tools,
 * the operations monitor and the dashboard.
 */
import type pg from "pg";
import {
  HISTORY_DAYS, dailyBuckets, forecastProduct, median, shipmentHealth, slaRisk,
  type ShipmentEvent, type ShipmentHealth, type SlaRisk, type StockForecast,
} from "./forecast";

export type SupplierInfo = { id: string; name: string; lead_time_days: number; unit_cost: number; min_order_qty: number };
export type ProductForecast = StockForecast & { supplier: SupplierInfo | null };

const SEVERITY: Record<string, number> = { critical: 0, warning: 1, ok: 2, no_demand: 3 };

async function ensureOrderNumbers(client: pg.PoolClient, sellerId: string): Promise<void> {
  await client.query(
    `INSERT INTO voiceops_order_numbers (order_id)
       SELECT id FROM orders WHERE seller_id = $1 AND id NOT IN (SELECT order_id FROM voiceops_order_numbers) ORDER BY created_at
     ON CONFLICT DO NOTHING`,
    [sellerId],
  );
}

export async function supplierFor(client: pg.PoolClient, sellerId: string, productId: string): Promise<SupplierInfo | null> {
  const row = (await client.query(
    `SELECT s.id, s.name, s.lead_time_days, sp.unit_cost, sp.min_order_qty
       FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.product_id = $1 AND s.seller_id = $2`,
    [productId, sellerId],
  )).rows[0];
  return row ? { id: row.id, name: row.name, lead_time_days: Number(row.lead_time_days), unit_cost: Number(row.unit_cost), min_order_qty: Number(row.min_order_qty) } : null;
}

export async function loadForecasts(client: pg.PoolClient, sellerId: string, now = Date.now()): Promise<ProductForecast[]> {
  const products = (await client.query(
    `SELECT p.id, p.name, p.stock, s.id AS supplier_id, s.name AS supplier_name, s.lead_time_days, sp.unit_cost, sp.min_order_qty
       FROM products p
       LEFT JOIN supplier_products sp ON sp.product_id = p.id
       LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.seller_id = p.seller_id
      WHERE p.seller_id = $1 ORDER BY p.name`,
    [sellerId],
  )).rows;
  const since = new Date(now - HISTORY_DAYS * 86_400_000).toISOString();
  const sales = (await client.query(
    `SELECT i.product_id, o.created_at, i.quantity
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.seller_id = $1 AND o.status <> 'cancelled' AND o.created_at >= $2`,
    [sellerId, since],
  )).rows;
  const onOrder = new Map<string, number>(
    (await client.query(
      "SELECT product_id, sum(quantity)::int AS q FROM purchase_orders WHERE seller_id = $1 AND state IN ('sent','confirmed') GROUP BY product_id",
      [sellerId],
    )).rows.map((r) => [r.product_id as string, Number(r.q)]),
  );
  const byProduct = new Map<string, Array<{ at: string; quantity: number }>>();
  for (const s of sales) {
    const list = byProduct.get(s.product_id) ?? [];
    list.push({ at: new Date(s.created_at).toISOString(), quantity: Number(s.quantity) });
    byProduct.set(s.product_id, list);
  }
  return products
    .map((p): ProductForecast => {
      const supplier = p.supplier_id
        ? { id: p.supplier_id, name: p.supplier_name, lead_time_days: Number(p.lead_time_days), unit_cost: Number(p.unit_cost), min_order_qty: Number(p.min_order_qty) }
        : null;
      return {
        ...forecastProduct({
          product_id: p.id, name: p.name, stock: Number(p.stock), on_order: onOrder.get(p.id) ?? 0,
          daily: dailyBuckets(byProduct.get(p.id) ?? [], now),
          lead_time_days: supplier?.lead_time_days, min_order_qty: supplier?.min_order_qty, now,
        }),
        supplier,
      };
    })
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9));
}

/** The seller's median hours from order to dispatch over the last 60 days (null without history). */
export async function handlingP50(client: pg.PoolClient, sellerId: string): Promise<{ hours: number | null; samples: number }> {
  const rows = (await client.query(
    `SELECT extract(epoch FROM (shipped_at - created_at)) / 3600 AS h FROM orders
      WHERE seller_id = $1 AND shipped_at IS NOT NULL AND shipped_at > created_at AND created_at > now() - interval '60 days'`,
    [sellerId],
  )).rows.map((r) => Number(r.h));
  return { hours: median(rows), samples: rows.length };
}

export type OrderRisk = SlaRisk & { order_id: string; customer: string; items: string[] };

export async function loadSlaRisks(client: pg.PoolClient, sellerId: string, now = Date.now()): Promise<{ risks: OrderRisk[]; handling: { hours: number | null; samples: number } }> {
  await ensureOrderNumbers(client, sellerId);
  const handling = await handlingP50(client, sellerId);
  const rows = (await client.query(
    `SELECT o.id, n.order_no, o.status, o.created_at, u.name AS customer,
            COALESCE((SELECT json_agg(i.name || ' x' || i.quantity) FROM order_items i WHERE i.order_id = o.id), '[]') AS items
       FROM orders o JOIN voiceops_order_numbers n ON n.order_id = o.id JOIN users u ON u.id = o.buyer_id
      WHERE o.seller_id = $1 AND o.status IN ('placed','packed') ORDER BY o.created_at`,
    [sellerId],
  )).rows;
  const order: Record<string, number> = { late: 0, high: 1, medium: 2, low: 3 };
  const risks = rows
    .map((r) => ({
      ...slaRisk({ order_no: Number(r.order_no), status: r.status, created_at: new Date(r.created_at).toISOString(), handling_p50_hours: handling.hours, now }),
      order_id: r.id as string, customer: r.customer as string, items: r.items as string[],
    }))
    .sort((a, b) => order[a.level] - order[b.level] || b.risk - a.risk);
  return { risks, handling };
}

export type ShipmentView = ShipmentHealth & { order_id: string; order_no: number; customer: string; events: ShipmentEvent[] };

export async function loadShipments(client: pg.PoolClient, sellerId: string, now = Date.now()): Promise<ShipmentView[]> {
  await ensureOrderNumbers(client, sellerId);
  const orders = (await client.query(
    `SELECT o.id, n.order_no, u.name AS customer FROM orders o
       JOIN voiceops_order_numbers n ON n.order_id = o.id JOIN users u ON u.id = o.buyer_id
      WHERE o.seller_id = $1 AND o.status = 'shipped'`,
    [sellerId],
  )).rows;
  if (!orders.length) return [];
  const events = (await client.query(
    "SELECT order_id, courier, awb, status, location, note, at FROM shipment_events WHERE order_id = ANY($1) ORDER BY at",
    [orders.map((o) => o.id)],
  )).rows;
  const out: ShipmentView[] = [];
  for (const o of orders) {
    const list: ShipmentEvent[] = events.filter((e) => e.order_id === o.id).map((e) => ({
      courier: e.courier, awb: e.awb, status: e.status, location: e.location, note: e.note, at: new Date(e.at).toISOString(),
    }));
    const health = shipmentHealth(list, now);
    if (health) out.push({ ...health, order_id: o.id, order_no: Number(o.order_no), customer: o.customer, events: list });
  }
  return out.sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.hours_since_scan - a.hours_since_scan);
}

export async function shipmentFor(client: pg.PoolClient, orderId: string, now = Date.now()): Promise<{ health: ShipmentHealth | null; events: ShipmentEvent[]; city: string }> {
  const events: ShipmentEvent[] = (await client.query(
    "SELECT courier, awb, status, location, note, at FROM shipment_events WHERE order_id = $1 ORDER BY at",
    [orderId],
  )).rows.map((e) => ({ courier: e.courier, awb: e.awb, status: e.status, location: e.location, note: e.note, at: new Date(e.at).toISOString() }));
  return { health: shipmentHealth(events, now), events, city: events[0]?.location ?? "origin" };
}

export async function listPurchaseOrders(client: pg.PoolClient, sellerId: string) {
  const rows = (await client.query(
    `SELECT po.id, po.product_name, po.quantity, po.unit_cost, po.total, po.state, po.supplier_ref, po.eta, po.created_at, s.name AS supplier
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.seller_id = $1 ORDER BY po.created_at DESC LIMIT 20`,
    [sellerId],
  )).rows;
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity), unit_cost: Number(r.unit_cost), total: Number(r.total) }));
}
