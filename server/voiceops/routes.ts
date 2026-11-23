import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors";
import type { UserRecord } from "../store-types";
import { demoEnabled, resetDemoScenario } from "./demo";
import { DIGEST_AUDIENCES, DIGEST_LANGUAGES, dailyDigest, type DigestAudience, type DigestLanguage } from "./digest";
import * as orchestrator from "./orchestrator";
import { runPreflight } from "./preflight";
import { listTeamRuns, startTeamRun } from "../agents/team";

export type RouteDeps = {
  currentUser: (req: IncomingMessage) => Promise<UserRecord>;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  notifier: orchestrator.Notifier;
  openRoom?: (orderId: string) => Promise<unknown>;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Raw tool calls over HTTP are for tests and the typed fallback; the live agent uses the WebSocket. */
const debugToolsEnabled = () => process.env.NODE_ENV !== "production" || process.env.VOICEOPS_DEBUG_TOOLS === "1";

/** Returns true if the request was a VoiceOps route (and has been answered). */
export async function handleVoiceOpsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouteDeps): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/voiceops/")) return false;
  const user = await deps.currentUser(req);
  const method = req.method ?? "GET";
  const ctxFor = async (sessionId: unknown): Promise<orchestrator.Ctx> => ({
    user,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : await orchestrator.startSession(user, "dashboard"),
    notifier: deps.notifier,
  });

  if (method === "GET" && pathname === "/api/voiceops/preflight") {
    deps.sendJson(res, 200, await runPreflight());
    return true;
  }
  if (method === "POST" && pathname === "/api/voiceops/digest") {
    const body = object(await deps.readJson(req));
    const language = String(body.language ?? "en") as DigestLanguage;
    const audience = String(body.audience ?? "owner") as DigestAudience;
    if (!(language in DIGEST_LANGUAGES) || !(audience in DIGEST_AUDIENCES)) throw new HttpError(422, "VALIDATION_ERROR", "Choose a supported language and audience.");
    const { text, model } = await dailyDigest(user, language, audience);
    deps.sendJson(res, 200, { text, model });
    return true;
  }
  if (method === "POST" && pathname === "/api/voiceops/demo/reset") {
    deps.sendJson(res, 200, await resetDemoScenario(user, deps.openRoom));
    return true;
  }
  if (method === "GET" && pathname === "/api/voiceops/overview") {
    deps.sendJson(res, 200, { ...(await orchestrator.overview(user)), demoEnabled: demoEnabled() && user.sample });
    return true;
  }
  if (method === "GET" && pathname === "/api/voiceops/baselines") {
    deps.sendJson(res, 200, { baselines: await orchestrator.listBaselines(user) });
    return true;
  }
  if (method === "POST" && pathname === "/api/voiceops/baselines") {
    deps.sendJson(res, 201, await orchestrator.recordBaseline(user, object(await deps.readJson(req))));
    return true;
  }
  const baselineDelete = pathname.match(/^\/api\/voiceops\/baselines\/([a-z0-9_]+)$/);
  if (method === "DELETE" && baselineDelete) {
    deps.sendJson(res, 200, await orchestrator.deleteBaseline(user, baselineDelete[1]));
    return true;
  }
  // Multi-agent team: start a run (returns at once) and follow its steps.
  if (method === "POST" && pathname === "/api/voiceops/agents/run") {
    deps.sendJson(res, 202, await startTeamRun(user, "dashboard", deps.notifier));
    return true;
  }
  if (method === "GET" && pathname === "/api/voiceops/agents/runs") {
    deps.sendJson(res, 200, { runs: await listTeamRuns(user) });
    return true;
  }
  if (method === "GET" && pathname === "/api/voiceops/activity") {
    deps.sendJson(res, 200, { actions: await orchestrator.listActivity(user) });
    return true;
  }
  if (method === "GET" && pathname === "/api/voiceops/approvals") {
    deps.sendJson(res, 200, { approvals: await orchestrator.listApprovals(user, url.searchParams.get("state")) });
    return true;
  }
  if (method === "POST" && pathname === "/api/voiceops/sessions") {
    const body = object(await deps.readJson(req));
    const hint = typeof body.language === "string" ? body.language.slice(0, 20) : null;
    deps.sendJson(res, 201, { sessionId: await orchestrator.startSession(user, hint) });
    return true;
  }

  const decision = pathname.match(/^\/api\/voiceops\/approvals\/([a-z0-9]+)\/(approve|reject)$/);
  if (method === "POST" && decision) {
    const body = object(await deps.readJson(req));
    const result = await orchestrator.decideApproval(await ctxFor(body.sessionId), decision[1], decision[2] as "approve" | "reject", "tap");
    deps.sendJson(res, 200, result);
    return true;
  }
  const undo = pathname.match(/^\/api\/voiceops\/actions\/([a-z0-9]+)\/undo$/);
  if (method === "POST" && undo) {
    const body = object(await deps.readJson(req));
    const result = await orchestrator.undoAction(await ctxFor(body.sessionId), undo[1]);
    deps.sendJson(res, 200, result);
    return true;
  }
  const tool = pathname.match(/^\/api\/voiceops\/tools\/([a-z_]+)$/);
  if (method === "POST" && tool) {
    if (!debugToolsEnabled()) throw new HttpError(404, "NOT_FOUND", "Not found.");
    const body = object(await deps.readJson(req));
    const result = await orchestrator.runTool(await ctxFor(body.sessionId), tool[1], body.args);
    deps.sendJson(res, 200, result);
    return true;
  }
  throw new HttpError(404, "NOT_FOUND", "Not found.");
}
