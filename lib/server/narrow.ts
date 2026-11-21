// One step of narrowing a broad search ("I want to study biology"): the light model either says the request is specific enough
// and gives the query, or writes one short question with two to four short options. Called by app/api/narrow/route.ts; the limits
// (how many questions, no repeats, option length) are enforced in code by lib/client/narrow.ts, never trusted to the model.
import { GEMINI_VISION_MODEL } from "../models";
import { generateJson } from "./gemini";

export type Step = { specific: boolean; query: string; said: string; question: string; options: string[]; kind: "part" | "level" | "material" | "other" };
export type Asked = { q: string; a: string; kind?: string };

const SCHEMA = {
  type: "OBJECT",
  properties: {
    specific: { type: "BOOLEAN" },
    query: { type: "STRING" },
    said: { type: "STRING" },
    question: { type: "STRING" },
    options: { type: "ARRAY", items: { type: "STRING" } },
    kind: { type: "STRING", enum: ["part", "level", "material", "other"] },
  },
  required: ["specific", "query", "said", "question", "options", "kind"],
};

const RULES = `A blind student asked a study search tool for material. Decide if the request, with the answers so far, is specific enough to search well.
Ask only what changes the results most, in this order: which part of the subject (kind "part"); the level: school, first-year college or advanced (kind "level"); the kind of material: a textbook chapter, a lecture video, or a paper (kind "material"). Nothing else unless it clearly matters.
Usually one or two questions are enough. Once a part of the subject is known, it is specific enough unless the level is unknown and would change the results a lot.
If the student answered vaguely or said they do not mind, do not press: be specific with what there is.
When specific: "specific" true, "query" the search words (2 to 8 words, the topic first and with its subject ("organic chemistry", not "organic"), then the level and material only if the student gave them: never add one they did not give), "said" the same as a short spoken phrase with commas, for example "cell division, first-year college, textbook chapters" when all three were given. Leave question empty and options empty.
When not: "specific" false, "question" a short question with no options in it and no question mark, for example "Which part of biology", and "options" two to four answers of one to three plain words each, for example "cells", "genetics", "evolution", "ecology". Never ask something already asked.`;

// The same request and answers give the same step: a repeated test or a second student costs nothing. shortcut: unbounded until restart, fine at demo scale.
const memo = new Map<string, Step>();

export async function narrowStep(request: string, asked: Asked[], level?: string): Promise<Step> {
  const key = JSON.stringify([request.toLowerCase(), asked, level ?? ""]);
  const hit = memo.get(key);
  if (hit) return hit;
  const text = [
    RULES,
    `Request: ${request}`,
    level ? `The student's level is known: ${level}. Do not ask the level; put it in the query.` : "",
    ...asked.map((x, i) => `Question ${i + 1}: ${x.q}\nAnswer ${i + 1}: ${x.a}`),
  ].filter(Boolean).join("\n");
  const step = await generateJson<Step>([{ text }], SCHEMA, { model: GEMINI_VISION_MODEL, timeoutMs: 4000, feature: "narrow" });
  memo.set(key, step);
  return step;
}
