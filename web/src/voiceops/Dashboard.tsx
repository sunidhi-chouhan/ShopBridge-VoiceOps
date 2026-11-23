import { useMemo, useState, type ReactNode } from "react";
import { startAgentRun, type VoiceOverview } from "../api";
import { useSession } from "../app/session";
import { Button } from "../ui/Button";
import { navigate } from "../ui/route";
import { unitEconomics } from "./Economics";
import { useVoice } from "./VoiceContext";

type Data = VoiceOverview;
type Tab = "agent" | "team" | "how" | "approvals" | "activity" | "overview";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
const today = () => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const minutes = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

/** Lead band: who, what the agent achieved, and one way in. */
export function DashHero({ data, onOpenTab }: { data: Data; onOpenTab: (t: Tab) => void }) {
  const { user } = useSession();
  const { agent } = useVoice();
  const u = data.usage;
  const saved = Math.max(0, u.manual_seconds - u.voice_seconds);
  const live = agent.status === "live" || agent.status === "connecting";
  return (
    <section className="dash-hero" aria-label="Today">
      <div className="dash-hero-copy">
        <p className="dash-eyebrow">{today()}</p>
        <h2 className="dash-hello">{greeting()}, {user.name.split(" ")[0]}.</h2>
        <p className="dash-hero-sub">
          {data.summary.delayed.length || data.summary.pending_approvals
            ? `${[
                data.summary.delayed.length ? `${data.summary.delayed.length} delayed order${data.summary.delayed.length > 1 ? "s" : ""}` : "",
                data.summary.pending_approvals ? `${data.summary.pending_approvals} approval${data.summary.pending_approvals > 1 ? "s" : ""} waiting` : "",
              ].filter(Boolean).join(" and ")} need you. The agent can handle them in one sentence.`
            : "Nothing is waiting on you. The agent is ready when you are."}
        </p>
        <div className="dash-hero-actions">
          {live ? (
            <Button onClick={() => onOpenTab("agent")}>Open the live session</Button>
          ) : (
            <Button magnetic onClick={() => { onOpenTab("agent"); void agent.start(); }}>
              <span aria-hidden="true">🎙</span> Talk to the agent
            </Button>
          )}
          <Button variant="secondary" onClick={() => { void startAgentRun().catch(() => undefined); onOpenTab("team"); }}>✦ Run the AI team</Button>
          <span className="dash-ai-pill"><span className="dash-live-dot" aria-hidden="true" /> Gemini Live · native audio</span>
        </div>
      </div>
      <div className="dash-hero-figure">
        <p className="dash-eyebrow">Done by voice (measured)</p>
        <p className="dash-big">{u.workflows_completed}</p>
        <p className="dash-big-label">workflow{u.workflows_completed === 1 ? "" : "s"} completed</p>
        <dl className="dash-hero-stats">
          <div><dt>Time saved</dt><dd>{u.workflows_completed ? minutes(saved) : "–"}</dd></div>
          <div><dt>Median reply</dt><dd>{u.latency.p50_ms !== null ? `${u.latency.p50_ms} ms` : "–"}</dd></div>
          <div><dt>Cost / workflow</dt><dd>{u.est_cost_per_workflow_usd !== null && u.voice_seconds > 0 ? `$${u.est_cost_per_workflow_usd.toFixed(3)}` : "–"}</dd></div>
        </dl>
      </div>
    </section>
  );
}

type Item = { key: string; tone: "danger" | "warning" | "accent" | "neutral"; icon: string; title: string; detail: string; action: ReactNode };

