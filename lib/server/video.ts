// Gemini watches a public YouTube video and returns chapters with short segments, as a Twin.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Twin, TwinNode } from "../types";
import { generateJson } from "./gemini";

const MAX_SECONDS = 11 * 60; // "about 10 minutes"

const PROMPT = `Watch this video and build an outline a blind student can move through with the keyboard.
Group it into chapters (2 to 6), and under each chapter give short segments (each 10 to 30 seconds, in time order, not overlapping). Cover the whole video from start to finish: about one segment per 20 seconds, at least 6 segments in all.
For each chapter: title and summary (ONE sentence).
For each segment:
- start and end: integer seconds from the start of the video.
- heading: a few words.
- said: one or two sentences of what the speaker says.
- shown: what is visible on screen that the speaker does not say: the diagram, the text on the slide, what "as you can see here" points at. Describe only what you see. If nothing but the speaker is visible, say so in a few words.
Also give total_seconds: the video's total length in seconds.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    total_seconds: { type: "NUMBER" },
    chapters: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          summary: { type: "STRING" },
          segments: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                start: { type: "NUMBER" },
                end: { type: "NUMBER" },
                heading: { type: "STRING" },
                said: { type: "STRING" },
                shown: { type: "STRING" },
              },
              required: ["start", "end", "heading", "said", "shown"],
            },
          },
        },
        required: ["title", "summary", "segments"],
      },
    },
  },
  required: ["title", "total_seconds", "chapters"],
};

type Raw = {
  title: string;
  total_seconds: number;
  chapters: { title: string; summary: string; segments: { start: number; end: number; heading: string; said: string; shown: string }[] }[];
};

export function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/** Length from the YouTube watch page; null if it cannot be read (then the model's own figure is used). */
async function youtubeSeconds(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(10_000),
    });
    const m = (await res.text()).match(/"lengthSeconds":"(\d+)"/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function videoToTwin(url: string): Promise<Twin> {
  const hash = createHash("sha1").update(url).digest("hex");
  const cacheFile = `.cache/video/${hash}.json`;
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {}

  const t0 = Date.now();
  if (!/youtube\.com|youtu\.be/i.test(url)) throw new Error("Only public YouTube links are supported for video.");
  const known = await youtubeSeconds(url);
  if (known && known > MAX_SECONDS) {
    throw new Error(`This video is ${Math.round(known / 60)} minutes long. Arc outlines videos of about 10 minutes or less.`);
  }

  const raw = await generateJson<Raw>([{ text: PROMPT }, { fileData: { fileUri: url } }], SCHEMA, { timeoutMs: 150_000 });
  const total = known ?? raw.total_seconds;
  if (total > MAX_SECONDS) {
    throw new Error(`This video is about ${Math.round(total / 60)} minutes long. Arc outlines videos of about 10 minutes or less.`);
  }

  const nodes: TwinNode[] = [];
  let sections = 0;
  let segments = 0;
  let prevStart = -1;
  const add = (n: Omit<TwinNode, "id" | "order">) =>
    nodes.push({ ...n, id: `n${String(nodes.length + 1).padStart(2, "0")}`, order: nodes.length });

  for (const ch of raw.chapters) {
    const good = ch.segments.filter((s) => {
      const ok = s.start >= 0 && s.end > s.start && s.end <= total + 2 && s.start >= prevStart;
      if (ok) prevStart = s.start;
      return ok;
    });
    if (!good.length) continue;
    add({ kind: "section", level: 2, heading: ch.title, text: ch.summary });
    sections++;
    for (const s of good) {
      add({
        kind: "segment",
        level: 3,
        heading: s.heading,
        text: `On screen: ${s.shown} Said: ${s.said}`,
        start: Math.round(s.start),
        end: Math.round(s.end),
        shown: s.shown,
      });
      segments++;
    }
  }
  if (!segments) throw new Error("Gemini returned no usable segments for this video.");

  const twin: Twin = {
    id: `v-${hash.slice(0, 10)}`,
    source: { url, kind: "video", title: raw.title, via: "gemini", ms: Date.now() - t0 },
    nodes,
    counts: { sections, figures: 0, segments },
  };
  await mkdir(".cache/video", { recursive: true });
  await writeFile(cacheFile, JSON.stringify(twin));
  return twin;
}
