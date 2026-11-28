/**
 * Forecasting for the proactive co-pilot. Pure functions, no I/O, unit-tested directly.
 *
 * Stockout: demand per product from the seller's own orders over the last 28 days.
 *   velocity = 0.6 × mean(last 7 days) + 0.4 × mean(28 days)   (recent weeks weigh more)
 *   safety stock = z × σ(daily) × √(lead time)                  (z = 1.65 ≈ 95% service level)
 *   reorder point = velocity × lead time + safety stock
 *   critical: stock (plus anything on order) runs out before a new order could arrive
 *   warning:  at or below the reorder point
 *   suggested quantity covers lead time + 14 days + safety stock, rounded up to the supplier minimum.
 *
 * SLA: an open order must be dispatched within DISPATCH_SLA_HOURS of being placed. The seller's own
 * median placed→shipped time (from shipped history) predicts when this order will go out; a logistic
 * curve turns the projected overrun into a 0–1 risk.
 */

export const HISTORY_DAYS = 28;
export const REVIEW_DAYS = 14;
export const SERVICE_Z = 1.65;
export const DISPATCH_SLA_HOURS = 24;
export const DEFAULT_HANDLING_HOURS = 18;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export type Demand = { velocity: number; sd: number; last7: number; prior21: number; trend: "rising" | "falling" | "steady"; units28: number };

/** `daily[i]` = units sold on day i, oldest first, today last. */
export function demandFromDaily(daily: number[]): Demand {
  const days = daily.slice(-HISTORY_DAYS);
  while (days.length < HISTORY_DAYS) days.unshift(0);
  const last7 = mean(days.slice(-7));
  const prior21 = mean(days.slice(0, -7));
  const avg = mean(days);
  const sd = Math.sqrt(mean(days.map((d) => (d - avg) ** 2)));
  const velocity = 0.6 * last7 + 0.4 * avg;
  const trend = prior21 === 0 ? (last7 > 0 ? "rising" : "steady") : last7 / prior21 > 1.25 ? "rising" : last7 / prior21 < 0.8 ? "falling" : "steady";
  return { velocity, sd, last7, prior21, trend, units28: days.reduce((a, b) => a + b, 0) };
}

/** Bucket sales into days ending today (local to `now`). Sales older than the window are ignored. */
export function dailyBuckets(sales: Array<{ at: string; quantity: number }>, now = Date.now()): number[] {
  const buckets = new Array(HISTORY_DAYS).fill(0) as number[];
  for (const s of sales) {
    const age = Math.floor((now - Date.parse(s.at)) / DAY);
    if (age < 0 || age >= HISTORY_DAYS) continue;
    buckets[HISTORY_DAYS - 1 - age] += s.quantity;
  }
  return buckets;
}

export type StockStatus = "critical" | "warning" | "ok" | "no_demand";
export type StockForecast = {
  product_id: string;
  name: string;
  stock: number;
  on_order: number;
  velocity_per_day: number;
  trend: Demand["trend"];
  units_28d: number;
  days_of_cover: number | null;
  stockout_date: string | null;
  lead_time_days: number;
  safety_stock: number;
  reorder_point: number;
  suggested_qty: number;
  status: StockStatus;
  reason: string;
};

export function forecastProduct(input: {
  product_id: string;
  name: string;
  stock: number;
  on_order?: number;
  daily: number[];
  lead_time_days?: number;
  min_order_qty?: number;
  now?: number;
}): StockForecast {
  const now = input.now ?? Date.now();
  const lead = Math.max(1, input.lead_time_days ?? 4);
  const moq = Math.max(1, input.min_order_qty ?? 1);
  const onOrder = Math.max(0, input.on_order ?? 0);
  const d = demandFromDaily(input.daily);
  const v = d.velocity;
  const safety = SERVICE_Z * d.sd * Math.sqrt(lead);
  const rop = v * lead + safety;
  const effective = input.stock + onOrder;
  const base = {
    product_id: input.product_id, name: input.name, stock: input.stock, on_order: onOrder,
    velocity_per_day: round(v), trend: d.trend, units_28d: d.units28, lead_time_days: lead,
    safety_stock: Math.ceil(safety), reorder_point: Math.ceil(rop),
  };
  if (v < 0.05) {
    return { ...base, days_of_cover: null, stockout_date: null, suggested_qty: 0, status: "no_demand", reason: `No sales in the last ${HISTORY_DAYS} days, so no restock is suggested.` };
  }
  const cover = input.stock / v;
  const stockoutDate = new Date(now + cover * DAY).toISOString();
  const need = Math.max(0, Math.ceil(v * (lead + REVIEW_DAYS) + safety - effective));
  const qty = need === 0 ? 0 : Math.ceil(need / moq) * moq;
  const coverText = `${round(cover, 1)} day${round(cover, 1) === 1 ? "" : "s"}`;
  const pace = `selling about ${round(v, 1)}/day${d.trend !== "steady" ? ` (${d.trend})` : ""}`;
  if (effective < v * lead) {
    return { ...base, days_of_cover: round(cover, 1), stockout_date: stockoutDate, suggested_qty: qty, status: "critical",
      reason: `${input.stock} left, ${pace}: runs out in ${coverText}, before a new order could arrive (${lead}-day lead time)${onOrder ? ` even with ${onOrder} on order` : ""}.` };
  }
  if (effective <= rop) {
    return { ...base, days_of_cover: round(cover, 1), stockout_date: stockoutDate, suggested_qty: qty, status: "warning",
      reason: `${input.stock} left${onOrder ? ` + ${onOrder} on order` : ""}, ${pace}: at the reorder point (${Math.ceil(rop)}). Order now to stay in stock.` };
  }
  return { ...base, days_of_cover: round(cover, 1), stockout_date: stockoutDate, suggested_qty: 0, status: "ok",
    reason: `${coverText} of cover${onOrder ? ` plus ${onOrder} on order` : ""}, ${pace}.` };
}

