// OWNER: gemini agent. Stub: returns the hand-fixed fixture tour for every figure.
import { readFile } from "node:fs/promises";
import type { Tour } from "@/lib/types";

/** Prepared figure: hand-fixed fixture. Unseen figure: Gemini vision, cached by image hash. null if no tour. */
export async function getTour(imageUrl: string): Promise<Tour | null> {
  void imageUrl;
  const tour: Tour = JSON.parse(await readFile("fixtures/lower/tour-final.json", "utf8"));
  return { ...tour, image: "/fixtures/lower/figure-1280.jpg" };
}
