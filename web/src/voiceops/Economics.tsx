import { useEffect, useState } from "react";
import { deleteVoiceBaseline, voiceBaselines, type VoiceBaselineRun, type VoiceOverview } from "../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { useToast } from "../ui/Toast";
import { BASELINE_TASKS, taskLabel } from "./baseline";
import { useVoice } from "./VoiceContext";

type Usage = VoiceOverview["usage"];

/** Time the same jobs by hand so "time saved" is a measurement, not a guess. */
export function BaselineCard({ usage, tick }: { usage: Usage; tick: number }) {
  const { stopwatch, startStopwatch, agent, refresh } = useVoice();
  const [task, setTask] = useState(BASELINE_TASKS[0].task);
  const [runs, setRuns] = useState<VoiceBaselineRun[]>([]);
  const toast = useToast();
  useEffect(() => { voiceBaselines().then((r) => setRuns(r.baselines)).catch(() => undefined); }, [tick]);
  const voiceBusy = agent.status === "live" || agent.status === "connecting";
  const measured = usage.baseline.filter((b) => b.source === "measured").length;

  async function remove(id: string) {
    try {
      await deleteVoiceBaseline(id);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not delete the timing.");
    }
  }
  return (
    <Card variant="compact" className="vo-econ">
      <h3 className="vo-h3">Manual baseline</h3>
      <p className="vo-msg">
        Time yourself doing a job the old way: start the timer, do the task by tapping through the normal screens, then press Done.
        Taps and keystrokes are counted. Each task uses the median of all timed runs; tasks with no runs fall back to an assumed time and are marked.
      </p>
      <div className="vo-actions">
        <select className="vo-select" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task to time">
          {BASELINE_TASKS.map((t) => <option key={t.task} value={t.task}>{t.label}</option>)}
        </select>
        <Button disabled={Boolean(stopwatch) || voiceBusy} onClick={() => startStopwatch(task)}>Start timing</Button>
      </div>
      {voiceBusy ? <p className="vo-hint">End the voice session first, so the manual run is not helped by the agent.</p> : null}
      <div className="vo-table-wrap">
        <table className="vo-table">
          <thead><tr><th>Task</th><th>By hand</th><th>Taps</th><th>Keys</th><th>Runs</th><th>Done by voice</th></tr></thead>
          <tbody>
            {usage.baseline.map((b) => (
              <tr key={b.task}>
                <td>{taskLabel(b.task)}</td>
                <td>{b.seconds} s {b.source === "assumed" ? <Badge tone="warning">assumed</Badge> : <Badge tone="success">measured</Badge>}</td>
                <td>{b.taps ?? "–"}</td>
                <td>{b.keys ?? "–"}</td>
                <td>{b.runs}</td>
                <td>{usage.completed_by_task[b.task] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="vo-hint">{measured} of {usage.baseline.length} tasks timed. For a credible baseline, time each task 3 or more times, ideally with real sellers on their own phones.</p>
      {runs.length ? (
        <details>
          <summary className="vo-hint">Your timed runs ({runs.length})</summary>
          <ul className="vo-list vo-runs">
            {runs.map((r) => (
              <li key={r.id} className="vo-row">
                <span>{taskLabel(r.task)}: {Math.round(r.seconds)} s, {r.taps} taps, {r.keys} keys <span className="vo-hint">{new Date(r.created_at).toLocaleString()}</span></span>
                <Button variant="quiet" onClick={() => void remove(r.id)}>Delete</Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ROI calculator: measured unit inputs x the user's business inputs
// ---------------------------------------------------------------------------

type Inputs = { sellers: number; perDay: number; days: number; hourly: number; fx: number; hosting: number; price: number };
const DEFAULTS: Inputs = { sellers: 1000, perDay: 15, days: 26, hourly: 150, fx: 88, hosting: 10, price: 299 };
const STORE_KEY = "voiceops.roi.inputs";
const FIELDS: Array<[keyof Inputs, string, string]> = [
  ["sellers", "Sellers on the platform", ""],
  ["perDay", "Voice workflows per seller per day", ""],
  ["days", "Working days per month", ""],
  ["hourly", "Value of a seller's hour", "₹"],
  ["fx", "Rupees per US dollar", "₹"],
  ["hosting", "Hosting and support per seller per month", "₹"],
  ["price", "Subscription price per seller per month", "₹"],
];

function loadInputs(): Inputs {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Inputs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const inr = (n: number) => {
  const r = Math.round(n);
  return r < 0 ? `−₹${Math.abs(r).toLocaleString("en-IN")}` : `₹${(r || 0).toLocaleString("en-IN")}`;
};

/** Per-workflow unit numbers from this deployment's own data. */
export function unitEconomics(u: Usage) {
  const done = u.workflows_completed;
  // Workflows run only by typing or tapping have no audio, so their voice time and cost would read as zero.
  if (!done || u.voice_seconds <= 0) return null;
  const manualPerWorkflow = u.manual_seconds / done;
  const voicePerWorkflow = u.voice_seconds / done;
  return {
    manualPerWorkflow,
    voicePerWorkflow,
    savedPerWorkflow: Math.max(0, manualPerWorkflow - voicePerWorkflow),
    costPerWorkflowUsd: u.est_cost_per_workflow_usd ?? 0,
    measuredShare: u.workflows_with_measured_baseline / done,
  };
}

function RoiTiles({ tiles }: { tiles: Array<[string, string, ("bad" | undefined)?]> }) {
  return (
    <div className="dash-econ" role="list">
      {tiles.map(([label, value, tone]) => (
        <div key={label} role="listitem" className={`dash-econ-tile${tone === "bad" ? " is-bad" : ""}`}>
          <p className="dash-kpi-label">{label}</p>
          <p className="dash-econ-value">{value}</p>
        </div>
      ))}
    </div>
  );
}

export function RoiCalculator({ usage }: { usage: Usage }) {
  const [inputs, setInputs] = useState<Inputs>(loadInputs);
  const toast = useToast();
  useEffect(() => {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(inputs)); } catch { /* per-viewer convenience only */ }
  }, [inputs]);
  const unit = unitEconomics(usage);

  const set = (key: keyof Inputs, value: string) => {
    const n = Number(value);
    setInputs((s) => ({ ...s, [key]: Number.isFinite(n) && n >= 0 ? n : 0 }));
  };

  if (!unit) {
    return (
      <Card variant="compact" className="vo-econ">
        <h3 className="vo-h3">ROI at scale</h3>
        <p className="vo-msg">
          {usage.workflows_completed
            ? "No voice audio has been measured yet (these workflows were typed or tapped). Complete a few by speaking so the calculator uses real voice time and cost."
            : "Complete a few workflows with the voice agent first. The calculator needs measured time and cost per workflow."}
        </p>
      </Card>
    );
  }

  const workflows = inputs.perDay * inputs.days;
  const hoursSaved = (workflows * unit.savedPerWorkflow) / 3600;
  const valueSaved = hoursSaved * inputs.hourly;
  const aiCost = workflows * unit.costPerWorkflowUsd * inputs.fx;
  const platformCost = aiCost + inputs.hosting;
  const margin = inputs.price - platformCost;
  const sellerNet = valueSaved - inputs.price;

  async function copy() {
    const lines = [
      "ShopBridge VoiceOps unit economics",
      `Measured per workflow: ${Math.round(unit!.voicePerWorkflow)} s by voice vs ${Math.round(unit!.manualPerWorkflow)} s by hand (${usage.workflows_with_measured_baseline} of ${usage.workflows_completed} workflows priced with a measured manual baseline); AI audio cost $${unit!.costPerWorkflowUsd.toFixed(4)} at list price.`,
      `Inputs: ${inputs.perDay} workflows/day x ${inputs.days} days, seller hour ${inr(inputs.hourly)}, hosting ${inr(inputs.hosting)}/seller/month, price ${inr(inputs.price)}/seller/month, ₹${inputs.fx}/USD.`,
      `Per seller per month: ${hoursSaved.toFixed(1)} h saved worth ${inr(valueSaved)}; platform cost ${inr(platformCost)} (AI ${inr(aiCost)}); platform margin ${inr(margin)}; seller net after subscription ${inr(sellerNet)}.`,
      `At ${inputs.sellers.toLocaleString("en-IN")} sellers per month: ${Math.round(hoursSaved * inputs.sellers).toLocaleString("en-IN")} h saved, revenue ${inr(inputs.price * inputs.sellers)}, margin ${inr(margin * inputs.sellers)}.`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("ROI summary copied.");
    } catch {
      toast("Could not copy. Select the numbers by hand.");
    }
  }

  return (
    <Card variant="compact" className="vo-econ">
      <h3 className="vo-h3">ROI at scale</h3>
      <p className="vo-msg">
        Measured here, per workflow: <strong>{Math.round(unit.voicePerWorkflow)} s</strong> by voice vs <strong>{Math.round(unit.manualPerWorkflow)} s</strong> by hand,
        AI audio cost <strong>${unit.costPerWorkflowUsd.toFixed(4)}</strong>.{" "}
        {unit.measuredShare < 1
          ? <Badge tone="warning">{usage.workflows_with_measured_baseline} of {usage.workflows_completed} workflows use a measured manual time; the rest are assumed</Badge>
          : <Badge tone="success">manual time fully measured</Badge>}
      </p>
      <div className="vo-roi-inputs">
        {FIELDS.map(([key, label, unitSign]) => (
          <label key={key} className="vo-roi-field">
            <span>{label}{unitSign ? ` (${unitSign})` : ""}</span>
            <input className="vo-select" type="number" min={0} step="any" inputMode="decimal" value={inputs[key]} onChange={(e) => set(key, e.target.value)} />
          </label>
        ))}
      </div>
      <p className="vo-hint">The fields above are your business inputs. Change them to your own numbers; they are saved in this browser only.</p>
      <p className="dash-eyebrow">Per seller, per month</p>
      <RoiTiles tiles={[
        ["Hours saved", hoursSaved.toFixed(1)],
        ["Value of time saved", inr(valueSaved)],
        ["AI cost (audio, list price)", inr(aiCost)],
        ["Platform margin", inr(margin), margin < 0 ? "bad" : undefined],
        ["Seller net after price", inr(sellerNet), sellerNet < 0 ? "bad" : undefined],
      ]} />
      <p className="dash-eyebrow">At {inputs.sellers.toLocaleString("en-IN")} sellers, per month</p>
      <RoiTiles tiles={[
        ["Seller hours saved", Math.round(hoursSaved * inputs.sellers).toLocaleString("en-IN")],
        ["Revenue", inr(inputs.price * inputs.sellers)],
        ["AI spend", inr(aiCost * inputs.sellers)],
        ["Gross margin", inputs.price ? `${Math.round((margin / inputs.price) * 100)}%` : "–", margin < 0 ? "bad" : undefined],
      ]} />
      <p className="vo-hint">
        Voice time counts every second of audio in the sessions (greetings and lookups too), so savings are understated rather than overstated.
        AI cost excludes text tokens. Hosting, price, volume and the value of an hour are your assumptions.
      </p>
      <div className="vo-actions"><Button variant="secondary" onClick={() => void copy()}>Copy summary</Button></div>
    </Card>
  );
}
