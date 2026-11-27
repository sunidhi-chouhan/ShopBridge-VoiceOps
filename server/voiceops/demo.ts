/**
 * Deterministic demo scenario for the three VoiceOps workflows. Only runs for sample (demo) sellers.
 * Creates clearly-marked demo orders (ids start with "vod") with fixed, speakable order numbers and
 * ages, and a few low-stock products, so every demo starts from the same state.
 */
import { getPool } from "../db/pool";
import { HttpError } from "../errors";
import type { UserRecord } from "../store-types";

export const demoEnabled = () => process.env.NODE_ENV !== "production" || process.env.VOICEOPS_DEMO === "1";

const HOUR = 3_600_000;
const BUYERS = [
  { id: "vodbuyer1", name: "Ravi Kumar" },
  { id: "vodbuyer2", name: "Lakshmi Iyer" },
  { id: "vodbuyer3", name: "Imran Sheikh" },
];

type Plan = { no: number; status: string; createdH: number; updatedH: number | null; buyer: number; product: number; qty: number; why: string; room?: boolean; deliver?: boolean; shippedH?: number };
export const DEMO_PLAN: Plan[] = [
  { no: 1042, status: "delivered", createdH: 90, updatedH: 48, buyer: 0, product: 0, qty: 1, room: true, shippedH: 74, why: "Workflow 2: return (delivered 2 days ago, in window)" },
  { no: 1050, status: "shipped", createdH: 40, updatedH: 20, buyer: 1, product: 1, qty: 1, room: true, shippedH: 20, why: "Workflow 3: cancel blocked, already shipped; co-pilot: stuck with the courier" },
  { no: 1051, status: "placed", createdH: 31, updatedH: null, buyer: 2, product: 2, qty: 2, deliver: true, why: "Workflow 1: delayed" },
  { no: 1052, status: "placed", createdH: 27, updatedH: null, buyer: 0, product: 3, qty: 1, why: "Workflow 1: delayed (also sounds like 1042)" },
  { no: 1053, status: "packed", createdH: 25, updatedH: 24, buyer: 1, product: 4, qty: 1, deliver: true, why: "Workflow 1: delayed, packed but not shipped" },
  { no: 1054, status: "delivered", createdH: 300, updatedH: 280, buyer: 2, product: 5, qty: 1, shippedH: 284, why: "Policy: return window closed" },
  { no: 1055, status: "placed", createdH: 2, updatedH: null, buyer: 0, product: 6, qty: 1, why: "Fresh order, not delayed" },
  { no: 1056, status: "placed", createdH: 21, updatedH: null, buyer: 2, product: 4, qty: 1, why: "Co-pilot: not late yet, but projected to miss the 24 h dispatch" },
];

/**
 * `room` assigns the signed-in demo buyer so they can see that conversation.
 * `deliver` opens a Nexconn room for the order's own buyer without changing who that buyer is.
 * A room that fails to open is skipped; the reset still succeeds.
 */
/** Suppliers per product (name match), cost about half the selling price. The attar has none, on purpose. */
const SUPPLIERS = [
  { id: "vodsup1", name: "Maheshwar Weavers Co-op", contact: "WhatsApp +91 98260 00001", lead: 4, moq: 5, match: /sari|kantha/i },
  { id: "vodsup2", name: "Indore Leather Works", contact: "WhatsApp +91 98260 00002", lead: 4, moq: 3, match: /tote|belt/i },
  { id: "vodsup3", name: "Moradabad Brass House", contact: "orders@example.invalid", lead: 3, moq: 10, match: /jhumka/i },
  { id: "vodsup4", name: "Khurja Pottery", contact: "WhatsApp +91 98260 00004", lead: 6, moq: 6, match: /bowl|cup/i },
];

/** Units per day over the past four weeks (earlier, last 7 days). The sari is selling faster lately. */
const DEMAND: Array<[RegExp, number, number]> = [
  [/sari/i, 1.1, 2.0], [/tote/i, 0.8, 0.8], [/jhumka/i, 1.0, 1.1], [/attar/i, 0.5, 0.5],
  [/kantha/i, 0.12, 0.12], [/bowl/i, 0.4, 0.35], [/belt/i, 0.3, 0.3], [/cup/i, 0, 0],
];

/** Small deterministic PRNG so every reset produces the same history. */
function prng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Co-pilot demo data: suppliers, and 27 days of completed sales history (ids "vodh…", order numbers 2001+)
 * so stock forecasts and the seller's typical dispatch time come from real order rows.
 */
