import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  decideVoiceApproval,
  resetVoiceDemo,
  voicePreflight,
  voiceDigest,
  undoVoiceAction,
  voiceActivity,
  voiceApprovals,
  voiceOverview,
  type VoiceAction,
  type VoiceApproval,
  type VoiceOverview,
} from "../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Metric, MetricGrid } from "../ui/Metric";
import { useToast } from "../ui/Toast";
import type { TimelineItem } from "./useVoiceAgent";
import { useVoiceAgent } from "./useVoiceAgent";
import { useVoice } from "./VoiceContext";
import { BaselineCard, RoiCalculator } from "./Economics";
import { AiStory } from "../ai/AiStory";

type Tab = "agent" | "how" | "approvals" | "activity" | "overview";

const TOOL_LABEL: Record<string, string> = {
  business_summary: "Business summary",
  list_orders: "Look up orders",
  get_order: "Open order",
  list_low_stock: "Check low stock",
  update_order_status: "Update order status",
  cancel_order: "Cancel order",
  create_return: "Start return",
  send_customer_message: "Message customer",
  adjust_stock: "Adjust stock",
  request_human_review: "Ask a human",
  make_offer: "Offer special price",
  notify_delayed_customers: "Notify delayed customers",
  undo_action: "Undo",
};
const label = (tool: string) => TOOL_LABEL[tool] ?? tool.replace(/_/g, " ");

const STATUS_TONE: Record<string, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  running: "accent",
  succeeded: "success",
  awaiting_approval: "warning",
  approved: "success",
  rejected: "neutral",
  blocked: "danger",
  failed: "danger",
  undone: "neutral",
  started: "accent",
};
const STATUS_TEXT: Record<string, string> = {
  running: "Working",
  succeeded: "Done",
  awaiting_approval: "Needs your OK",
  rejected: "Cancelled",
  blocked: "Blocked",
  failed: "Failed",
  undone: "Undone",
};

const SUGGESTIONS = [
  "Aaj ke pending orders aur low stock check karo.",
  "Jo orders 24 ghante se dispatch nahi hue, unko dikhao.",
  "Order 1004 ko packed mark kar do.",
  "Order 1003 cancel kar do.",
  "Sab delayed customers ko sorry ka message bhej do.",
  "Order 1055 pe Asha ko 10% discount ka offer do.",
];

function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

const AI_STAGES = ["Listens", "Understands", "Decides", "Checks policy", "Asks you", "Done"] as const;

/** Which step of the AI loop is happening right now, from the live transcript and tool timeline. */
function aiStage(agent: ReturnType<typeof useVoiceAgent>): number {
  if (agent.status !== "live") return -1;
  const item = agent.timeline.at(-1);
  const turn = agent.turns.at(-1);
  if (item?.status === "running") return 2;
  if (item?.status === "awaiting_approval") return 4;
  if (turn?.role === "user" && !turn.final) return 1;
  if (item?.status === "blocked") return 3;
  if (item && ["succeeded", "approved"].includes(item.status)) return 5;
  return 0;
}

function AiLoop({ agent }: { agent: ReturnType<typeof useVoiceAgent> }) {
  const stage = aiStage(agent);
  return (
    <ol className="vo-ailoop" aria-label="What the AI is doing">
      {AI_STAGES.map((label, i) => (
        <li key={label} className={i === stage ? "is-now" : i < stage ? "is-past" : undefined} aria-current={i === stage ? "step" : undefined}>{label}</li>
      ))}
    </ol>
  );
}

