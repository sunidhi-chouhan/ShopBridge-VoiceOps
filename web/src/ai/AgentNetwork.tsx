import { useCallback, useEffect, useState } from "react";
import { decideVoiceApproval, listAgentRuns, startAgentRun, type AgentRun, type AgentStep } from "../api";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { TraceView } from "./TraceView";

const NODES: Record<string, { name: string; role: string; x: number; y: number }> = {
  monitor: { name: "Operations monitor", role: "Watches orders, stock, cases", x: 110, y: 70 },
  supervisor: { name: "Supervisor", role: "Plans · hands off (Gemini)", x: 380, y: 70 },
  comms: { name: "Customer comms", role: "Drafts updates (Gemini)", x: 150, y: 210 },
  inventory: { name: "Inventory", role: "Proposes restocks", x: 380, y: 210 },
  triage: { name: "Support triage", role: "Recommends resolutions (Gemini)", x: 610, y: 210 },
  reasoning: { name: "Reasoning engine", role: "Rules check every proposal", x: 265, y: 345 },
  human: { name: "You", role: "Approve or reject", x: 560, y: 345 },
};
const EDGES: Array<[string, string]> = [
  ["monitor", "supervisor"], ["supervisor", "comms"], ["supervisor", "inventory"], ["supervisor", "triage"],
  ["comms", "reasoning"], ["inventory", "reasoning"], ["reasoning", "human"], ["triage", "human"],
];
const KIND_LABEL: Record<string, string> = {
  observe: "Observed", plan: "Plan", handoff: "Handoff", draft: "Draft", propose: "Proposal", decide: "Decision",
  recommend: "Recommendation", summary: "Summary", error: "Problem",
};

