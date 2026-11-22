import type { RequestStatus } from "../../shared/types";

export const copy = {
  name: "ShopBridge",
  tagline: "Voice AI that runs your shop · powered by Gemini",
  place: "Gemini Live voice agent · for Indian sellers",
  signInTitle: "Sign in",
  nameLabel: "Your name",
  emailLabel: "Email",
  passwordLabel: "Password",
  continue: "Sign in",
  createAccount: "Create account",
  haveAccount: "Sign in instead",
  buyerOnly: "New accounts are buyers. Seller and support desks are approved separately.",
  demoKicker: "Explore demo",
  demoLead: "Open the Seller desk to talk to the voice AI. Buyer and support desks show the other side of each order.",
  demoBuyer: "Buyer",
  demoSeller: "Seller",
  demoSupport: "Support agent",
  signOut: "Sign out",
  orderSupportToast: "Support requested. An agent will join this order conversation.",
  keysMissing: "Saved. Chat needs its service keys on the server.",
  noCases: "No support cases yet.",
  retry: "Try again",
};

/** Support case status, in marketplace terms. */
export function statusLabel(status: RequestStatus): string {
  if (status === "requested") return "Waiting for agent";
  if (status === "assigned") return "With support";
  if (status === "in_progress") return "Resolution proposed";
  return "Resolved";
}
