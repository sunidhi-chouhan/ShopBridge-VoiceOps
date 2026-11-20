import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useVoiceAgent } from "./useVoiceAgent";

/** A running timed manual run: the seller does a task by hand while taps and keys are counted. */
export type Stopwatch = { task: string; startedAt: number; taps: number; keys: number };

type VoiceValue = {
  agent: ReturnType<typeof useVoiceAgent>;
  /** Bumps when agent actions change data, so dashboards refetch. */
  tick: number;
  refresh: () => void;
  stopwatch: Stopwatch | null;
  startStopwatch: (task: string) => void;
  /** Ends the run and returns the final reading (or null if none was running). */
  stopStopwatch: () => (Stopwatch & { seconds: number }) | null;
};

const Ctx = createContext<VoiceValue | null>(null);

/** Events inside the stopwatch bar itself (Done, Discard) are not part of the task. */
const insideStopwatch = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("[data-stopwatch]"));
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** Holds the live voice session above the router so it survives navigation between screens. */
export function VoiceAgentProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const agent = useVoiceAgent(refresh);
  const [stopwatch, setStopwatch] = useState<Stopwatch | null>(null);
  const live = useRef<Stopwatch | null>(null);
  live.current = stopwatch;

  const running = stopwatch !== null;
  useEffect(() => {
    if (!running) return;
    const onTap = (e: PointerEvent) => {
      if (!e.isPrimary || insideStopwatch(e.target)) return;
      setStopwatch((s) => (s ? { ...s, taps: s.taps + 1 } : s));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || MODIFIERS.has(e.key) || insideStopwatch(e.target)) return;
      setStopwatch((s) => (s ? { ...s, keys: s.keys + 1 } : s));
    };
    document.addEventListener("pointerdown", onTap, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onTap, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [running]);

  const startStopwatch = useCallback((task: string) => setStopwatch({ task, startedAt: Date.now(), taps: 0, keys: 0 }), []);
  const stopStopwatch = useCallback(() => {
    const s = live.current;
    setStopwatch(null);
    return s ? { ...s, seconds: (Date.now() - s.startedAt) / 1000 } : null;
  }, []);

  return <Ctx.Provider value={{ agent, tick, refresh, stopwatch, startStopwatch, stopStopwatch }}>{children}</Ctx.Provider>;
}

export function useVoice(): VoiceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useVoice must be used inside VoiceAgentProvider");
  return value;
}
