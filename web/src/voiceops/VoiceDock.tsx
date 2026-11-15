import { Button } from "../ui/Button";
import { navigate, useRoute } from "../ui/route";
import { useVoice } from "./VoiceContext";

/** Floating voice control shown on every seller screen except the Voice page itself. */
export function VoiceDock() {
  const { agent } = useVoice();
  const [route] = useRoute();
  if (route.section === "voice") return null;

  const idle = agent.status === "idle" || agent.status === "error";
  if (idle) {
    return (
      <div className="vo-dock is-idle">
        <button className="vo-fab" onClick={() => void agent.start()} aria-label="Talk to ShopBridge">
          <span aria-hidden="true">🎙</span> Talk to ShopBridge
        </button>
      </div>
    );
  }

  const waiting = agent.timeline.filter((t) => t.status === "awaiting_approval" && t.approval);
  const lastAgent = [...agent.turns].reverse().find((t) => t.role === "agent");
  const last = agent.latencies.at(-1);
  return (
    <div className="vo-dock" role="region" aria-label="Voice agent">
      <div className="vo-dock-head">
        <strong>{agent.status === "connecting" ? "Connecting…" : agent.micOn ? "Listening" : "Mic muted"}</strong>
        {last !== undefined ? <span className="vo-hint">{last} ms</span> : null}
      </div>
      {lastAgent ? <p className="vo-dock-line">{lastAgent.text.slice(0, 160)}</p> : null}
      {waiting.map((item) => (
        <div key={item.key} className="vo-dock-approval">
          <p className="vo-readback">“{item.approval!.readback}”</p>
          <div className="vo-actions">
            <Button onClick={() => agent.approve(item.approval!.id)}>Approve</Button>
            <Button variant="secondary" onClick={() => agent.reject(item.approval!.id)}>Cancel</Button>
          </div>
        </div>
      ))}
      <div className="vo-actions">
        <Button variant="secondary" onClick={() => void agent.toggleMic()}>{agent.micOn ? "Mute" : "Unmute"}</Button>
        <Button variant="quiet" onClick={() => navigate("voice")}>Open</Button>
        <Button variant="danger" onClick={agent.stop}>End</Button>
      </div>
    </div>
  );
}
