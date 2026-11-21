// YouTube's own timed captions, fetched and cut into segments in code (no model). Caller: lib/server/video.ts.
// shortcut: the player endpoint is YouTube's unofficial Android client API; if it starts refusing, video.ts falls back to Gemini.
import { cleanTitle } from "../parse/title";

export type Cue = { start: number; end: number; text: string }; // seconds
export type Track = { baseUrl: string; languageCode: string; kind?: string };
export type Player = { ok: boolean; status: string; title: string; author: string; seconds: number; tracks: Track[] };

const CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 };

/** Title, length and caption tracks. `ok` is false when YouTube refuses (non-200 or playability not OK). */
export async function player(id: string): Promise<Player> {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
    body: JSON.stringify({ context: { client: CLIENT }, videoId: id }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return { ok: false, status: `HTTP ${res.status}`, title: "", author: "", seconds: 0, tracks: [] };
  const j = await res.json();
  const status: string = j?.playabilityStatus?.status ?? "missing";
  const d = j?.videoDetails ?? {};
  return {
    ok: status === "OK",
    status,
    title: cleanTitle(d.title ?? ""),
    author: d.author ?? "",
    seconds: Number(d.lengthSeconds) || 0,
    tracks: j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
  };
}

/** Human English, then automatic English, then any English variant, then the first track. */
export const pickTrack = (tracks: Track[]): Track | null =>
  tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
  tracks.find((t) => t.languageCode === "en") ??
  tracks.find((t) => /^en/.test(t.languageCode)) ??
  tracks[0] ??
  null;

export async function fetchCues(track: Track): Promise<Cue[]> {
  const res = await fetch(track.baseUrl, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`captions HTTP ${res.status}`);
  return cleanCues(parseTimedText(await res.text()));
}

const decode = (t: string) => {
  for (let k = 0; k < 2; k++) // twice: some tracks are double-encoded ("&amp;#39;")
    t = t
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return t;
};

/** timedtext format 3. A <p> with <s> words (automatic tracks) becomes one cue per word, so breaks can fall between words. */
export function parseTimedText(xml: string): Cue[] {
  const cues: Cue[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = Number(/\bt="(\d+)"/.exec(m[1])?.[1]) / 1000;
    const d = Number(/\bd="(\d+)"/.exec(m[1])?.[1] ?? 0) / 1000;
    if (!Number.isFinite(t)) continue;
    const words = [...m[2].matchAll(/<s\b([^>]*)>([\s\S]*?)<\/s>/g)];
    if (words.length) {
      words.forEach((w, i) => {
        const at = t + Number(/\bt="(\d+)"/.exec(w[1])?.[1] ?? 0) / 1000;
        const next = words[i + 1] ? t + Number(/\bt="(\d+)"/.exec(words[i + 1][1])?.[1] ?? 0) / 1000 : t + d;
        cues.push({ start: at, end: Math.max(at, next), text: w[2] });
      });
    } else cues.push({ start: t, end: t + d, text: m[2].replace(/<[^>]+>/g, "") });
  }
  return cues;
}

const NOISE = /\[(?:music|applause|laughter|laughs|inaudible|silence|noise|sound|foreign)[^\]]*\]|\((?:music|applause|laughter)\)|[♪♫]+/gi;

/** Decode, drop sound tags and empty cues, drop a cue that repeats the one before, and end each cue where the next starts. */
export function cleanCues(raw: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of [...raw].sort((a, b) => a.start - b.start)) {
    const text = decode(c.text).replace(NOISE, " ").replace(/\s+/g, " ").trim();
    if (!text || /^[-–—.,]+$/.test(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === text.toLowerCase()) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    if (prev && prev.end > c.start) prev.end = c.start; // automatic tracks overlap: a line stays up while the next one rolls in
    out.push({ start: c.start, end: Math.max(c.start, c.end), text });
  }
  return out;
}

const MIN = 25;
const MAX = 45;
const SENTENCE_END = /[.?!]["')\]]*$/;

/** Segments of about 25 to 45 s. Inside that window: the first cue that ends a sentence, else the longest pause (latest on a tie).
 * Segments are contiguous: the first starts at 0, each starts where the one before ends, the last ends at `total`. */
export function segmentCues(cues: Cue[], total: number): Cue[] {
  const segs: Cue[] = [];
  let i = 0;
  while (i < cues.length) {
    const from = segs.length ? segs[segs.length - 1].end : 0;
    let cut = -1;
    let bestGap = -1;
    for (let j = i; j < cues.length; j++) {
      const len = cues[j].end - from;
      if (len > MAX && j > i) break;
      if (len < MIN) continue;
      if (SENTENCE_END.test(cues[j].text)) {
        cut = j;
        bestGap = Infinity;
        break;
      }
      // Start to next start: automatic word cues end where the next word begins, so a pause shows up only as a long interval.
      const gap = (cues[j + 1]?.start ?? Infinity) - cues[j].start;
      if (gap >= bestGap) [cut, bestGap] = [j, gap]; // ties go to the later cue, toward 45 s

    }
    // Not enough left to reach 25 s, or one long cue: take everything up to 45 s (at least one cue).
    if (cut < 0) {
      cut = i;
      while (cut + 1 < cues.length && cues[cut + 1].end - from <= MAX) cut++;
    }
    const end = cut + 1 < cues.length ? cues[cut + 1].start : Math.max(total, cues[cut].end);
    segs.push({ start: from, end, text: cues.slice(i, cut + 1).map((c) => c.text).join(" ") });
    i = cut + 1;
  }
  // A short tail (under 10 s) joins the segment before it.
  const last = segs[segs.length - 1];
  if (segs.length > 1 && last.end - last.start < 10) {
    segs.pop();
    const prev = segs[segs.length - 1];
    prev.end = last.end;
    prev.text += ` ${last.text}`;
  }
  return segs.map((s) => ({ ...s, start: Math.round(s.start), end: Math.round(s.end) }));
}

/** "0:45", "12:03", "1:02:03". */
export function clock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Wording that leans on sight: these segments are described first. */
export const POINTS_AT =
  /\b(as you can see|you can see|you see here|look at|take a look|this one|that one|these ones|over here|over there|right here|right there|this (?:graph|picture|diagram|image|chart|line|point|side|box|axis|curve|shape|arrow|table|slide|part|thing)|like this|like that|draw|drawing|drew|write|writing|wrote|shown|showing|highlight|circled?|underline|points? (?:to|at))\b/i;
