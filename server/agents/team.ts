/**
 * Multi-agent team for a seller's shop.
 *
 *   Operations monitor ──observes──▶ Supervisor ──plans & hands off──▶ specialists
 *        Customer-comms agent  · Inventory agent · Support-triage agent
 *   specialists ──propose──▶ Reasoning engine (rules, server/agents/reasoning.ts) ──▶ Human approval
 *
 * The Supervisor plans with Gemini (JSON) and falls back to deterministic rules when Gemini is unavailable.
 * Specialists never write data themselves: real changes go through the VoiceOps orchestrator, so every proposal
 * gets the same ownership/policy checks, a reasoning trace, idempotency and a human approval. Every observation,
 * handoff, proposal and decision is stored as a step, so the whole run is visible and auditable.
 */
import { randomBytes } from "node:crypto";
import { generateText } from "../assist";
import { getPool } from "../db/pool";
import { HttpError } from "../errors";
import { listRequests, orderParticipants } from "../store";
import type { UserRecord } from "../store-types";
import { parseModelJson, triageCase } from "../triage";
import * as orchestrator from "../voiceops/orchestrator";
import type { Trace } from "./reasoning";
import { loadForecasts, loadShipments, loadSlaRisks, type ProductForecast } from "../copilot/data";

export const AGENTS = {
  supervisor: { name: "Supervisor", role: "Plans the work and hands tasks to specialists" },
  monitor: { name: "Operations monitor", role: "Forecasts stockouts, dispatch risk and stuck parcels" },
  comms: { name: "Customer-comms agent", role: "Drafts customer updates" },
  inventory: { name: "Inventory agent", role: "Restocks from suppliers before products run out" },
  logistics: { name: "Logistics agent", role: "Re-books stuck parcels and flags orders that may miss dispatch" },
  triage: { name: "Support-triage agent", role: "Reads open cases and recommends resolutions" },
  reasoning: { name: "Reasoning engine", role: "Checks every proposal against shop rules" },
  human: { name: "You", role: "Approve or reject; nothing changes without you" },
} as const;
export type AgentId = keyof typeof AGENTS;
type Specialist = "comms" | "inventory" | "logistics" | "triage";
type Task = { agent: Specialist; goal: string; why: string };

const id = (p: string) => `${p}${randomBytes(6).toString("hex")}`;
const RESTOCK_TO = 10;
const MAX_RESTOCKS = 2;

