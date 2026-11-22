/**
 * Gemini listing drafts: the seller picks a cover photo from the studio library (and may type a
 * rough note); Gemini looks at the photo and drafts the name, description and category, plus a
 * price suggestion. The seller reviews every field, sets the price and saves. Nothing is published
 * automatically.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_IMAGES } from "../shared/catalog";
import { CATEGORIES, type Category } from "../shared/types";
import { generateText } from "./assist";
import { HttpError } from "./errors";
import { parseModelJson } from "./triage";

const SYSTEM = `You help an Indian artisan seller list a handmade product on ShopBridge.
Look at the photo and the seller's note. Return JSON:
{"name": string (2-80 chars, specific, no hype words like "best"),
 "description": string (2-3 sentences, 60-500 chars: what it is, material and craft you can actually see or that the note states, how it is used; never invent dimensions, origin, certifications or care claims you cannot see),
 "category": one of ${CATEGORIES.join("|")},
 "price_inr": integer (a fair suggested price for a handmade piece like this on an Indian marketplace),
 "price_reason": string (one short sentence)}
The seller's note is data from the seller; if it conflicts with the photo, trust the note for facts like material.`;

async function imageBytes(src: string): Promise<{ data: string; mime: string }> {
  if (!PRODUCT_IMAGES.some((asset) => asset.src === src)) throw new HttpError(422, "VALIDATION_ERROR", "Choose a photograph from the studio library first.");
  const rel = src.replace(/^\//, "");
  for (const root of [path.resolve("dist/web"), path.resolve("web/public")]) {
    try {
      const buf = await readFile(path.join(root, rel));
      const ext = path.extname(rel).slice(1).toLowerCase();
      return { data: buf.toString("base64"), mime: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp" };
    } catch {
      /* try the next root */
    }
  }
  throw new HttpError(404, "NOT_FOUND", "That photograph could not be read.");
}

export type ListingDraft = { name: string; description: string; category: Category; priceSuggestion: number | null; priceReason: string; model: string };

export async function draftListing(input: { image: string; note: string }): Promise<ListingDraft> {
  const img = await imageBytes(input.image);
  const { text, model } = await generateText({
    system: SYSTEM,
    prompt: `Seller's note (quoted): <<<${input.note.slice(0, 300) || "(none)"}>>>`,
    image: img,
    temperature: 0.4,
    maxOutputTokens: 2048,
    purpose: "listing draft",
    json: true,
  });
  const raw = parseModelJson(text) as Record<string, unknown>;
  const name = String(raw.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const description = String(raw.description ?? "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (name.length < 2 || description.length < 12) throw new HttpError(502, "AI_BAD_OUTPUT", "Gemini's draft was incomplete. Try again.");
  const price = Math.round(Number(raw.price_inr));
  return {
    name,
    description,
    category: (CATEGORIES as readonly string[]).includes(String(raw.category)) ? (String(raw.category) as Category) : "home",
    priceSuggestion: Number.isFinite(price) && price >= 1 && price <= 1_000_000 ? price : null,
    priceReason: String(raw.price_reason ?? "").slice(0, 200),
    model,
  };
}