async function seedCopilot(client: import("pg").PoolClient, sellerId: string, products: Array<{ id: string; name: string; price: number; image: string | null }>) {
  await client.query("DELETE FROM copilot_alerts WHERE seller_id = $1", [sellerId]);
  await client.query("DELETE FROM copilot_scans WHERE seller_id = $1", [sellerId]);
  await client.query("DELETE FROM purchase_orders WHERE seller_id = $1", [sellerId]);
  await client.query("DELETE FROM supplier_products WHERE supplier_id IN (SELECT id FROM suppliers WHERE seller_id = $1)", [sellerId]);
  await client.query("DELETE FROM suppliers WHERE seller_id = $1", [sellerId]);
  for (const s of SUPPLIERS) {
    await client.query("INSERT INTO suppliers (id, seller_id, name, contact, lead_time_days) VALUES ($1,$2,$3,$4,$5)", [`${s.id}${sellerId.slice(-6)}`, sellerId, s.name, s.contact, s.lead]);
    for (const p of products.filter((x) => s.match.test(x.name))) {
      await client.query("INSERT INTO supplier_products (product_id, supplier_id, unit_cost, min_order_qty) VALUES ($1,$2,$3,$4)", [p.id, `${s.id}${sellerId.slice(-6)}`, Math.round(Number(p.price) * 0.5), s.moq]);
    }
  }
  const rand = prng(1042);
  const poisson = (lambda: number) => {
    let k = 0;
    let p = 1;
    const limit = Math.exp(-lambda);
    while ((p *= rand()) > limit) k++;
    return k;
  };
  const now = Date.now();
  const rows: Array<{ id: string; no: number; buyer: string; product: (typeof products)[number]; qty: number; created: number; shipped: number }> = [];
  let no = 2001;
  for (let day = 27; day >= 1; day--) {
    for (const p of products) {
      const rate = DEMAND.find(([re]) => re.test(p.name));
      if (!rate) continue;
      const units = poisson(day <= 7 ? rate[2] : rate[1]);
      for (let u = 0; u < units; u++) {
        const created = now - day * 24 * HOUR - Math.floor(rand() * 10 + 8) * HOUR;
        rows.push({ id: `vodh${no}`, no, buyer: BUYERS[no % BUYERS.length].id, product: p, qty: 1, created, shipped: created + Math.round((8 + rand() * 16) * HOUR) });
        no++;
      }
    }
  }
  if (!rows.length) return;
  await client.query(
    `INSERT INTO orders (id, buyer_id, seller_id, status, payment, total, channel_id, created_at, updated_at, shipped_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::text[], $8::timestamptz[], $9::timestamptz[], $10::timestamptz[])`,
    [
      rows.map((r) => r.id), rows.map((r) => r.buyer), rows.map(() => sellerId), rows.map(() => "completed"), rows.map(() => "simulated"),
      rows.map((r) => Number(r.product.price) * r.qty), rows.map(() => null),
      rows.map((r) => new Date(r.created).toISOString()), rows.map((r) => new Date(r.shipped + 2 * 24 * HOUR).toISOString()), rows.map((r) => new Date(r.shipped).toISOString()),
    ],
  );
  await client.query(
    `INSERT INTO order_items (order_id, product_id, seller_id, name, image, quantity, price)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::float8[])`,
    [rows.map((r) => r.id), rows.map((r) => r.product.id), rows.map(() => sellerId), rows.map((r) => r.product.name), rows.map((r) => r.product.image ?? ""), rows.map((r) => r.qty), rows.map((r) => Number(r.product.price))],
  );
  await client.query(
    "INSERT INTO voiceops_order_numbers (order_id, order_no) SELECT * FROM unnest($1::text[], $2::int[])",
    [rows.map((r) => r.id), rows.map((r) => r.no)],
  );
}

