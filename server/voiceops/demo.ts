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

type Plan = { no: number; status: string; createdH: number; updatedH: number | null; buyer: number; product: number; qty: number; why: string; room?: boolean };
export const DEMO_PLAN: Plan[] = [
  { no: 1042, status: "delivered", createdH: 90, updatedH: 48, buyer: 0, product: 0, qty: 1, room: true, why: "Workflow 2: return (delivered 2 days ago, in window)" },
  { no: 1050, status: "shipped", createdH: 40, updatedH: 20, buyer: 1, product: 1, qty: 1, room: true, why: "Workflow 3: cancel blocked, already shipped" },
  { no: 1051, status: "placed", createdH: 31, updatedH: null, buyer: 2, product: 2, qty: 2, why: "Workflow 1: delayed" },
  { no: 1052, status: "placed", createdH: 27, updatedH: null, buyer: 0, product: 3, qty: 1, why: "Workflow 1: delayed (also sounds like 1042)" },
  { no: 1053, status: "packed", createdH: 25, updatedH: 24, buyer: 1, product: 4, qty: 1, why: "Workflow 1: delayed, packed but not shipped" },
  { no: 1054, status: "delivered", createdH: 300, updatedH: 280, buyer: 2, product: 5, qty: 1, why: "Policy: return window closed" },
  { no: 1055, status: "placed", createdH: 2, updatedH: null, buyer: 0, product: 6, qty: 1, why: "Fresh order, not delayed" },
];

/**
 * `openRoom` (optional) opens the Nexconn order conversation for orders marked `room`, which belong to the
 * real demo buyer (sign in as Buyer to see the seller's messages arrive in the order conversation).
 */
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
    // a few low-stock products so "low stock" has something to say
    for (const [i, p] of products.entries()) {
      await client.query("UPDATE products SET stock = $2 WHERE id = $1", [p.id, i === 0 ? 2 : i === 1 ? 4 : 12]);
    }
    const now = Date.now();
    for (const o of DEMO_PLAN) {
      const id = `vod${o.no}`;
      const product = products[o.product];
      const created = new Date(now - o.createdH * HOUR).toISOString();
      const updated = o.updatedH === null ? null : new Date(now - o.updatedH * HOUR).toISOString();
      await client.query(
        `INSERT INTO orders (id, buyer_id, seller_id, status, payment, total, channel_id, created_at, updated_at, courier, awb)
         VALUES ($1, $2, $3, $4, 'simulated', $5, NULL, $6, $7, $8, $9)`,
        [id, o.room && realBuyer ? realBuyer : BUYERS[o.buyer].id, user.id, o.status, Number(product.price) * o.qty, created, updated, o.status === "shipped" ? "Delhivery" : null, o.status === "shipped" ? "DL4821" : null],
      );
      await client.query(
        "INSERT INTO order_items (order_id, product_id, seller_id, name, image, quantity, price) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, product.id, user.id, product.name, product.image ?? "", o.qty, product.price],
      );
      await client.query("INSERT INTO voiceops_order_numbers (order_id, order_no) VALUES ($1, $2)", [id, o.no]);
    }
    await client.query("COMMIT");
    const rooms: string[] = [];
    if (openRoom) {
      for (const o of DEMO_PLAN.filter((x) => x.room)) {
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