/** What needs the seller now, each with the fastest way to deal with it. */
export function Attention({ data, onOpenTab }: { data: Data; onOpenTab: (t: Tab) => void }) {
  const { agent } = useVoice();
  const s = data.summary;
  const ask = (text: string) => { onOpenTab("agent"); agent.ask(text); };
  const items: Item[] = [];
  if (s.pending_approvals) items.push({ key: "appr", tone: "warning", icon: "✋", title: `${s.pending_approvals} approval${s.pending_approvals > 1 ? "s" : ""} waiting for you`, detail: "Nothing changes until you say yes.", action: <Button variant="secondary" onClick={() => onOpenTab("approvals")}>Review</Button> });
  if (s.delayed.length) items.push({ key: "late", tone: "danger", icon: "⏱", title: `${s.delayed.length} order${s.delayed.length > 1 ? "s" : ""} not dispatched in 24 h`, detail: `Orders ${s.delayed.join(", ")}. One approval tells every customer.`, action: <Button onClick={() => ask("Sab delayed customers ko ek chhota sorry message bhej do ki order thoda late hoga.")}>✦ Ask the agent</Button> });
  if (s.awaiting_dispatch > s.delayed.length) items.push({ key: "pack", tone: "accent", icon: "📦", title: `${s.awaiting_dispatch} order${s.awaiting_dispatch > 1 ? "s" : ""} to pack and ship`, detail: "Say which ones are packed or shipped.", action: <Button variant="secondary" onClick={() => ask("Aaj kaunse orders dispatch karne hain? List batao.")}>✦ Ask the agent</Button> });
  if (s.low_stock_products) items.push({ key: "stock", tone: "warning", icon: "📉", title: `${s.low_stock_products} product${s.low_stock_products > 1 ? "s" : ""} running low`, detail: "Top up by voice or edit the listing.", action: <Button variant="secondary" onClick={() => navigate("products")}>Open products</Button> });
  if (s.open_returns) items.push({ key: "ret", tone: "neutral", icon: "↩", title: `${s.open_returns} return${s.open_returns > 1 ? "s" : ""} in progress`, detail: "Refunds stay with a person.", action: <Button variant="quiet" onClick={() => onOpenTab("activity")}>See activity</Button> });
  return (
    <section className="dash-card dash-attention" aria-labelledby="dash-att-h">
      <header className="dash-card-head">
        <div>
          <h3 id="dash-att-h" className="dash-card-title">Needs your attention</h3>
          <p className="dash-card-sub">{items.length ? "Sorted by what to do first." : "All clear."}</p>
        </div>
        {items.length ? <span className="dash-count">{items.length}</span> : null}
      </header>
      {items.length ? (
        <ul className="dash-att-list">
          {items.map((item) => (
            <li key={item.key} className={`dash-att is-${item.tone}`}>
              <span className="dash-att-icon" aria-hidden="true">{item.icon}</span>
              <div className="dash-att-copy"><strong>{item.title}</strong><span>{item.detail}</span></div>
              <div className="dash-att-action">{item.action}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dash-clear"><span aria-hidden="true">✓</span> No delayed orders, approvals, low stock or returns right now.</p>
      )}
    </section>
  );
}

export function KpiRow({ data }: { data: Data }) {
  const s = data.summary;
  const tiles: Array<{ label: string; value: number; hint: string; tone?: "danger" | "warning" }> = [
    { label: "Awaiting dispatch", value: s.awaiting_dispatch, hint: `of ${s.total_orders} orders` },
    { label: "Delayed over 24 h", value: s.delayed.length, hint: s.delayed.length ? "needs a customer update" : "none late", tone: s.delayed.length ? "danger" : undefined },
    { label: "Low-stock products", value: s.low_stock_products, hint: "5 or fewer left", tone: s.low_stock_products ? "warning" : undefined },
    { label: "Open returns", value: s.open_returns, hint: "refunds handled by a person" },
  ];
  return (
    <div className="dash-kpis" role="list">
      {tiles.map((t) => (
        <div key={t.label} role="listitem" className={`dash-kpi${t.tone ? ` is-${t.tone}` : ""}`}>
          <p className="dash-kpi-label">{t.label}</p>
          <p className="dash-kpi-value">{t.value}</p>
          <p className="dash-kpi-hint">{t.hint}</p>
        </div>
      ))}
    </div>
  );
}

/** Reply time per voice turn, oldest to newest, with the 1-second target. Single series: the title names it. */
export function LatencyChart({ data }: { data: Data }) {
  const pts = data.usage.latency.recent_ms;
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 180, L = 40, R = 12, T = 12, B = 26;
  const max = Math.max(1500, ...pts) * 1.1;
  const x = (i: number) => L + (pts.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 500, 1000, 1500, 2000, 3000, 4000].filter((t) => t <= max);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    pts.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    setHover(pts.length ? best : null);
  };
  const u = data.usage.latency;
  return (
    <section className="dash-card" aria-labelledby="dash-lat-h">
      <header className="dash-card-head">
        <div>
          <h3 id="dash-lat-h" className="dash-card-title">Reply time per voice turn</h3>
          <p className="dash-card-sub">From the end of your sentence to the agent's first audio. Last {pts.length || 0} turns.</p>
        </div>
        <dl className="dash-mini-stats">
          <div><dt>p50</dt><dd>{u.p50_ms ?? "–"}<small> ms</small></dd></div>
          <div><dt>p95</dt><dd>{u.p95_ms ?? "–"}<small> ms</small></dd></div>
        </dl>
      </header>
      {pts.length ? (
        <div className="dash-chart">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Reply times for the last ${pts.length} turns. Median ${u.p50_ms} ms, 95th percentile ${u.p95_ms} ms.`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="dash-grid" />
                <text x={L - 6} y={y(t) + 4} className="dash-axis" textAnchor="end">{t >= 1000 ? `${t / 1000}s` : t}</text>
              </g>
            ))}
            <line x1={L} x2={W - R} y1={y(1000)} y2={y(1000)} className="dash-target" />
            <text x={W - R} y={y(1000) - 5} className="dash-axis dash-target-label" textAnchor="end">1 s target</text>
            <path d={path} className="dash-line" />
            {hover !== null ? (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="dash-cross" />
                <circle cx={x(hover)} cy={y(pts[hover])} r={5} className="dash-dot" />
              </g>
            ) : (
              <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r={4.5} className="dash-dot" />
            )}
          </svg>
          {hover !== null ? (
            <div className="dash-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
              <b>{pts[hover]} ms</b><span>turn {hover + 1} of {pts.length}</span>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="dash-empty">Start a voice session; each reply time appears here.</p>
      )}
      <details className="dash-table">
        <summary>Show as table</summary>
        <table><thead><tr><th>Turn</th><th>Reply (ms)</th></tr></thead><tbody>{pts.map((v, i) => <tr key={i}><td>{i + 1}</td><td>{v}</td></tr>)}</tbody></table>
      </details>
    </section>
  );
}

/** How the agent's actions ended. Colors validated for CVD in both themes; counts are always written. */
export function OutcomeBar({ data }: { data: Data }) {
  const a = data.activity;
  const segs = useMemo(() => [
    { key: "done", label: "Done automatically (lookups)", value: a.auto_ok, cls: "is-done" },
    { key: "human", label: "Done with your approval", value: a.human_ok, cls: "is-human" },
    { key: "blocked", label: "Blocked by policy", value: a.blocked, cls: "is-blocked" },
    { key: "failed", label: "Failed", value: a.failed, cls: "is-failed" },
  ], [a]);
  const total = segs.reduce((n, s) => n + s.value, 0);
  const shown = segs.filter((s) => s.value > 0);
  return (
    <section className="dash-card" aria-labelledby="dash-out-h">
      <header className="dash-card-head">
        <div>
          <h3 id="dash-out-h" className="dash-card-title">What the agent did</h3>
          <p className="dash-card-sub">Every tool call is audited. Average tool time {a.avg_latency_ms} ms.</p>
        </div>
        <dl className="dash-mini-stats"><div><dt>actions</dt><dd>{a.total}</dd></div></dl>
      </header>
      {total ? (
        <div className="dash-stack" role="img" aria-label={segs.map((s) => `${s.label} ${s.value}`).join(", ")}>
          {shown.map((s) => (
            <span key={s.key} className={`dash-seg ${s.cls}`} style={{ flexGrow: s.value }} title={`${s.label}: ${s.value}`} />
          ))}
        </div>
      ) : (
        <p className="dash-empty">No actions yet.</p>
      )}
      <ul className="dash-legend">
        {segs.map((s) => (
          <li key={s.key}>
            <span className={`dash-swatch ${s.cls}`} aria-hidden="true" />
            <span className="dash-legend-label">{s.label}</span>
            <b>{s.value}</b>
          </li>
        ))}
      </ul>
      <p className="dash-card-foot">Blocked actions are the guardrails working: for example a cancel after dispatch or a return outside 7 days.</p>
    </section>
  );
}

export function EconomicsTiles({ data }: { data: Data }) {
  const u = data.usage;
  const unit = unitEconomics(u);
  const allMeasured = u.workflows_completed > 0 && u.workflows_with_measured_baseline === u.workflows_completed;
  const tiles = [
    { label: "Workflows done / tried", value: `${u.workflows_completed} / ${u.workflows_attempted}`, hint: "changes the agent made with your yes" },
    { label: "Audio minutes", value: (u.input_minutes + u.output_minutes).toFixed(1), hint: `${u.sessions} voice session${u.sessions === 1 ? "" : "s"}` },
    { label: "Cost per workflow", value: unit ? `$${unit.costPerWorkflowUsd.toFixed(4)}` : "–", hint: "Gemini Live audio at list price" },
    { label: "Voice vs by hand", value: unit ? `${Math.round(unit.voicePerWorkflow)} s / ${Math.round(unit.manualPerWorkflow)} s` : "–", hint: allMeasured ? "manual time measured" : "manual time partly assumed" },
    { label: "Taps by hand / by voice", value: u.workflows_with_measured_baseline ? `${u.manual_taps} / ${u.voice_taps}` : "–", hint: u.workflows_with_measured_baseline ? "for the same jobs" : "time a task to measure" },
  ];
  return (
    <div className="dash-econ" role="list">
      {tiles.map((t) => (
        <div key={t.label} role="listitem" className="dash-econ-tile">
          <p className="dash-kpi-label">{t.label}</p>
          <p className="dash-econ-value">{t.value}</p>
          <p className="dash-kpi-hint">{t.hint}</p>
        </div>
      ))}
    </div>
  );
}

export function DashSection({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="dash-section">
      <header className="dash-section-head">
        <h3 className="dash-section-title">{title}</h3>
        {sub ? <p className="dash-card-sub">{sub}</p> : null}
      </header>
      {children}
    </section>
  );
}
