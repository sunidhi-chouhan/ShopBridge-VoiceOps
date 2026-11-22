import { useCallback, useEffect, useRef, useState } from "react";
import { LiveClient, type LiveEvent, type ToolResultPayload } from "./liveClient";

export type Turn = { id: number; role: "user" | "agent"; text: string; final: boolean; interrupted?: boolean };

export type TimelineItem = {
  key: number;
  name: string;
  args: Record<string, unknown>;
  status: "running" | ToolResultPayload["status"] | "approved" | "rejected" | "undone";
  message?: string;
  latencyMs?: number;
  actionId?: string;
  approval?: { id: string; readback: string; expiresAt: string };
  humanInvolved?: boolean;
  at: number;
};

export type AgentStatus = "idle" | "connecting" | "live" | "error";

const INTERNAL = new Set(["confirm_action", "reject_action"]);

export function useVoiceAgent(onDataChanged: () => void) {
  const client = useRef<LiveClient | null>(null);
  const seq = useRef(0);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const changed = useRef(onDataChanged);
  changed.current = onDataChanged;

  const handle = useCallback((event: LiveEvent) => {
    switch (event.type) {
      case "ready":
        setStatus("live");
        setModel(event.model);
        // Opened from a dashboard action: run that request. Otherwise brief the seller proactively.
        if (firstCommand.current) {
          client.current?.sendText(firstCommand.current);
          firstCommand.current = null;
        } else {
          client.current?.requestBriefing();
        }
        break;
      case "transcript":
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === event.role && !last.final) {
            return [...prev.slice(0, -1), { ...last, text: event.text, final: event.final }];
          }
          const closed = prev.map((t, i) => (i === prev.length - 1 && !t.final ? { ...t, final: true } : t));
          return [...closed, { id: ++seq.current, role: event.role, text: event.text, final: event.final }];
        });
        break;
      case "interrupted":
        setTurns((prev) => {
          const i = [...prev].reverse().findIndex((t) => t.role === "agent");
          if (i === -1) return prev;
          const at = prev.length - 1 - i;
          return prev.map((t, idx) => (idx === at ? { ...t, final: true, interrupted: true } : t));
        });
        break;
      case "turn_complete":
        setTurns((prev) => prev.map((t) => (t.final ? t : { ...t, final: true })));
        break;
      case "tool_started":
        if (INTERNAL.has(event.name)) break;
        setTimeline((prev) => [...prev, { key: ++seq.current, name: event.name, args: event.args, status: "running", at: Date.now() }]);
        break;
      case "tool_result":
        if (INTERNAL.has(event.name)) break;
        setTimeline((prev) => {
          const i = [...prev].reverse().findIndex((t) => t.name === event.name && t.status === "running");
          if (i === -1) return prev;
          const at = prev.length - 1 - i;
          return prev.map((t, idx) =>
            idx === at
              ? { ...t, status: event.result.status, message: event.result.message, latencyMs: event.result.latencyMs, actionId: event.result.actionId, approval: event.result.approval }
              : t,
          );
        });
        if (event.result.status === "succeeded") changed.current();
        break;
      case "approval_resolved": {
        const r = event.result;
        setTimeline((prev) =>
          prev.map((t) => {
            if (t.actionId !== r.actionId) return t;
            const status = event.name === "reject" || r.code === "REJECTED_BY_HUMAN" ? "rejected" : event.name === "undo_action" ? "undone" : r.status === "succeeded" ? "succeeded" : r.status;
            return { ...t, status, message: r.message, humanInvolved: true };
          }),
        );
        changed.current();
        break;
      }
      case "latency":
        setLatencies((prev) => [...prev.slice(-19), event.ms]);
        break;
      case "error":
        setError(event.message);
        break;
      case "closed":
        setStatus((s) => (s === "error" ? s : "idle"));
        setMicOn(false);
        break;
    }
  }, []);

  const firstCommand = useRef<string | null>(null);
  const start = useCallback(async (command?: string) => {
    firstCommand.current = command ?? null;
    setError(null);
    setStatus("connecting");
    const live = new LiveClient(handle);
    client.current = live;
    try {
      await live.connect();
      await live.startMic();
      setMicOn(true);
    } catch (caught: unknown) {
      const denied = caught instanceof DOMException && caught.name === "NotAllowedError";
      setError(denied ? "Microphone access was blocked. Allow it in the browser, or type to the agent instead." : caught instanceof Error ? caught.message : "Could not start voice.");
      // Typing still works when only the mic failed.
      if (!live.open) {
        live.close();
        client.current = null;
        setStatus("error");
      }
    }
  }, [handle]);

  const stop = useCallback(() => {
    client.current?.close();
    client.current = null;
    setStatus("idle");
    setMicOn(false);
  }, []);

  const toggleMic = useCallback(async () => {
    const live = client.current;
    if (!live) return;
    if (live.micActive) {
      live.stopMic();
      setMicOn(false);
    } else {
      try {
        await live.startMic();
        setMicOn(true);
        setError(null);
      } catch {
        setError("Microphone access was blocked.");
      }
    }
  }, []);

  useEffect(() => () => client.current?.close(), []);

  return {
    status, error, micOn, turns, timeline, latencies, model, client,
    start, stop, toggleMic,
    sendText: (text: string) => client.current?.sendText(text),
    /** Send a request to the agent, opening a session first if none is running. */
    ask: (text: string) => (client.current?.open ? client.current.sendText(text) : void start(text)),
    approve: (id: string) => client.current?.approve(id),
    reject: (id: string) => client.current?.reject(id),
    undo: (actionId?: string) => client.current?.undo(actionId),
  };
}
