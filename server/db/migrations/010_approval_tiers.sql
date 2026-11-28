-- Additive. The approval tier is fixed when the proposal is made (bound to the same arguments as the
-- args hash), so the decision step enforces exactly what the seller was shown.
ALTER TABLE voiceops_approvals ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE voiceops_approvals DROP CONSTRAINT IF EXISTS voiceops_approvals_tier_check;
ALTER TABLE voiceops_approvals ADD CONSTRAINT voiceops_approvals_tier_check CHECK (tier IN ('standard', 'critical'));
