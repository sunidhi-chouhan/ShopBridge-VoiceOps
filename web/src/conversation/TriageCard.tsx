import type { CaseTriage } from "../api";
import { RESOLUTION_COPY } from "../i18n";
import { Badge } from "../ui/Badge";

const URGENCY_TONE = { high: "danger", medium: "warning", low: "neutral" } as const;
const MOOD_LABEL = { calm: "Calm", worried: "Worried", upset: "Upset", angry: "Angry" } as const;
const ISSUE_LABEL: Record<string, string> = {
  damaged: "Damaged item",
  wrong_item: "Wrong item",
  late_or_missing: "Late or missing",
  quality: "Quality",
  size_or_fit: "Size or fit",
  change_of_mind: "Change of mind",
  other: "Other",
};

/** Gemini's read of a support case. A suggestion for the agent, never an action. */
export function TriageCard({
  triage,
  pending,
  error,
  onUse,
  compact = false,
}: {
  triage: CaseTriage | null;
  pending?: boolean;
  error?: string | null;
  onUse?: (resolution: CaseTriage["suggestion"]["resolution"], note: string) => void;
  compact?: boolean;
}) {
  if (!triage) {
    return (
      <div className="triage is-empty" aria-live="polite">
        <p className="triage-k"><span aria-hidden="true">✦</span> Gemini triage</p>
        <p className="meta">{pending ? "Gemini is reading the case…" : error ?? "Not triaged yet."}</p>
      </div>
    );
  }
  return (
    <div className={`triage${compact ? " is-compact" : ""}`} aria-live="polite">
      <p className="triage-k">
        <span aria-hidden="true">✦</span> Gemini triage
        {pending ? <span className="meta"> · updating…</span> : null}
      </p>
      <div className="triage-tags">
        <Badge tone={URGENCY_TONE[triage.urgency]}>{triage.urgency} urgency</Badge>
        <Badge>{ISSUE_LABEL[triage.issue] ?? triage.issue}</Badge>
        <Badge>{MOOD_LABEL[triage.mood]} buyer</Badge>
      </div>
      <p className="triage-summary">{triage.summary}</p>
      {!compact ? (
        <>
          <div className="triage-suggest">
            <p className="meta">Suggested resolution</p>
            <p>
              <b>{RESOLUTION_COPY.en[triage.suggestion.resolution]}</b> · {triage.suggestion.note}
            </p>
            {triage.reasons.length ? (
              <ul className="triage-reasons">
                {triage.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            ) : null}
            {triage.policyNote ? <p className="triage-policy">{triage.policyNote}</p> : null}
            {onUse ? (
              <button type="button" className="ix-btn" onClick={() => onUse(triage.suggestion.resolution, triage.suggestion.note)}>
                Use this proposal
              </button>
            ) : null}
          </div>
          <p className="meta triage-foot">
            Suggestion from Google Gemini ({triage.model}). You decide; the buyer confirms. Refunds are always handled by a person.
          </p>
        </>
      ) : null}
    </div>
  );
}
