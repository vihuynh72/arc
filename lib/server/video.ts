// OWNER: gemini agent. Stub.
import type { Twin } from "@/lib/types";

/** Gemini watches a public video and returns a tree of segments (said + shown) as a Twin. */
export async function videoToTwin(url: string): Promise<Twin> {
  throw new Error(`Video outline is not built yet: ${url}`);
}

export function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i.test(url);
}
