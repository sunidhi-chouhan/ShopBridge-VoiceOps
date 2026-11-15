import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useVoiceAgent } from "./useVoiceAgent";

type VoiceValue = {
  agent: ReturnType<typeof useVoiceAgent>;
  /** Bumps when agent actions change data, so dashboards refetch. */
  tick: number;
  refresh: () => void;
};

const Ctx = createContext<VoiceValue | null>(null);

/** Holds the live voice session above the router so it survives navigation between screens. */
export function VoiceAgentProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const agent = useVoiceAgent(refresh);
  return <Ctx.Provider value={{ agent, tick, refresh }}>{children}</Ctx.Provider>;
}

export function useVoice(): VoiceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useVoice must be used inside VoiceAgentProvider");
  return value;
}
