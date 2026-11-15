-- Additive only. VoiceOps: voice sessions, agent actions, human approvals, returns, notices, idempotency.
CREATE TABLE IF NOT EXISTS voiceops_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  language_hint TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  input_audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS voiceops_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES voiceops_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','blocked','awaiting_approval','undone')),
  error_code TEXT,
  human_involved BOOLEAN NOT NULL DEFAULT false,
  undo_of TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voiceops_actions_user_idx ON voiceops_actions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voiceops_approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES voiceops_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args JSONB NOT NULL,
  args_hash TEXT NOT NULL,
  readback TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired','executed')),
  decided_via TEXT CHECK (decided_via IN ('tap','voice')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS voiceops_approvals_user_idx ON voiceops_approvals (user_id, state);

CREATE TABLE IF NOT EXISTS voiceops_returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  reason TEXT,
  refund_deferred BOOLEAN NOT NULL DEFAULT true,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','cancelled')),
  action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS voiceops_returns_open_idx ON voiceops_returns (order_id) WHERE state = 'requested';

CREATE TABLE IF NOT EXISTS voiceops_notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  language TEXT,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'recorded' CHECK (delivery IN ('recorded','sent','failed')),
  action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voiceops_idempotency (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
