-- Additive. Speakable order numbers, approval->action link, and a "cancelled" order status.
CREATE SEQUENCE IF NOT EXISTS voiceops_order_no_seq START 1001;
CREATE TABLE IF NOT EXISTS voiceops_order_numbers (
  order_id TEXT PRIMARY KEY,
  order_no INTEGER NOT NULL UNIQUE DEFAULT nextval('voiceops_order_no_seq')
);
ALTER TABLE voiceops_approvals ADD COLUMN IF NOT EXISTS action_id TEXT;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('placed', 'packed', 'shipped', 'delivered', 'completed', 'cancelled'));
