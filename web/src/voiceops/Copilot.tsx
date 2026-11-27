import { useCallback, useEffect, useState } from "react";
import {
  chatCredentials, copilotOverview, copilotScan, decideVoiceApproval, dismissCopilotAlert, listOrders, proposeCopilotAlert, refreshCopilotInsights,
  type CopilotAlert, type CopilotForecast, type CopilotOverview, type CopilotProposal,
} from "../api";
import { connectChat, loadHistory } from "../chat/nexconn";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useVoice } from "./VoiceContext";

const KIND_ICON: Record<CopilotAlert["kind"], string> = { stockout: "📉", sla_risk: "⏱", stuck_shipment: "🚚" };
const TONE: Record<string, "danger" | "warning" | "neutral"> = { critical: "danger", warning: "warning", info: "neutral" };
const STOCK_TONE: Record<CopilotForecast["status"], "danger" | "warning" | "success" | "neutral"> = { critical: "danger", warning: "warning", ok: "success", no_demand: "neutral" };
const STOCK_TEXT: Record<CopilotForecast["status"], string> = { critical: "Runs out first", warning: "Reorder now", ok: "Covered", no_demand: "No sales" };
const RISK_TONE: Record<string, "danger" | "warning" | "accent" | "success"> = { late: "danger", high: "warning", medium: "accent", low: "success" };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const trendArrow = (t: CopilotForecast["trend"]) => (t === "rising" ? "↑" : t === "falling" ? "↓" : "→");

/** Pull recent order chats from the chat service so the server can mine them (it re-checks ownership). */
async function gatherConversations(): Promise<Array<{ orderId: string; transcript: Array<{ role: string; text: string }> }>> {
  const { orders } = await listOrders();
  const rooms = orders.filter((o) => o.channelId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20);
  if (!rooms.length) return [];
  const credentials = await chatCredentials();
  await connectChat(credentials.appKey, credentials.token, credentials.userId);
  const out: Array<{ orderId: string; transcript: Array<{ role: string; text: string }> }> = [];
  for (const o of rooms) {
    try {
      const { lines } = await loadHistory(o.channelId!);
      const transcript = lines
        .filter((l) => l.text)
        .slice(-30)
        .map((l) => ({ role: l.system ? "event" : l.senderId === o.buyer.id ? "buyer" : l.senderId === o.seller.id ? "seller" : "support", text: l.text.slice(0, 400) }));
      if (transcript.some((t) => t.role === "buyer")) out.push({ orderId: o.id, transcript });
    } catch {
      // a conversation that cannot load is skipped
    }
  }
  return out;
}

function CoverBar({ f }: { f: CopilotForecast }) {
  if (f.days_of_cover === null) return <span className="cp-cover is-empty" aria-hidden="true" />;
  const scale = 21;
  const width = Math.min(100, (f.days_of_cover / scale) * 100);
  const lead = Math.min(100, (f.lead_time_days / scale) * 100);
  return (
    <span className="cp-cover" role="img" aria-label={`${f.days_of_cover} days of stock; supplier takes ${f.lead_time_days} days`}>
      <span className={`cp-cover-fill is-${f.status}`} style={{ width: `${width}%` }} />
      <span className="cp-cover-lead" style={{ left: `${lead}%` }} title={`Supplier lead time: ${f.lead_time_days} days`} />
    </span>
  );
}