function Diagram({ run }: { run: AgentRun | null }) {
  const steps = run?.steps ?? [];
  const last = steps[steps.length - 1];
  const live = run?.status === "running";
  const used = new Set(steps.flatMap((s) => (s.to_agent ? [`${s.agent}>${s.to_agent}`] : [])));
  const activeEdge = last?.to_agent ? `${last.agent}>${last.to_agent}` : null;
  const counts = steps.reduce<Record<string, number>>((m, s) => ((m[s.agent] = (m[s.agent] ?? 0) + 1), m), {});
  const W = 170, H = 58;
  return (
    <svg className="an-diagram" viewBox="0 0 720 400" role="img" aria-label={`Agent team diagram. ${last ? `Latest: ${last.title}` : "Not run yet."}`}>
      <defs>
        <marker id="an-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="an-arrowhead" />
        </marker>
      </defs>
      {EDGES.map(([a, b]) => {
        const A = NODES[a], B = NODES[b];
        const key = `${a}>${b}`;
        const cls = key === activeEdge ? "an-edge is-active" : used.has(key) ? "an-edge is-used" : "an-edge";
        // Same row: connect the facing sides; otherwise bottom of the upper box to top of the lower one.
        const sameRow = A.y === B.y;
        const dir = B.x > A.x ? 1 : -1;
        const [x1, y1, x2, y2] = sameRow ? [A.x + (dir * W) / 2, A.y, B.x - (dir * W) / 2 - dir * 4, B.y] : [A.x, A.y + H / 2, B.x, B.y - H / 2 - 4];
        return <line key={key} className={cls} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#an-arrow)" />;
      })}
      {Object.entries(NODES).map(([id, n]) => {
        const active = last?.agent === id && live;
        const touched = counts[id] || (last?.to_agent === id);
        return (
          <g key={id} className={`an-node${active ? " is-active" : ""}${touched ? " is-touched" : ""}${id === "human" ? " is-human" : ""}${id === "reasoning" ? " is-rules" : ""}`} transform={`translate(${n.x - W / 2},${n.y - H / 2})`}>
            <rect width={W} height={H} rx={14} />
            <text x={W / 2} y={24} textAnchor="middle" className="an-node-name">{n.name}</text>
            <text x={W / 2} y={42} textAnchor="middle" className="an-node-role">{n.role}</text>
            {counts[id] ? <text x={W - 12} y={16} textAnchor="end" className="an-node-count">{counts[id]}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

function StepCard({ step, onDecide, busy }: { step: AgentStep; onDecide: (id: string, d: "approve" | "reject") => void; busy: boolean }) {
  const from = NODES[step.agent]?.name ?? step.agent;
  const to = step.to_agent ? NODES[step.to_agent]?.name ?? step.to_agent : null;
  return (
    <li className={`an-step is-${step.kind}`}>
      <div className="an-step-head">
        <span className="an-agent">{from}{to ? <span className="an-to"> → {to}</span> : null}</span>
        <span className="an-kind">{KIND_LABEL[step.kind] ?? step.kind}</span>
      </div>
      <p className="an-title">{step.title}</p>
      {step.detail ? <p className="an-detail">{step.detail}</p> : null}
      {step.trace ? <TraceView trace={step.trace} open /> : null}
      {step.approval_id ? (
        step.approval_state === "pending" ? (
          <div className="vo-actions">
            <Button onClick={() => onDecide(step.approval_id!, "approve")} disabled={busy}>Approve</Button>
            <Button variant="secondary" onClick={() => onDecide(step.approval_id!, "reject")} disabled={busy}>Reject</Button>
          </div>
        ) : (
          <p className="an-state">Approval: <b>{step.approval_state === "executed" ? "approved and done" : step.approval_state}</b></p>
        )
      ) : null}
    </li>
  );
}

/** The seller's AI team: supervisor + specialists + rules engine + human, run on demand and shown step by step. */
export function AgentNetwork({ refresh }: { refresh: () => void }) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = useCallback(() => listAgentRuns().then((r) => setRuns(r.runs)).catch(() => setRuns((x) => x ?? [])), []);
  const run = runs?.[0] ?? null;
  const running = run?.status === "running";
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), running ? 1500 : 8000);
    return () => window.clearInterval(t);
  }, [load, running]);

  async function start() {
    setStarting(true);
    try {
      const r = await startAgentRun();
      if (r.reused) toast("The team is already working on the shop.");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not start the team.");
    } finally {
      setStarting(false);
    }
  }
  async function decide(id: string, d: "approve" | "reject") {
    setBusy(true);
    try {
      const r = await decideVoiceApproval(id, d);
      toast(r.message);
      refresh();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not record that decision.");
    } finally {
      setBusy(false);
    }
  }

  const waiting = run?.steps.filter((s) => s.approval_state === "pending").length ?? 0;
  return (
    <div className="an">
      <section className="dash-card an-head">
        <div className="dash-card-head">
          <div>
            <p className="dash-eyebrow">Multi-agent system · Gemini + rules engine</p>
            <h3 className="dash-card-title an-h">Your AI team</h3>
            <p className="dash-card-sub">
              The Supervisor reads what the Operations monitor found, plans with Gemini and hands tasks to specialists. Every proposal passes the
              Reasoning engine, which checks the shop's rules and shows why, then waits for you. Nothing changes without your approval.
            </p>
          </div>
          <Button pending={starting || running} onClick={() => void start()}>{running ? "Team is working…" : "✦ Run the team"}</Button>
        </div>
        <Diagram run={run} />
        {run ? (
          <p className="an-status">
            {running ? "Running now" : run.status === "failed" ? "Stopped early" : "Last run"} · {new Date(run.created_at).toLocaleTimeString()} · started from {run.trigger}
            {run.summary ? ` · ${run.summary}` : ""}
            {waiting ? ` · ${waiting} waiting for you` : ""}
          </p>
        ) : (
          <p className="an-status">The team has not run yet. Press “Run the team”, or ask the voice agent: “team ko shop check karne do”.</p>
        )}
      </section>
      {run ? (
        <section className="dash-card" aria-label="Steps of the latest run">
          <h3 className="dash-card-title">What each agent did</h3>
          <ol className="an-steps">
            {run.steps.map((s) => <StepCard key={s.id} step={s} onDecide={decide} busy={busy} />)}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