class Run {
  seq = 0;
  constructor(readonly runId: string) {}
  async step(agent: AgentId, kind: string, title: string, extra: { to?: AgentId; detail?: string; trace?: Trace; approvalId?: string } = {}) {
    await getPool().query(
      `INSERT INTO agent_steps (id, run_id, seq, agent, to_agent, kind, title, detail, trace, approval_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [id("stp"), this.runId, ++this.seq, agent, extra.to ?? null, kind, title.slice(0, 300), extra.detail?.slice(0, 2000) ?? null,
        extra.trace ? JSON.stringify(extra.trace) : null, extra.approvalId ?? null],
    );
  }
}

type Observations = {
  summary: { awaiting_dispatch: number; delayed: number[]; low_stock_products: number; open_returns: number; pending_approvals: number };
  lowStock: Array<{ id: string; name: string; stock: number }>;
  cases: Array<{ id: string; orderId: string; status: string; note: string }>;
  /** Forecast says these run out before (critical) or around (warning) a restock could arrive. */
  stockouts?: ProductForecast[];
  stuck?: Array<{ order_no: number; courier: string; reason: string }>;
  atRisk?: Array<{ order_no: number; customer: string; reason: string }>;
};

/** Deterministic plan: used when Gemini is unavailable, and to validate Gemini's plan. */
export function rulePlan(obs: Observations): Task[] {
  const tasks: Task[] = [];
  if (obs.summary.delayed.length) tasks.push({ agent: "comms", goal: `Tell the ${obs.summary.delayed.length} delayed customer(s) about the delay`, why: `Orders ${obs.summary.delayed.join(", ")} are past 24 h without dispatch.` });
  const stockouts = (obs.stockouts ?? []).filter((f) => f.supplier && f.suggested_qty > 0);
  if (stockouts.length) {
    tasks.push({ agent: "inventory", goal: `Order ${stockouts.slice(0, MAX_RESTOCKS).map((f) => f.name).join(" and ")} from the supplier`, why: stockouts.slice(0, MAX_RESTOCKS).map((f) => `${f.name}: ${f.reason}`).join(" ") });
  } else if (obs.lowStock.length) {
    tasks.push({ agent: "inventory", goal: `Restock ${obs.lowStock.slice(0, MAX_RESTOCKS).map((p) => p.name).join(" and ")}`, why: `${obs.lowStock.length} product(s) are at 5 or fewer.` });
  }
  if (obs.stuck?.length || obs.atRisk?.length) {
    tasks.push({
      agent: "logistics",
      goal: [obs.stuck?.length ? `Re-book ${obs.stuck.length} stuck parcel(s)` : "", obs.atRisk?.length ? `warn ${obs.atRisk.length} customer(s) whose order may miss dispatch` : ""].filter(Boolean).join(" and "),
      why: [...(obs.stuck ?? []).map((s) => `Order ${s.order_no}: ${s.reason}`), ...(obs.atRisk ?? []).map((r) => `Order ${r.order_no}: ${r.reason}`)].join(" "),
    });
  }
  if (obs.cases.length) tasks.push({ agent: "triage", goal: `Triage ${obs.cases.length} open support case(s)`, why: "Buyers are waiting on a resolution." });
  return tasks;
}

async function supervisorPlan(obs: Observations): Promise<{ tasks: Task[]; source: string; rationale: string }> {
  const allowed = rulePlan(obs);
  if (!allowed.length) return { tasks: [], source: "rules", rationale: "Nothing needs attention right now." };
  try {
    const { text, model } = await generateText({
      system: `You are the Supervisor of a team of AI agents running a small Indian online shop. Decide which specialists should act now and in what order.
Specialists: comms (customer updates for delayed orders), inventory (supplier restocks for predicted stockouts), logistics (stuck parcels, orders that may miss dispatch), triage (support cases).
Return JSON: {"order": [specialist names, most urgent first], "rationale": one or two sentences}. Only use specialists that have work in the OBSERVATIONS.`,
      prompt: `OBSERVATIONS (JSON):\n${JSON.stringify({ delayed_orders: obs.summary.delayed, predicted_stockouts: (obs.stockouts ?? []).map((f) => f.reason), low_stock: obs.lowStock.map((p) => `${p.name}: ${p.stock}`), stuck_parcels: (obs.stuck ?? []).map((s) => s.reason), dispatch_at_risk: (obs.atRisk ?? []).map((r) => r.order_no), open_support_cases: obs.cases.length, pending_approvals: obs.summary.pending_approvals })}`,
      temperature: 0.2,
      maxOutputTokens: 1024,
      purpose: "team plan",
      json: true,
    });
    const raw = parseModelJson(text) as { order?: unknown; rationale?: unknown };
    const order = (Array.isArray(raw.order) ? raw.order : []).map(String);
    const tasks = order.map((a) => allowed.find((t) => t.agent === a)).filter((t): t is Task => Boolean(t));
    for (const t of allowed) if (!tasks.includes(t)) tasks.push(t); // never drop work the rules say exists
    return { tasks, source: `Gemini (${model})`, rationale: String(raw.rationale ?? "").slice(0, 400) || "Ordered by urgency." };
  } catch {
    return { tasks: allowed, source: "rules (Gemini unavailable)", rationale: "Customers waiting first, then stock, then support." };
  }
}

async function draftDelayMessage(): Promise<{ text: string; source: string }> {
  try {
    const { text, model } = await generateText({
      system: "Write one short, warm apology to customers whose handmade order is running late. One or two sentences, at most 30 words. No names (a greeting with each name is added automatically), no dates, no tracking numbers, no refunds or discounts. Plain text only.",
      prompt: "Draft the delay update.",
      temperature: 0.4,
      maxOutputTokens: 1024,
      purpose: "delay message",
    });
    return { text: text.replace(/\s+/g, " ").trim().slice(0, 300), source: `Gemini (${model})` };
  } catch {
    return { text: "your order is running a little late. We're sorry for the wait and will update you as soon as it ships.", source: "template (Gemini unavailable)" };
  }
}

async function observe(user: UserRecord, ctx: orchestrator.Ctx): Promise<Observations> {
  const summary = (await orchestrator.runTool(ctx, "business_summary", {})).data as Observations["summary"];
  const lowStock = (await getPool().query("SELECT id, name, stock FROM products WHERE seller_id = $1 AND stock <= 5 ORDER BY stock, name LIMIT 5", [user.id])).rows
    .map((r) => ({ id: r.id as string, name: r.name as string, stock: Number(r.stock) }));
  const cases = (await listRequests(user).catch(() => []))
    .filter((r) => r.orderId && r.status !== "completed")
    .map((r) => ({ id: r.id, orderId: r.orderId!, status: r.status, note: r.note }));
  const client = await getPool().connect();
  try {
    const stockouts = (await loadForecasts(client, user.id)).filter((f) => f.status === "critical" || f.status === "warning");
    const stuck = (await loadShipments(client, user.id)).filter((s) => s.stuck).map((s) => ({ order_no: s.order_no, courier: s.courier, reason: s.reason }));
    const atRisk = (await loadSlaRisks(client, user.id)).risks.filter((r) => r.level === "high").map((r) => ({ order_no: r.order_no, customer: r.customer, reason: r.reason }));
    return { summary, lowStock, cases, stockouts, stuck, atRisk };
  } finally {
    client.release();
  }
}

async function execute(user: UserRecord, run: Run, ctx: orchestrator.Ctx): Promise<string> {
  const obs = await observe(user, ctx);
  await run.step("monitor", "observe", "Scanned orders, stock and support cases", {
    to: "supervisor",
    detail: `${obs.summary.delayed.length} delayed (${obs.summary.delayed.join(", ") || "none"}) · ${obs.stockouts?.length ?? 0} predicted stockout(s)${obs.stockouts?.length ? ` (${obs.stockouts.map((f) => f.name).join(", ")})` : ""} · ${obs.stuck?.length ?? 0} stuck parcel(s) · ${obs.atRisk?.length ?? 0} order(s) at risk of missing dispatch · ${obs.lowStock.length} low-stock product(s) · ${obs.cases.length} open support case(s) · ${obs.summary.pending_approvals} approval(s) already waiting.`,
  });

  const plan = await supervisorPlan(obs);
  await getPool().query("UPDATE agent_runs SET plan = $2::jsonb WHERE id = $1", [run.runId, JSON.stringify(plan)]);
  await run.step("supervisor", "plan", plan.tasks.length ? `Plan: ${plan.tasks.length} task(s), in order` : "Plan: nothing to do", {
    detail: `${plan.rationale} (planned by ${plan.source})${plan.tasks.length ? "\n" + plan.tasks.map((t, i) => `${i + 1}. ${AGENTS[t.agent].name}: ${t.goal}. Why: ${t.why}`).join("\n") : ""}`,
  });

  let proposals = 0;
  let recommendations = 0;
  for (const task of plan.tasks) {
    await run.step("supervisor", "handoff", `Handed to ${AGENTS[task.agent].name}: ${task.goal}`, { to: task.agent, detail: task.why });

    if (task.agent === "comms") {
      const draft = await draftDelayMessage();
      await run.step("comms", "draft", "Drafted the delay update", { detail: `"${draft.text}" (written by ${draft.source})` });
      const r = await orchestrator.runTool(ctx, "notify_delayed_customers", { message: draft.text });
      await run.step("comms", "propose", `Proposed: ${r.approval?.readback ?? r.message}`, { to: "reasoning" });
      await run.step("reasoning", "decide", r.trace?.explanation ?? r.message, { to: r.approval ? "human" : undefined, trace: r.trace, approvalId: r.approval?.id });
      if (r.approval) proposals++;
    }

    if (task.agent === "inventory" && (obs.stockouts ?? []).some((f) => f.supplier && f.suggested_qty > 0)) {
      for (const f of (obs.stockouts ?? []).filter((x) => x.supplier && x.suggested_qty > 0).slice(0, MAX_RESTOCKS)) {
        const r = await orchestrator.runTool(ctx, "create_purchase_order", { product_name: f.name, quantity: f.suggested_qty });
        await run.step("inventory", "propose", `Proposed: ${r.approval?.readback ?? r.message}`, { to: "reasoning", detail: `Forecast: ${f.reason} Suggested ${f.suggested_qty} from ${f.supplier!.name} (lead time ${f.lead_time_days} days).` });
        await run.step("reasoning", "decide", r.trace?.explanation ?? r.message, { to: r.approval ? "human" : undefined, trace: r.trace, approvalId: r.approval?.id });
        if (r.approval) proposals++;
      }
    } else if (task.agent === "inventory") {
      for (const p of obs.lowStock.slice(0, MAX_RESTOCKS)) {
        if (p.stock >= RESTOCK_TO) continue;
        const r = await orchestrator.runTool(ctx, "adjust_stock", { product_id: p.id, set_to: RESTOCK_TO });
        await run.step("inventory", "propose", `Proposed: ${r.approval?.readback ?? r.message}`, { to: "reasoning", detail: `${p.name} is at ${p.stock}; restock to ${RESTOCK_TO} so it does not sell out.` });
        await run.step("reasoning", "decide", r.trace?.explanation ?? r.message, { to: r.approval ? "human" : undefined, trace: r.trace, approvalId: r.approval?.id });
        if (r.approval) proposals++;
      }
    }

    if (task.agent === "logistics") {
      for (const s of (obs.stuck ?? []).slice(0, 2)) {
        const r = await orchestrator.runTool(ctx, "reroute_shipment", { order_no: s.order_no });
        await run.step("logistics", "propose", `Proposed: ${r.approval?.readback ?? r.message}`, { to: "reasoning", detail: s.reason });
        await run.step("reasoning", "decide", r.trace?.explanation ?? r.message, { to: r.approval ? "human" : undefined, trace: r.trace, approvalId: r.approval?.id });
        if (r.approval) proposals++;
      }
      for (const a of (obs.atRisk ?? []).slice(0, 2)) {
        const message = `Hi ${a.customer.split(/\s+/)[0]}, your order is being prepared and we will share tracking as soon as it ships. Thank you for your patience!`;
        const r = await orchestrator.runTool(ctx, "send_customer_message", { order_no: a.order_no, message });
        await run.step("logistics", "propose", `Proposed: ${r.approval?.readback ?? r.message}`, { to: "reasoning", detail: `Dispatch risk: ${a.reason}` });
        await run.step("reasoning", "decide", r.trace?.explanation ?? r.message, { to: r.approval ? "human" : undefined, trace: r.trace, approvalId: r.approval?.id });
        if (r.approval) proposals++;
      }
    }

    if (task.agent === "triage") {
      for (const c of obs.cases.slice(0, 3)) {
        try {
          const support = (await listRequests(user)).find((x) => x.id === c.id)!;
          const parts = await orderParticipants(c.orderId);
          const t = await triageCase({ ...parts, support });
          await run.step("triage", "recommend", `${t.urgency} urgency · ${t.issue.replace(/_/g, " ")} · suggest ${t.suggestion.resolution}`, {
            to: "human",
            detail: `${t.summary}\nSuggested: ${t.suggestion.resolution}. ${t.suggestion.note}${t.policyNote ? `\n${t.policyNote}` : ""}\nThe support agent decides in the Queue; the buyer confirms. (Gemini ${t.model})`,
          });
          recommendations++;
        } catch (error) {
          await run.step("triage", "error", "Could not triage a case right now", { detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  const summary = plan.tasks.length
    ? `${plan.tasks.length} task(s) handled: ${proposals} proposal(s) waiting for your approval, ${recommendations} support recommendation(s) for the support desk.`
    : "All clear: no delayed orders, low stock or open support cases.";
  await run.step("supervisor", "summary", summary, { to: proposals ? "human" : undefined });
  return summary;
}

/** Start a team run in the background; returns at once with the run id (the UI follows the steps live). */
export async function startTeamRun(user: UserRecord, trigger: "dashboard" | "voice", notifier: orchestrator.Notifier): Promise<{ runId: string; reused: boolean }> {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "The agent team runs for sellers.");
  const busy = (await getPool().query(
    "SELECT id FROM agent_runs WHERE user_id = $1 AND status = 'running' AND created_at > now() - interval '5 minutes' ORDER BY created_at DESC LIMIT 1",
    [user.id],
  )).rows[0];
  if (busy) return { runId: busy.id, reused: true };
  const runId = id("run");
  const sessionId = await orchestrator.startSession(user, "agents");
  await getPool().query("INSERT INTO agent_runs (id, user_id, session_id, trigger) VALUES ($1,$2,$3,$4)", [runId, user.id, sessionId, trigger]);
  const run = new Run(runId);
  const ctx: orchestrator.Ctx = { user, sessionId, notifier };
  void execute(user, run, ctx)
    .then((summary) => getPool().query("UPDATE agent_runs SET status = 'done', summary = $2, finished_at = now() WHERE id = $1", [runId, summary]))
    .catch(async (error) => {
      console.error("Agent team run failed:", error);
      await run.step("supervisor", "error", "The run stopped early", { detail: error instanceof Error ? error.message : String(error) }).catch(() => {});
      await getPool().query("UPDATE agent_runs SET status = 'failed', finished_at = now() WHERE id = $1", [runId]).catch(() => {});
    });
  return { runId, reused: false };
}

/** Recent runs (newest first) with their steps and the live state of any approval a step is waiting on. */
export async function listTeamRuns(user: UserRecord, limit = 5) {
  if (user.role !== "volunteer") throw new HttpError(403, "FORBIDDEN", "The agent team runs for sellers.");
  const runs = (await getPool().query(
    "SELECT id, trigger, status, plan, summary, created_at, finished_at FROM agent_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [user.id, Math.min(Math.max(limit, 1), 20)],
  )).rows;
  if (!runs.length) return [];
  const steps = (await getPool().query(
    `SELECT s.id, s.run_id, s.seq, s.agent, s.to_agent, s.kind, s.title, s.detail, s.trace, s.approval_id, s.created_at,
            CASE WHEN a.state = 'pending' AND a.expires_at <= now() THEN 'expired' ELSE a.state END AS approval_state, a.readback AS approval_readback
       FROM agent_steps s LEFT JOIN voiceops_approvals a ON a.id = s.approval_id
      WHERE s.run_id = ANY($1) ORDER BY s.seq`,
    [runs.map((r) => r.id)],
  )).rows;
  return runs.map((r) => ({ ...r, steps: steps.filter((s) => s.run_id === r.id) }));
}