function AlertRow({ alert, onChange }: { alert: CopilotAlert; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<CopilotProposal | null>(null);
  const pendingId = proposal?.approval?.id ?? (alert.state === "proposed" && alert.approval_state === "pending" ? alert.approval_id : null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : "Could not do that."); } finally { setBusy(false); onChange(); }
  };
  const prepare = () => run(async () => {
    const r = await proposeCopilotAlert(alert.id);
    if (r.approval) setProposal(r);
    else toast(r.message);
  });
  const decide = (d: "approve" | "reject") => run(async () => {
    const r = await decideVoiceApproval(pendingId!, d);
    toast(r.message);
    setProposal(null);
    await copilotScan().catch(() => undefined);
  });
  const done = alert.state === "proposed" && alert.approval_state === "executed";
  const closed = alert.state === "resolved" || alert.state === "dismissed";
  return (
    <li className={`dash-att is-${closed ? "neutral" : TONE[alert.severity]}${closed ? " is-closed" : ""}`}>
      <span className="dash-att-icon" aria-hidden="true">{KIND_ICON[alert.kind]}</span>
      <div className="dash-att-copy">
        <strong>{alert.title}</strong>
        <span>{alert.detail}</span>
        {pendingId ? (
          <div className="cp-proposal" role="group" aria-label="Waiting for your approval">
            {proposal?.approval ? <p className="vo-readback">“{proposal.approval.readback}”</p> : <p className="vo-hint">Proposal waiting for your approval.</p>}
            {proposal?.approval?.tier === "critical" ? <p className="vo-hint">Critical: only your tap approves this.</p> : null}
            <div className="vo-actions">
              <Button onClick={() => void decide("approve")} disabled={busy}>Approve</Button>
              <Button variant="secondary" onClick={() => void decide("reject")} disabled={busy}>Reject</Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="dash-att-action cp-actions">
        {closed ? <Badge tone="success">{alert.state === "resolved" ? "Resolved" : "Dismissed"}</Badge>
          : done ? <Badge tone="success">Action taken</Badge>
          : pendingId ? <Badge tone="warning">Needs your yes</Badge>
          : alert.suggestion ? <Button onClick={() => void prepare()} disabled={busy}>✦ {alert.suggestion.label}</Button>
          : <Badge tone="neutral">Needs a person</Badge>}
        {!closed && !pendingId ? <Button variant="quiet" onClick={() => void run(() => dismissCopilotAlert(alert.id))} disabled={busy}>Dismiss</Button> : null}
      </div>
    </li>
  );
}

export function CopilotTab({ tick, refresh }: { tick: number; refresh: () => void }) {
  const toast = useToast();
  const { agent } = useVoice();
  const [data, setData] = useState<CopilotOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [mining, setMining] = useState(false);

  const load = useCallback(async () => {
    try { setData(await copilotOverview()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Could not load the co-pilot."); }
  }, []);
  const scan = useCallback(async (quiet = false) => {
    setScanning(true);
    try {
      const r = await copilotScan();
      if (!quiet) toast(r.raised ? `${r.raised} new alert${r.raised > 1 ? "s" : ""}` : r.resolved ? `${r.resolved} alert${r.resolved > 1 ? "s" : ""} cleared` : "Nothing new");
    } catch (e) {
      if (!quiet) toast(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
      await load();
    }
  }, [load, toast]);
  useEffect(() => { void scan(true); }, [scan]);
  useEffect(() => { if (tick) void load(); }, [tick, load]);

  const mine = async () => {
    setMining(true);
    try {
      const conversations = await gatherConversations();
      const r = await refreshCopilotInsights(conversations);
      toast(r.insights.length ? `${r.insights.length} theme${r.insights.length > 1 ? "s" : ""} from ${r.sources} source${r.sources > 1 ? "s" : ""}` : "No clear themes yet.");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not read the chats.");
    } finally {
      setMining(false);
    }
  };
  const onChange = () => { void load(); refresh(); };

  if (error) return <p className="vo-error" role="alert">{error}</p>;
  if (!data) return <p className="vo-msg">Checking stock, dispatch deadlines and couriers…</p>;
  const open = data.alerts.filter((a) => a.state === "open" || a.state === "proposed");
  const closed = data.alerts.filter((a) => a.state === "resolved" || a.state === "dismissed").slice(0, 4);
  const flagged = data.sla.filter((r) => r.level !== "low");

  return (
    <div className="cp dash">
      <section className="dash-card cp-hero" aria-labelledby="cp-h">
        <header className="dash-card-head">
          <div>
            <h2 id="cp-h" className="dash-card-title">Co-pilot: what needs you before it goes wrong</h2>
            <p className="dash-card-sub">
              Forecasts stock from your own sales, predicts orders that will miss the 24 h dispatch promise, and watches courier tracking.
              It checks every 15 minutes and proposes the fix; nothing changes until you approve.
            </p>
          </div>
          <div className="cp-hero-actions">
            <Button variant="secondary" onClick={() => void scan()} disabled={scanning}>{scanning ? "Scanning…" : "Scan now"}</Button>
            <Button onClick={() => agent.ask("Co-pilot briefing do: kya dhyan dena hai abhi?")}>🎙 Ask by voice</Button>
          </div>
        </header>
        {open.length ? (
          <ul className="dash-att-list">{open.map((a) => <AlertRow key={a.id} alert={a} onChange={onChange} />)}</ul>
        ) : (
          <p className="dash-clear"><span aria-hidden="true">✓</span> Nothing is about to go wrong: stock covers demand, orders are on track and parcels are moving.</p>
        )}
        {closed.length ? <ul className="dash-att-list cp-closed">{closed.map((a) => <AlertRow key={a.id} alert={a} onChange={onChange} />)}</ul> : null}
        <p className="dash-card-foot">
          {data.last_scan ? `Last scan ${ago(data.last_scan.created_at)} (${data.last_scan.trigger}, ${data.last_scan.ms} ms).` : "Not scanned yet."} Supplier and courier connections are simulated in this prototype.
        </p>
      </section>

      <section className="dash-card" aria-labelledby="cp-stock-h">
        <header className="dash-card-head">
          <div>
            <h3 id="cp-stock-h" className="dash-card-title">Stock forecast</h3>
            <p className="dash-card-sub">From the last 28 days of orders (recent week weighted more). The bar is days of stock left; the tick is how long the supplier takes.</p>
          </div>
        </header>
        <div className="cp-table-wrap">
          <table className="cp-table">
            <thead><tr><th>Product</th><th>In stock</th><th>Sells / day</th><th>Days left</th><th>Supplier</th><th>Suggest</th><th>Status</th></tr></thead>
            <tbody>
              {data.forecasts.map((f) => (
                <tr key={f.product_id} title={f.reason}>
                  <td className="cp-name">{f.name}</td>
                  <td>{f.stock}{f.on_order ? <small> +{f.on_order} coming</small> : null}</td>
                  <td>{f.velocity_per_day} <span className="cp-trend" aria-label={f.trend}>{trendArrow(f.trend)}</span></td>
                  <td><div className="cp-days"><CoverBar f={f} /><span>{f.days_of_cover ?? "–"}</span></div></td>
                  <td>{f.supplier ? <>{f.supplier.name}<small> · {f.lead_time_days} d</small></> : <small>none set up</small>}</td>
                  <td>{f.suggested_qty ? `${f.suggested_qty}${f.supplier ? ` · ${inr(f.suggested_qty * f.supplier.unit_cost)}` : ""}` : "–"}</td>
                  <td><Badge tone={STOCK_TONE[f.status]}>{STOCK_TEXT[f.status]}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="dash-grid-2">
        <section className="dash-card" aria-labelledby="cp-sla-h">
          <header className="dash-card-head">
            <div>
              <h3 id="cp-sla-h" className="dash-card-title">Dispatch risk</h3>
              <p className="dash-card-sub">
                {data.handling.hours !== null ? `You usually dispatch in ${data.handling.hours.toFixed(1)} h (median of ${data.handling.samples} orders).` : "No dispatch history yet; assuming 18 h."} Promise: within 24 h.
              </p>
            </div>
          </header>
          {flagged.length ? (
            <ul className="cp-list">
              {flagged.map((r) => (
                <li key={r.order_id} className="cp-item">
                  <div className="cp-item-head"><strong>Order {r.order_no} · {r.customer}</strong><Badge tone={RISK_TONE[r.level]}>{r.level === "late" ? "Late" : `${Math.round(r.risk * 100)}% risk`}</Badge></div>
                  <p className="vo-msg">{r.reason}</p>
                </li>
              ))}
            </ul>
          ) : <p className="dash-empty">Every open order is on track.</p>}
        </section>

        <section className="dash-card" aria-labelledby="cp-ship-h">
          <header className="dash-card-head">
            <div>
              <h3 id="cp-ship-h" className="dash-card-title">Parcels in transit</h3>
              <p className="dash-card-sub">Stuck = the courier says so, or no scan for 36 h.</p>
            </div>
          </header>
          {data.shipments.length ? (
            <ul className="cp-list">
              {data.shipments.map((s) => (
                <li key={s.order_id} className={`cp-item${s.stuck ? " is-stuck" : ""}`}>
                  <div className="cp-item-head"><strong>Order {s.order_no} · {s.courier} {s.awb}</strong><Badge tone={s.stuck ? "danger" : "success"}>{s.stuck ? "Stuck" : "Moving"}</Badge></div>
                  <ol className="cp-track">
                    {s.events.slice(-4).map((e, i) => <li key={i}><span>{e.status.replace(/_/g, " ")}</span>{e.location ? ` · ${e.location}` : ""} <small>{ago(e.at)}</small></li>)}
                  </ol>
                </li>
              ))}
            </ul>
          ) : <p className="dash-empty">No parcels in transit.</p>}
        </section>
      </div>

      <section className="dash-card" aria-labelledby="cp-ins-h">
        <header className="dash-card-head">
          <div>
            <h3 id="cp-ins-h" className="dash-card-title">What customers are telling you</h3>
            <p className="dash-card-sub">
              Gemini reads your order chats, return reasons and support notes. Every theme shows the customer's exact words; quotes that are not in the chats are thrown away.
              {data.insights.as_of ? ` Updated ${ago(data.insights.as_of)}.` : ""}
            </p>
          </div>
          <Button variant="secondary" onClick={() => void mine()} disabled={mining}>{mining ? "Reading chats…" : "Refresh insights"}</Button>
        </header>
        {data.insights.items.length ? (
          <ul className="cp-insights">
            {data.insights.items.map((i, k) => (
              <li key={k} className={`cp-insight is-${i.kind}`}>
                <div className="cp-item-head">
                  <strong>{i.theme}</strong>
                  <span className="cp-insight-meta"><Badge tone={i.kind === "complaint" ? "danger" : i.kind === "praise" ? "success" : "accent"}>{i.kind}</Badge>{i.product_name ? <small>{i.product_name}</small> : null}</span>
                </div>
                {i.suggestion ? <p className="cp-suggest">→ {i.suggestion}</p> : null}
                {i.evidence.slice(0, 2).map((e, j) => (
                  <blockquote key={j} className="cp-quote">
                    “{e.quote}”{e.translation ? <span className="cp-quote-tr">{e.translation}</span> : null}
                    <cite>{e.label}</cite>
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
        ) : <p className="dash-empty">No insights yet. Press Refresh insights to read your order chats.</p>}
      </section>

      {data.purchase_orders.length ? (
        <section className="dash-card" aria-labelledby="cp-po-h">
          <h3 id="cp-po-h" className="dash-card-title">Purchase orders</h3>
          <ul className="cp-list">
            {data.purchase_orders.map((p) => (
              <li key={p.id} className="cp-item">
                <div className="cp-item-head">
                  <strong>{p.quantity} × {p.product_name} · {p.supplier}</strong>
                  <Badge tone={p.state === "cancelled" ? "neutral" : p.state === "received" ? "success" : "accent"}>{p.state}</Badge>
                </div>
                <p className="vo-msg">{inr(p.total)}{p.supplier_ref ? ` · ${p.supplier_ref}` : ""}{p.eta && p.state !== "cancelled" ? ` · arriving ${new Date(p.eta).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : ""}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
