/** Reasoning-engine decision trace: facts considered, rules checked, verdict and why. Shared by the voice timeline and the agent network. */
export type DecisionTrace = {
  tool: string;
  intent: string;
  facts: Array<{ label: string; value: string }>;
  checks: Array<{ rule: string; passed: boolean; detail: string; hard: boolean }>;
  verdict: "allowed" | "needs_approval" | "blocked" | "escalate";
  explanation: string;
};

const VERDICT = {
  allowed: { label: "Allowed · read-only", tone: "is-ok" },
  needs_approval: { label: "Rules pass · needs your yes", tone: "is-wait" },
  blocked: { label: "Blocked by the rules", tone: "is-bad" },
  escalate: { label: "Escalated to a person", tone: "is-esc" },
} as const;

export function TraceView({ trace, open = false }: { trace: DecisionTrace; open?: boolean }) {
  const v = VERDICT[trace.verdict];
  return (
    <details className="trace" open={open}>
      <summary>
        <span className="trace-k">✦ Why</span>
        <span className={`trace-verdict ${v.tone}`}>{v.label}</span>
      </summary>
      <p className="trace-intent">{trace.intent}</p>
      {trace.facts.length ? (
        <dl className="trace-facts">
          {trace.facts.map((f) => (
            <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
          ))}
        </dl>
      ) : null}
      <ul className="trace-checks">
        {trace.checks.map((c) => (
          <li key={c.rule} className={c.passed ? "is-pass" : c.hard ? "is-fail" : "is-warn"}>
            <span className="trace-mark" aria-hidden="true">{c.passed ? "✓" : c.hard ? "✕" : "!"}</span>
            <span><b>{c.rule}</b> — {c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="trace-why">{trace.explanation}</p>
    </details>
  );
}
