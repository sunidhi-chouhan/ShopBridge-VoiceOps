/**
 * Bonus: turn the day's agent activity into a short summary for a chosen audience and language
 * (owner note, team handover, or a customer-facing update). Facts come from the database only; the
 * model is told not to add numbers, dates or promises.
 */
import { fetchWithTimeout } from "../assist";
import { getPool } from "../db/pool";
import { HttpError } from "../errors";
import type { UserRecord } from "../store-types";
import * as orchestrator from "./orchestrator";

export const DIGEST_LANGUAGES = { en: "English", hi: "Hindi (Devanagari)", ta: "Tamil", hinglish: "Hinglish (Hindi written in Latin letters, mixed with English)" } as const;
export const DIGEST_AUDIENCES = {
  owner: "the shop owner, a quick personal recap for WhatsApp",
  team: "the packing and dispatch team, a handover note listing what to do next",
  customer: "customers waiting on delayed orders, a polite general delay notice (no order numbers or personal details)",
} as const;
export type DigestLanguage = keyof typeof DIGEST_LANGUAGES;
export type DigestAudience = keyof typeof DIGEST_AUDIENCES;

export async function dailyDigest(user: UserRecord, language: DigestLanguage, audience: DigestAudience): Promise<{ text: string; model: string; facts: unknown }> {
  if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GEMINI_API_KEY_BACKUP?.trim()) throw new HttpError(503, "AI_NOT_CONFIGURED", "AI is not configured on this server.");
  const { summary, activity } = await orchestrator.overview(user);
  const actions = (
    await getPool().query(
      `SELECT tool, status, args, result->>'message' AS message FROM voiceops_actions
        WHERE user_id = $1 AND created_at >= date_trunc('day', now()) AND tool NOT IN ('confirm_action','reject_action','list_orders','get_order','list_low_stock','business_summary')
        ORDER BY created_at DESC LIMIT 30`,
      [user.id],
    )
  ).rows;
  const facts = { shop_today: summary, agent_activity: activity, changes_made_today: actions };
  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: "You write short business summaries for a small Indian online seller. Use ONLY the FACTS provided. Never invent numbers, dates, names, promises or tracking details. At most 90 words, plain text, no markdown." }],
    },
    contents: [{ role: "user", parts: [{ text: `FACTS (JSON):\n${JSON.stringify(facts)}\n\nWrite this for ${DIGEST_AUDIENCES[audience]}. Language: ${DIGEST_LANGUAGES[language]}.` }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
  });
  // The auto-picked "newest Flash" model was unreliable on this key, so use an explicit, ordered list.
  const models = [...new Set([process.env.GEMINI_TEXT_MODEL?.trim(), "gemini-2.5-flash", "gemini-flash-latest"].filter((m): m is string => Boolean(m)))];
  const keys = [process.env.GEMINI_API_KEY?.trim(), process.env.GEMINI_API_KEY_BACKUP?.trim()].filter((k): k is string => Boolean(k));
  for (const apiKey of keys) {
    for (const model of models) {
      try {
        const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body,
        });
        if (!response.ok) continue;
        const json = (await response.json().catch(() => null)) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
        const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
        if (text) return { text, model, facts };
      } catch {
        /* timeout or network error: try the next model or key */
      }
    }
  }
  throw new HttpError(502, "AI_UNAVAILABLE", "The AI service could not write the digest right now.");
}