export async function resetDemoScenario(user: UserRecord, openRoom?: (orderId: string) => Promise<unknown>): Promise<{ orders: number[]; rooms: string[] }> {
  if (!demoEnabled()) throw new HttpError(404, "NOT_FOUND", "Not found.");
  if (user.role !== "volunteer" || !user.sample) throw new HttpError(403, "FORBIDDEN", "Only the demo seller can reset the demo scenario.");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const products = (await client.query("SELECT id, name, price, images->>0 AS image FROM products WHERE seller_id = $1 ORDER BY name", [user.id])).rows;
    if (products.length < 7) throw new HttpError(409, "DEMO_DATA_MISSING", "Demo products are missing. Run npm run seed first.");
    // wipe this seller's VoiceOps history (cascades to actions and approvals) and previous demo orders
    await client.query("DELETE FROM voiceops_notifications WHERE seller_id = $1", [user.id]);
    await client.query("DELETE FROM voiceops_returns WHERE seller_id = $1", [user.id]);
    await client.query("DELETE FROM voiceops_idempotency WHERE user_id = $1", [user.id]);
    await client.query("DELETE FROM voiceops_sessions WHERE user_id = $1", [user.id]);
    await client.query("DELETE FROM voiceops_order_numbers WHERE order_id LIKE 'vod%'");
    await client.query("DELETE FROM orders WHERE id LIKE 'vod%' AND seller_id = $1", [user.id]);
    const realBuyer = (await client.query("SELECT id FROM users WHERE role = 'member' AND id NOT LIKE 'vodbuyer%' ORDER BY sample DESC, created_at LIMIT 1")).rows[0]?.id as string | undefined;
    for (const b of BUYERS) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, sample, created_at)
         VALUES ($1, $2, $1 || '@demo.shopbridge.invalid', '!', 'member', true, now()) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.name],
      );
    }
    // a few low-stock products so "low stock" has something to say, and a fast seller close to running out
    for (const [i, p] of products.entries()) {
      await client.query("UPDATE products SET stock = $2 WHERE id = $1", [p.id, /sari/i.test(p.name) ? 5 : i === 0 ? 2 : i === 1 ? 4 : 12]);
    }
    await seedCopilot(client, user.id, products);
    const now = Date.now();
    for (const o of DEMO_PLAN) {
      const id = `vod${o.no}`;
      const product = products[o.product];
      const created = new Date(now - o.createdH * HOUR).toISOString();
      const updated = o.updatedH === null ? null : new Date(now - o.updatedH * HOUR).toISOString();
      await client.query(
        `INSERT INTO orders (id, buyer_id, seller_id, status, payment, total, channel_id, created_at, updated_at, courier, awb, shipped_at)
         VALUES ($1, $2, $3, $4, 'simulated', $5, NULL, $6, $7, $8, $9, $10)`,
        [id, o.room && realBuyer ? realBuyer : BUYERS[o.buyer].id, user.id, o.status, Number(product.price) * o.qty, created, updated, o.status === "shipped" ? "Delhivery" : null, o.status === "shipped" ? "DL4821" : null,
          o.shippedH === undefined ? null : new Date(now - o.shippedH * HOUR).toISOString()],
      );
      await client.query(
        "INSERT INTO order_items (order_id, product_id, seller_id, name, image, quantity, price) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, product.id, user.id, product.name, product.image ?? "", o.qty, product.price],
      );
      await client.query("INSERT INTO voiceops_order_numbers (order_id, order_no) VALUES ($1, $2)", [id, o.no]);
    }
    // 1050: picked up in Indore, then stuck at a sorting centre for 14 h (the co-pilot should notice).
    for (const [status, location, note, h] of [
      ["picked_up", "Indore", "Picked up from the seller", 20],
      ["in_transit", "Indore hub", "Left the origin hub", 18],
      ["stuck", "Bhopal sorting centre", "Held: sorting backlog", 14],
    ] as const) {
      await client.query(
        "INSERT INTO shipment_events (id, order_id, courier, awb, status, location, note, at) VALUES ($1,'vod1050','Delhivery','DL4821',$2,$3,$4,$5)",
        [`vodshp1050${h}`, status, location, note, new Date(now - h * HOUR).toISOString()],
      );
    }
    await client.query("COMMIT");
    const rooms: string[] = [];
    if (openRoom) {
      for (const o of DEMO_PLAN.filter((x) => x.room || x.deliver)) {
        try {
          await openRoom(`vod${o.no}`);
          rooms.push(`vod${o.no}`);
        } catch (error) {
          // Rooms use the app-wide `order{orderId}` convention, so a room left over from a previous reset can be reused.
          if (/exist|already|duplicate/i.test(error instanceof Error ? error.message : "")) {
            await getPool().query("UPDATE orders SET channel_id = $2 WHERE id = $1", [`vod${o.no}`, `ordervod${o.no}`]);
            rooms.push(`vod${o.no}`);
          } else {
            console.warn(`VoiceOps demo: could not open Nexconn room for vod${o.no}: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
    return { orders: DEMO_PLAN.map((o) => o.no), rooms };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
