import type { ReactNode } from "react";
import type { Role } from "../../../shared/types";
import { VoiceAgentProvider } from "./VoiceContext";
import { VoiceDock } from "./VoiceDock";

/** Sellers get the persistent voice agent on every screen; everyone else is unaffected. */
export function VoiceGate({ role, children }: { role: Role; children: ReactNode }) {
  if (role !== "volunteer") return <>{children}</>;
  return (
    <VoiceAgentProvider>
      {children}
      <VoiceDock />
    </VoiceAgentProvider>
  );
}