function Waveform({ level }: { level: (which: "mic" | "agent") => number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const g = node.getContext("2d");
    if (!g) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bars = 32;
    const history = { mic: new Array(bars).fill(0), agent: new Array(bars).fill(0) };
    let raf = 0;
    const draw = () => {
      const style = getComputedStyle(node);
      const mic = style.getPropertyValue("--accent").trim() || "#3a2418";
      const agent = style.getPropertyValue("--success").trim() || "#1f6b45";
      const w = node.width;
      const h = node.height;
      g.clearRect(0, 0, w, h);
      history.mic.push(level("mic")); history.mic.shift();
      history.agent.push(level("agent")); history.agent.shift();
      const slot = w / bars;
      for (let i = 0; i < bars; i++) {
        const m = reduce ? 0.08 : history.mic[i];
        const a = reduce ? 0 : history.agent[i];
        const v = Math.max(m, a, 0.05);
        g.fillStyle = a > m ? agent : mic;
        const bh = Math.max(4, v * h * 0.9);
        g.beginPath();
        g.roundRect(i * slot + slot * 0.2, (h - bh) / 2, slot * 0.6, bh, 3);
        g.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level]);
  return <canvas ref={canvas} className="vo-wave" width={640} height={96} role="img" aria-label="Live audio level" />;
}

function ActionCard({
  item,
  onApprove,
  onReject,
  onUndo,
  busy,
}: {
  item: TimelineItem;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (item: TimelineItem) => void;
  busy: boolean;
}) {
  const waiting = item.status === "awaiting_approval" && item.approval;
  return (
    <li className={`vo-card is-${item.status}`}>
      <div className="vo-card-head">
        <strong>{label(item.name)}</strong>
        <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>{STATUS_TEXT[item.status] ?? item.status}</Badge>
      </div>
      {argsLine(item.args) ? <p className="vo-args">{argsLine(item.args)}</p> : null}
      {waiting ? (
        <div className="vo-approval" role="group" aria-label="Approval needed">
          <p className="vo-readback">“{item.approval!.readback}”</p>
          <div className="vo-actions">
            <Button onClick={() => onApprove(item.approval!.id)} disabled={busy}>Approve</Button>
            <Button variant="secondary" onClick={() => onReject(item.approval!.id)} disabled={busy}>Cancel</Button>
          </div>
          <p className="vo-hint">Or just say “haan, kar do” / “nahi”.</p>
        </div>
      ) : item.message ? (
        <p className="vo-msg">{item.message}</p>
      ) : null}
      <div className="vo-meta">
        {item.latencyMs !== undefined ? <span>{item.latencyMs} ms</span> : null}
        {item.humanInvolved ? <span>Human approved</span> : null}
        {item.status === "succeeded" && ["update_order_status", "cancel_order", "create_return", "adjust_stock"].includes(item.name) ? (
          <button className="vo-link" onClick={() => onUndo(item)} disabled={busy}>Undo</button>
        ) : null}
      </div>
    </li>
  );
}

function AgentTab({ agent, refresh }: { agent: ReturnType<typeof useVoiceAgent>; refresh: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const live = agent.status === "live";
  const transcriptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [agent.turns]);

  const level = useCallback((which: "mic" | "agent") => agent.client.current?.level(which) ?? 0, [agent.client]);
  const last = agent.latencies.at(-1);
  const avg = agent.latencies.length ? Math.round(agent.latencies.reduce((a, b) => a + b, 0) / agent.latencies.length) : null;

  function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    agent.sendText(text.trim());
    setText("");
  }
  async function viaRest(fn: () => Promise<{ message: string }>) {
    setBusy(true);
    try { toast((await fn()).message); refresh(); } catch (caught) { toast(caught instanceof Error ? caught.message : "Could not do that."); } finally { setBusy(false); }
  }
  const approve = (id: string) => (live ? agent.approve(id) : void viaRest(() => decideVoiceApproval(id, "approve")));
  const reject = (id: string) => (live ? agent.reject(id) : void viaRest(() => decideVoiceApproval(id, "reject")));
  const undo = (item: TimelineItem) => (live ? agent.undo(item.actionId) : item.actionId ? void viaRest(() => undoVoiceAction(item.actionId!)) : undefined);

  return (
    <div className="vo-grid">
      <section className="vo-stage" aria-label="Voice agent">
        <Card variant="feature" className="vo-hero">
          <div className="vo-hero-top">
            <div>
              <p className="kicker">{live ? (agent.micOn ? "Listening" : "Mic muted") : agent.status === "connecting" ? "Connecting" : "Voice agent"}</p>
              <h2 className="vo-title">{live ? "Boliye, main sun raha hoon." : "Apne business se baat karo."}</h2>
            </div>
            <div className="vo-lat" aria-live="polite">
              <span className="vo-lat-num">{last ?? "–"}</span>
              <span className="vo-lat-unit">ms to reply</span>
              {avg !== null ? <span className="vo-lat-avg">avg {avg} ms · {agent.latencies.length} turns</span> : null}
            </div>
          </div>
          <p className="vo-aibadge"><span aria-hidden="true">✦</span> AI agent · Gemini Live native audio · server-checked actions</p>
          <AiLoop agent={agent} />
          <Waveform level={level} />
          <div className="vo-controls">
            {live || agent.status === "connecting" ? (
              <>
                <Button variant="danger" onClick={agent.stop}>End session</Button>
                <Button variant="secondary" onClick={() => void agent.toggleMic()} disabled={!live}>{agent.micOn ? "Mute mic" : "Unmute mic"}</Button>
              </>
            ) : (
              <Button magnetic onClick={() => void agent.start()}>Start talking</Button>
            )}
            {agent.model ? <span className="vo-model">{agent.model}</span> : null}
          </div>
          {agent.error ? <p className="vo-error" role="alert">{agent.error}</p> : null}
          <p className="vo-hint">Speak Hindi, Hinglish, Tamil or English. The AI looks things up, proposes the change and waits for your yes. Interrupt it any time.</p>
        </Card>

        <Card variant="form" className="vo-convo">
          <h3 className="vo-h3">Conversation</h3>
          <div className="vo-transcript" aria-live="polite">
            {agent.turns.length === 0 ? (
              <div className="vo-try">
                <p className="vo-hint">Try saying:</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="vo-chip" disabled={!live} onClick={() => agent.sendText(s)}>{s}</button>
                ))}
              </div>
            ) : (
              agent.turns.map((t) => (
                <p key={t.id} className={`vo-turn is-${t.role}${t.final ? "" : " is-live"}`}>
                  <span className="vo-who">{t.role === "user" ? "You" : "Agent"}</span>
                  {t.text}
                  {t.interrupted ? <em className="vo-cut"> — interrupted</em> : null}
                </p>
              ))
            )}
            <div ref={transcriptEnd} />
          </div>
          <form className="vo-type" onSubmit={send}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={live ? "Or type a request…" : "Start a session to type"} disabled={!live} aria-label="Type a request" />
            <Button type="submit" variant="secondary" disabled={!live || !text.trim()}>Send</Button>
          </form>
        </Card>
      </section>

      <aside className="vo-side" aria-label="Agent actions">
        <h3 className="vo-h3">What the agent is doing</h3>
        {agent.timeline.length === 0 ? (
          <p className="vo-hint">Every step the agent takes shows up here, including where it needs you.</p>
        ) : (
          <ol className="vo-timeline">
            {[...agent.timeline].reverse().map((item) => (
              <ActionCard key={item.key} item={item} onApprove={approve} onReject={reject} onUndo={undo} busy={busy} />
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

function ApprovalsTab({ tick, refresh }: { tick: number; refresh: () => void }) {
  const [rows, setRows] = useState<VoiceApproval[] | null>(null);
  const toast = useToast();
  useEffect(() => { voiceApprovals().then((r) => setRows(r.approvals)).catch(() => setRows([])); }, [tick]);
  async function decide(id: string, d: "approve" | "reject") {
    try { toast((await decideVoiceApproval(id, d)).message); } catch (e) { toast(e instanceof Error ? e.message : "Could not do that."); }
    refresh();
  }
  if (!rows) return <p className="vo-hint">Loading…</p>;
  if (!rows.length) return <p className="vo-hint">No approvals yet. Ask the agent to change something and it will wait here for your OK.</p>;
  return (
    <ul className="vo-list">
      {rows.map((a) => (
        <li key={a.id} className="vo-row">
          <div>
            <strong>{label(a.tool)}</strong> <Badge tone={a.state === "pending" ? "warning" : a.state === "executed" ? "success" : "neutral"}>{a.state === "executed" ? "approved & done" : a.state}</Badge>
            <p className="vo-msg">{a.readback}</p>
            <p className="vo-hint">{new Date(a.created_at).toLocaleString()}{a.decided_via ? ` · decided by ${a.decided_via}` : ""}</p>
          </div>
          {a.state === "pending" ? (
            <div className="vo-actions">
              <Button onClick={() => void decide(a.id, "approve")}>Approve</Button>
              <Button variant="secondary" onClick={() => void decide(a.id, "reject")}>Cancel</Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ActivityTab({ tick, refresh }: { tick: number; refresh: () => void }) {
  const [rows, setRows] = useState<VoiceAction[] | null>(null);
  const toast = useToast();
  useEffect(() => { voiceActivity().then((r) => setRows(r.actions)).catch(() => setRows([])); }, [tick]);
  if (!rows) return <p className="vo-hint">Loading…</p>;
  if (!rows.length) return <p className="vo-hint">Nothing yet. Every tool call, block and approval is logged here.</p>;
  return (
    <ul className="vo-list">
      {rows.filter((r) => !["confirm_action", "reject_action"].includes(r.tool)).map((a) => (
        <li key={a.id} className="vo-row">
          <div>
            <strong>{label(a.tool)}</strong> <Badge tone={STATUS_TONE[a.status] ?? "neutral"}>{STATUS_TEXT[a.status] ?? a.status}</Badge>
            {a.human_involved ? <Badge tone="accent">Human in the loop</Badge> : null}
            <p className="vo-args">{argsLine(a.args)}</p>
            {a.result?.message ? <p className="vo-msg">{a.result.message}</p> : null}
            <p className="vo-hint">{new Date(a.created_at).toLocaleString()}{a.latency_ms != null ? ` · ${a.latency_ms} ms` : ""}{a.error_code ? ` · ${a.error_code}` : ""}</p>
          </div>
          {a.status === "succeeded" && ["update_order_status", "cancel_order", "create_return", "adjust_stock"].includes(a.tool) ? (
            <Button variant="quiet" onClick={() => void undoVoiceAction(a.id).then((r) => { toast(r.message); refresh(); }).catch(() => toast("Could not undo."))}>Undo</Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Digest() {
  const [language, setLanguage] = useState("hinglish");
  const [audience, setAudience] = useState("owner");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function make() {
    setBusy(true);
    try { setText((await voiceDigest(language, audience)).text); } catch (e) { toast(e instanceof Error ? e.message : "Could not write the digest."); } finally { setBusy(false); }
  }
  return (
    <Card variant="compact" className="vo-demo">
      <h3 className="vo-h3">Daily digest by Gemini (any language, any audience)</h3>
      <p className="vo-msg">Turns today's agent activity into a short note for the owner, the packing team or waiting customers.</p>
      <div className="vo-actions">
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className="vo-select">
          <option value="en">English</option><option value="hi">हिन्दी</option><option value="ta">தமிழ்</option><option value="hinglish">Hinglish</option>
        </select>
        <select aria-label="Audience" value={audience} onChange={(e) => setAudience(e.target.value)} className="vo-select">
          <option value="owner">Owner (WhatsApp)</option><option value="team">Packing team</option><option value="customer">Waiting customers</option>
        </select>
        <Button variant="secondary" pending={busy} onClick={() => void make()}>Write digest</Button>
      </div>
      {text ? <p className="vo-digest">{text}</p> : null}
    </Card>
  );
}

function Preflight() {
  const [result, setResult] = useState<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> } | null>(null);
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try { setResult(await voicePreflight()); } catch { setResult({ ok: false, checks: [{ name: "Preflight", ok: false, detail: "could not run" }] }); } finally { setRunning(false); }
  }
  return (
    <Card variant="compact" className="vo-demo">
      <h3 className="vo-h3">Pre-demo check</h3>
      <p className="vo-msg">Tests the database, the Gemini keys and Live model, and chat before you go on stage.</p>
      <Button variant="secondary" pending={running} onClick={() => void run()}>Run check</Button>
      {result ? (
        <ul className="vo-list">
          {result.checks.map((c) => (
            <li key={c.name} className="vo-row"><div><strong>{c.name}</strong> <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "OK" : "Problem"}</Badge><p className="vo-msg">{c.detail}</p></div></li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function OverviewTab({ tick, refresh, liveActive }: { tick: number; refresh: () => void; liveActive: boolean }) {
  const [data, setData] = useState<VoiceOverview | null>(null);
  const [resetting, setResetting] = useState(false);
  const toast = useToast();
  async function reset() {
    setResetting(true);
    try {
      const r = await resetVoiceDemo();
      toast(`Demo scenario restored: orders ${r.orders.join(", ")}.${r.rooms.length ? " Orders 1042 and 1050 belong to the demo buyer, who can see messages in the order chat." : ""}`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not reset the demo.");
    } finally {
      setResetting(false);
    }
  }
  useEffect(() => { voiceOverview().then(setData).catch(() => undefined); }, [tick]);
  if (!data) return <p className="vo-hint">Loading…</p>;
  const { summary: s, activity: a, usage: u } = data;
  const saved = Math.max(0, u.manual_seconds - u.voice_seconds);
  const allMeasured = u.workflows_completed > 0 && u.workflows_with_measured_baseline === u.workflows_completed;
  const done = a.succeeded;
  return (
    <>
      <h3 className="vo-h3">Today in your shop</h3>
      <MetricGrid>
        <Metric label="Awaiting dispatch" value={String(s.awaiting_dispatch)} />
        <Metric label="Delayed over 24h" value={String(s.delayed.length)} />
        <Metric label="Low-stock products" value={String(s.low_stock_products)} />
        <Metric label="Open returns" value={String(s.open_returns)} />
        <Metric label="Pending approvals" value={String(s.pending_approvals)} />
      </MetricGrid>
      <h3 className="vo-h3">What the agent has done (measured)</h3>
      <MetricGrid>
        <Metric label="Actions completed" value={String(done)} />
        <Metric label="Blocked by policy" value={String(a.blocked)} />
        <Metric label="Needed a human" value={String(a.human)} />
        <Metric label="Failed" value={String(a.failed)} />
        <Metric label="Avg tool time" value={`${a.avg_latency_ms} ms`} />
      </MetricGrid>
      <h3 className="vo-h3">Performance and economics</h3>
      <MetricGrid>
        <Metric label="Reply latency p50 / p95" value={u.latency.turns ? `${u.latency.p50_ms} / ${u.latency.p95_ms} ms` : "no turns yet"} />
        <Metric label="Voice sessions" value={`${u.sessions} (${(u.input_minutes + u.output_minutes).toFixed(1)} audio min)`} />
        <Metric label="Workflows done / tried" value={`${u.workflows_completed} / ${u.workflows_attempted}`} />
        <Metric label="Cost per workflow" value={u.est_cost_per_workflow_usd !== null ? `$${u.est_cost_per_workflow_usd.toFixed(3)}` : "–"} />
        <Metric label={allMeasured ? "Time saved (measured baseline)" : "Time saved (partly assumed baseline)"} value={u.workflows_completed ? `${Math.round(saved / 60)} min` : "–"} />
        <Metric label="Taps: by hand / by voice" value={u.workflows_with_measured_baseline ? `${u.manual_taps} / ${u.voice_taps}` : "time a task first"} />
      </MetricGrid>
      <p className="vo-hint">Latency, minutes and counts are measured. Time saved compares voice audio time with the manual baseline below: measured where you have timed the task, assumed (90 to 240 s) where you have not. Cost is an audio-minutes estimate at Google's list price for Gemini 3.8 Live (${u.rate_in_per_min_usd}/min in, ${u.rate_out_per_min_usd}/min out), excluding text tokens.</p>
      <BaselineCard usage={u} tick={tick} />
      <RoiCalculator usage={u} />
      <Digest />
      <Preflight />
      {data.demoEnabled ? (
        <Card variant="compact" className="vo-demo">
          <h3 className="vo-h3">Demo scenario</h3>
          <p className="vo-msg">Restores seven demo orders (1042 return, 1050 already shipped, 1051 to 1053 delayed, 1054 past the return window, 1055 fresh), sets two products low on stock and clears the agent history.</p>
          <Button variant="secondary" pending={resetting} disabled={liveActive} onClick={() => void reset()}>Reset demo scenario</Button>
          {liveActive ? <p className="vo-hint">End the voice session first.</p> : null}
        </Card>
      ) : null}
    </>
  );
}

export function VoiceOps() {
  const [tab, setTab] = useState<Tab>("agent");
  const [pending, setPending] = useState(0);
  const [latency, setLatency] = useState<{ p50: number | null; p95: number | null; turns: number }>({ p50: null, p95: null, turns: 0 });
  const { agent, tick, refresh } = useVoice();
  useEffect(() => {
    voiceOverview()
      .then((o) => {
        setPending(o.summary.pending_approvals);
        setLatency({ p50: o.usage.latency.p50_ms, p95: o.usage.latency.p95_ms, turns: o.usage.latency.turns });
      })
      .catch(() => undefined);
  }, [tick]);
  const tabBar = useRef<HTMLDivElement>(null);
  const openTab = (next: Tab) => {
    setTab(next);
    // Each tab starts at its top, even when the previous tab was scrolled far down.
    window.requestAnimationFrame(() => tabBar.current?.scrollIntoView({ block: "nearest" }));
  };
  const tabs: Array<[Tab, string]> = [["agent", "Voice agent"], ["how", "How the AI works"], ["approvals", pending ? `Approvals (${pending})` : "Approvals"], ["activity", "Activity"], ["overview", "Overview"]];
  return (
    <div className="vo-page">
      <div className="vo-tabs" role="tablist" ref={tabBar}>
        {tabs.map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`vo-tab${tab === id ? " is-active" : ""}`} onClick={() => openTab(id)}>{text}</button>
        ))}
      </div>
      <div hidden={tab !== "agent"}><AgentTab agent={agent} refresh={refresh} /></div>
      {tab === "how" ? (
        <AiStory
          variant="app"
          measured={latency}
          onTry={() => {
            openTab("agent");
            if (agent.status === "idle" || agent.status === "error") void agent.start();
          }}
        />
      ) : null}
      {tab === "approvals" ? <ApprovalsTab tick={tick} refresh={refresh} /> : null}
      {tab === "activity" ? <ActivityTab tick={tick} refresh={refresh} /> : null}
      {tab === "overview" ? <OverviewTab tick={tick} refresh={refresh} liveActive={agent.status === "live" || agent.status === "connecting"} /> : null}
    </div>
  );
}
