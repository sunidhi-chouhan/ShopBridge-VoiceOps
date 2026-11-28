-- Additive. Proactive co-pilot: suppliers and purchase orders, shipment tracking events, simulated
-- refunds, alerts raised by the operations monitor, and product insights mined from order chats.

-- When an order was handed to the courier (dispatch time drives the SLA model).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 4 CHECK (lead_time_days BETWEEN 1 AND 60),
  connector TEXT NOT NULL DEFAULT 'simulated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_seller_idx ON suppliers (seller_id);

-- Which supplier makes which product, at what cost and minimum order.
CREATE TABLE IF NOT EXISTS supplier_products (
  product_id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  unit_cost DOUBLE PRECISION NOT NULL CHECK (unit_cost >= 0),
  min_order_qty INTEGER NOT NULL DEFAULT 1 CHECK (min_order_qty >= 1)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'confirmed', 'received', 'cancelled')),
  supplier_ref TEXT,
  eta TIMESTAMPTZ,
  action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_orders_seller_idx ON purchase_orders (seller_id, created_at DESC);

-- Courier tracking scans, newest last. Re-routes add a 'rebooked' event with the new courier.
CREATE TABLE IF NOT EXISTS shipment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier TEXT NOT NULL,
  awb TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('picked_up', 'in_transit', 'stuck', 'out_for_delivery', 'delivered', 'rebooked')),
  location TEXT,
  note TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_events_order_idx ON shipment_events (order_id, at);

-- Simulated refunds: recorded, never paid out by the AI. Executed only after a tapped approval.
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'reversed')),
  action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_per_order ON refunds (order_id) WHERE state = 'issued';

-- What the operations monitor noticed. One open alert per (seller, kind, subject).
CREATE TABLE IF NOT EXISTS copilot_alerts (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stockout', 'sla_risk', 'stuck_shipment')),
  subject TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggestion JSONB,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'proposed', 'resolved', 'dismissed')),
  approval_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS copilot_alerts_open_uniq ON copilot_alerts (seller_id, kind, subject) WHERE state IN ('open', 'proposed');
CREATE INDEX IF NOT EXISTS copilot_alerts_seller_idx ON copilot_alerts (seller_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS copilot_scans (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  raised INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS copilot_scans_seller_idx ON copilot_scans (seller_id, created_at DESC);

-- Product insights from order chats. Every theme carries verbatim quotes (checked server-side).
CREATE TABLE IF NOT EXISTS copilot_insights (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  product_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('complaint', 'request', 'praise', 'question')),
  theme TEXT NOT NULL,
  suggestion TEXT,
  mentions INTEGER NOT NULL DEFAULT 1,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS copilot_insights_seller_idx ON copilot_insights (seller_id, created_at DESC);