export type SlaLevel = "late" | "high" | "medium" | "low";
export type SlaRisk = {
  order_no: number;
  status: string;
  age_hours: number;
  hours_left: number;
  projected_dispatch_hours: number;
  risk: number;
  level: SlaLevel;
  reason: string;
};

/** Least time still needed from each stage: packing plus courier pickup, or pickup alone. */
const STAGE_MIN_HOURS: Record<string, number> = { placed: 5, packed: 2 };

export function slaRisk(input: { order_no: number; status: string; created_at: string; handling_p50_hours: number | null; now?: number; sla_hours?: number }): SlaRisk {
  const now = input.now ?? Date.now();
  const sla = input.sla_hours ?? DISPATCH_SLA_HOURS;
  const age = (now - Date.parse(input.created_at)) / HOUR;
  const p50 = input.handling_p50_hours ?? DEFAULT_HANDLING_HOURS;
  const stageMin = STAGE_MIN_HOURS[input.status] ?? 0;
  const remaining = Math.max(stageMin, p50 - age);
  const projected = age + remaining;
  const hoursLeft = sla - age;
  const base = { order_no: input.order_no, status: input.status, age_hours: round(age, 1), hours_left: round(hoursLeft, 1), projected_dispatch_hours: round(projected, 1) };
  if (age > sla) {
    return { ...base, risk: 1, level: "late", reason: `Already ${round(age - sla, 1)} h past the ${sla} h dispatch promise.` };
  }
  const risk = 1 / (1 + Math.exp(-(projected - sla) / 2.5));
  const level: SlaLevel = risk >= 0.6 ? "high" : risk >= 0.3 ? "medium" : "low";
  const why = input.handling_p50_hours === null ? `assumed ${p50} h typical handling` : `your typical ${round(p50, 1)} h from order to dispatch`;
  return {
    ...base, risk: round(risk), level,
    reason: level === "low"
      ? `${round(hoursLeft, 1)} h left; on track (${why}).`
      : `${round(hoursLeft, 1)} h left, still ${input.status}: needs at least ${stageMin} h more, so dispatch is projected at ${round(projected, 1)} h (${why}).`,
  };
}

/** Median of positive numbers, or null when there is no history. */
export function median(values: number[]): number | null {
  const xs = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export type ShipmentEvent = { courier: string; awb: string; status: string; location: string | null; note: string | null; at: string };
export type ShipmentHealth = { courier: string; awb: string; last_status: string; last_location: string | null; hours_since_scan: number; stuck: boolean; reason: string };

/** Stuck = the courier says so, or an in-transit parcel has had no scan for 36 hours. */
export const NO_SCAN_HOURS = 36;
export function shipmentHealth(events: ShipmentEvent[], now = Date.now()): ShipmentHealth | null {
  if (!events.length) return null;
  const last = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)!;
  const since = (now - Date.parse(last.at)) / HOUR;
  const base = { courier: last.courier, awb: last.awb, last_status: last.status, last_location: last.location, hours_since_scan: round(since, 1) };
  if (last.status === "stuck") return { ...base, stuck: true, reason: `${last.courier} reports it stuck${last.location ? ` at ${last.location}` : ""}${last.note ? ` (${last.note})` : ""}, ${round(since, 1)} h ago.` };
  if ((last.status === "in_transit" || last.status === "picked_up") && since > NO_SCAN_HOURS) {
    return { ...base, stuck: true, reason: `No tracking scan for ${round(since, 1)} h (last: ${last.status}${last.location ? ` at ${last.location}` : ""}).` };
  }
  return { ...base, stuck: false, reason: `${last.status.replace(/_/g, " ")}${last.location ? ` at ${last.location}` : ""}, ${round(since, 1)} h ago.` };
}
