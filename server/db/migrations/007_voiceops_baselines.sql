-- Additive. Timed manual runs of the same jobs the voice agent does (the ROI baseline).
-- A seller starts a stopwatch, does the task by tapping through the normal screens, then stops it.
CREATE TABLE IF NOT EXISTS voiceops_baselines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task TEXT NOT NULL,
  seconds DOUBLE PRECISION NOT NULL CHECK (seconds > 0 AND seconds <= 1800),
  taps INTEGER NOT NULL DEFAULT 0 CHECK (taps >= 0),
  keys INTEGER NOT NULL DEFAULT 0 CHECK (keys >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voiceops_baselines_task_idx ON voiceops_baselines (task, created_at DESC);
