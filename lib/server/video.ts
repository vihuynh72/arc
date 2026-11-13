// Gemini watches a public YouTube video and returns chapters with short segments, as a Twin.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { GEMINI_VIDEO_MODELS } from "../models";
import type { Twin, TwinNode } from "../types";
import { generateJsonChain } from "./gemini";
import { youtubeCanonical, youtubeId, youtubeOembed } from "./oembed";

const MAX_SECONDS = 11 * 60; // "about 10 minutes"

export const PROMPT = `Watch this video and build an outline a blind student can move through with the keyboard.
Group it into chapters (2 to 6), and under each chapter give short segments (each 10 to 30 seconds, in time order, not overlapping). Cover the video from the first second to the last with no gaps: the first segment starts at 0, each segment starts where the one before ends, the last ends at the end of the video. About one segment per 20 seconds, at least 6 segments in all.
For each chapter: title and summary (ONE sentence).
For each segment:
- start and end: integer seconds from the start of the video.
- heading: a few words.
- said: one or two sentences of what the speaker says.
- shown: what is visible on screen that the speaker does not say. A blind student will hear this as fact, so an invented description is worse than none. Rules:
  * Describe only what is visible in the frames of this segment, never what a slide "probably" lists or what would usually be there.
  * When there is TEXT on screen (a slide, a title, labels on a chart, a formula, code), quote the important words exactly as written, in quotation marks, in the shortest useful form.
  * Name letters, numbers and labels ONLY if they are legible on screen.
  * For a chart or graph: say what kind it is, the axis labels as printed, and the trend. Give no values unless they are printed on it.
  * When the picture is only a person talking with nothing else, write exactly: The speaker, no slides.
  * When you are not sure what is on screen, write exactly: Unclear on screen. Do not describe it.
- shown_confidence: "high" if you read or clearly saw what you wrote in shown, "low" if you are unsure of any of it.
Also give total_seconds: the video's total length in seconds.`;

export const SCHEMA = {
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
                shown_confidence: { type: "STRING", enum: ["high", "low"] },
              },
              required: ["start", "end", "heading", "said", "shown", "shown_confidence"],
            },
          },
        },
        required: ["title", "summary", "segments"],
      },
    },
  },
  required: ["title", "total_seconds", "chapters"],
};

type Seg = { start: number; end: number; heading: string; said: string; shown: string; shown_confidence?: string };
type Raw = {
  title: string;
  total_seconds: number;
  chapters: { title: string; summary: string; segments: Seg[] }[];
};

export function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/** A message that is already one plain sentence a listener can act on. */
class VideoError extends Error {}

const E_OPEN = "I could not open that video. It may be private or removed.";
const E_RESTRICTED = "I could not read that video. Its owner may have restricted access to it.";
const E_MODEL = "I could not outline that video just now. Try again in a minute.";

/** Map any failure to one short sentence; the raw error never reaches the listener. */
export function plainVideoError(e: unknown): string {
  if (e instanceof VideoError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/embedd|restricted|age.restrict|sign in|copyright/i.test(m)) return E_RESTRICTED;
  if (/HTTP (400|403|404)|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|Unsupported MIME/i.test(m)) return E_OPEN;
  return E_MODEL;
}

const unescapeHtml = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** Length and title from the YouTube watch page; null if the page could not be fetched at all. */
async function watchPage(url: string): Promise<{ seconds: number | null; title: string | null } | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36", "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    const len = html.match(/"lengthSeconds":"(\d+)"/);
    const t = html.match(/<meta property="og:title" content="([^"]*)"/);
    return { seconds: len ? Number(len[1]) : null, title: t && unescapeHtml(t[1]) ? unescapeHtml(t[1]) : null };
  } catch {
    return null;
  }
}

