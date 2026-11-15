-- Additive. Per-turn response latencies (ms) measured by the relay, for the analytics page.
ALTER TABLE voiceops_sessions ADD COLUMN IF NOT EXISTS latencies JSONB NOT NULL DEFAULT '[]';