const mmss = (n: number) => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}`;

/** Stretches the outline skips: before a first segment later than 20 s, between segments more than 45 s apart, after a last one ending over 30 s early. */
export function coverageGaps(segs: { start: number; end: number }[], total: number): { start: number; end: number }[] {
  if (!segs.length) return [];
  const gaps: { start: number; end: number }[] = [];
  if (segs[0].start > 20) gaps.push({ start: 0, end: segs[0].start });
  for (let i = 1; i < segs.length; i++) if (segs[i].start - segs[i - 1].end > 45) gaps.push({ start: segs[i - 1].end, end: segs[i].start });
  const last = segs[segs.length - 1];
  if (total - last.end > 30) gaps.push({ start: last.end, end: total });
  return gaps;
}

export const gapText = (g: { start: number; end: number }) => `No outline for ${mmss(g.start)} to ${mmss(g.end)}.`;

/** What the student hears for a segment's picture: doubt is spoken, not hidden. */
export function shownText(s: { shown: string; shown_confidence?: string }): string {
  const t = s.shown.trim();
  return s.shown_confidence === "low" && !/^unclear on screen/i.test(t) ? `Possibly: ${t}` : t;
}

export async function videoToTwin(url: string): Promise<Twin> {
  try {
    return await outline(url);
  } catch (e) {
    if (!(e instanceof VideoError)) console.log(`[video] ${url}: ${e instanceof Error ? e.message : e}`);
    throw new Error(plainVideoError(e));
  }
}

async function outline(url: string): Promise<Twin> {
  const id = youtubeId(url);
  if (!id) throw new VideoError("Only public YouTube links are supported for video.");
  const canonical = youtubeCanonical(id);
  const hash = createHash("sha1").update(canonical).digest("hex");
  // Canonical key first, then the key older copies were saved under (the raw link).
  for (const key of [hash, createHash("sha1").update(url).digest("hex")]) {
    try {
      const twin: Twin = JSON.parse(await readFile(`.cache/video/${key}.json`, "utf8"));
      if (key !== hash) await writeFile(`.cache/video/${hash}.json`, JSON.stringify(twin)).catch(() => {}); // later links to this video find it
      return { ...twin, source: { ...twin.source, url } };
    } catch {}
  }

  const t0 = Date.now();
  const page = await watchPage(canonical);
  if (page && page.seconds === null && !page.title) throw new VideoError(E_OPEN);
  const known = page?.seconds ?? null;
  const tooLong = (n: number, about = "") =>
    new VideoError(`This video is ${about}${Math.round(n / 60)} minutes long. Arc outlines videos of about 10 minutes or less.`);
  if (known && known > MAX_SECONDS) throw tooLong(known);
  const title = page?.title ?? (await youtubeOembed(canonical, AbortSignal.timeout(5_000)).catch(() => null))?.title ?? null;

  const { data: raw } = await generateJsonChain<Raw>([{ text: PROMPT }, { fileData: { fileUri: canonical } }], SCHEMA, GEMINI_VIDEO_MODELS, 100_000);
  const total = known ?? raw.total_seconds;
  if (total > MAX_SECONDS) throw tooLong(total, "about ");

  // Keep valid segments in time order, per chapter.
  let prevStart = -1;
  const chapters = raw.chapters
    .map((ch) => ({
      ch,
      good: ch.segments.filter((s) => {
        const ok = s.start >= 0 && s.end > s.start && s.end <= total + 2 && s.start >= prevStart;
        if (ok) prevStart = s.start;
        return ok;
      }),
    }))
    .filter((c) => c.good.length);
  const pending = coverageGaps(chapters.flatMap((c) => c.good), total);

  const nodes: TwinNode[] = [];
  let sections = 0;
  let segments = 0;
  const add = (n: Omit<TwinNode, "id" | "order">) =>
    nodes.push({ ...n, id: `n${String(nodes.length + 1).padStart(2, "0")}`, order: nodes.length });
  const note = (g: { start: number; end: number }) =>
    add({ kind: "segment", level: 3, heading: "Not outlined", text: gapText(g), start: Math.round(g.start), end: Math.round(g.end) });

  for (const { ch, good } of chapters) {
    add({ kind: "section", level: 2, heading: ch.title, text: ch.summary });
    sections++;
    for (const s of good) {
      while (pending.length && pending[0].end <= s.start) note(pending.shift()!);
      const shown = shownText(s);
      add({ kind: "segment", level: 3, heading: s.heading, text: `On screen: ${shown} Said: ${s.said}`, start: Math.round(s.start), end: Math.round(s.end), shown });
      segments++;
    }
  }
  if (!sections) throw new Error("Gemini returned no usable segments for this video.");
  pending.forEach(note);

  const twin: Twin = {
    id: `v-${hash.slice(0, 10)}`,
    source: { url, kind: "video", title: title ?? raw.title, via: "gemini", ms: Date.now() - t0 },
    nodes,
    counts: { sections, figures: 0, segments },
  };
  await mkdir(".cache/video", { recursive: true });
  await writeFile(`.cache/video/${hash}.json`, JSON.stringify(twin));
  return twin;
}
