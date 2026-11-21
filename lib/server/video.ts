// A YouTube (or Khan Academy) video as a Twin. Default, official route: Gemini reads the video itself (fileData with
// videoMetadata windows, lib/server/videoQueue.ts); the twin is served with the first window and the rest arrives through
// /api/video/shown. Title from YouTube oEmbed. Opt-in fast path (ARC_CAPTIONS=unofficial): YouTube's own captions, cut into
// segments in code (lib/server/captions.ts); with no captions or a refusal it falls back to the Gemini route.
import { withLang } from "../parse/lang";
import { refusalLine } from "./budget";
import type { Twin, TwinNode } from "../types";
import { clock, fetchCues, pickTrack, player, segmentCues } from "./captions";
import { isKhanVideo, khanVideo } from "./khan";
import { youtubeCanonical, youtubeId, youtubeOembed } from "./oembed";
import { firstWindow, job, status } from "./videoQueue";

type VideoTwin = Twin & { video: NonNullable<Twin["video"]> };
const FIRST_WAIT_MS = 3_500; // the first window takes about 2 s; past this the twin goes out with what it has and fills by polling

export function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i.test(url) || isKhanVideo(url);
}

/** A message that is already one plain sentence a listener can act on. */
class VideoError extends Error {}

const E_OPEN = "I could not open that video. It may be private or removed.";
const E_RESTRICTED = "I could not read that video. Its owner may have restricted access to it.";
const E_MODEL = "I could not read that video just now. Try again in a minute.";

/** Map any failure to one short sentence; the raw error never reaches the listener. */
export function plainVideoError(e: unknown): string {
  if (e instanceof VideoError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/embedd|restricted|age.restrict|sign in|copyright/i.test(m)) return E_RESTRICTED;
  if (/HTTP (400|403|404)|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|Unsupported MIME/i.test(m)) return E_OPEN;
  return E_MODEL;
}

export async function videoToTwin(url: string): Promise<VideoTwin> {
  try {
    let id = youtubeId(url);
    let title: string | null = null;
    if (!id && isKhanVideo(url)) {
      const k = await khanVideo(url);
      if (!k) throw new VideoError("I could not find the video on that Khan Academy page.");
      ({ id, title } = k);
    }
    if (!id) throw new VideoError("Only public YouTube and Khan Academy video links are supported.");
    if (process.env.ARC_CAPTIONS === "unofficial") {
      const fast = await fromCaptions(id, url, title).catch((e) => {
        if (e instanceof VideoError) throw e;
        console.log(`[video] ${id}: captions route unavailable (${e instanceof Error ? e.message : e}); Gemini reads the video`);
        return null;
      });
      if (fast) return fast;
    }
    return await fromGemini(id, url, title);
  } catch (e) {
    if (!(e instanceof VideoError)) console.log(`[video] ${url}: ${e instanceof Error ? e.message : e}`);
    throw new Error(plainVideoError(e));
  }
}

async function twinOf(id: string, url: string, title: string, t0: number, captions: VideoTwin["video"]["captions"], via: Twin["source"]["via"]): Promise<VideoTwin> {
  const s = await status(id);
  return withLang({
    id: `v-${id}`,
    source: { url, kind: "video", title, via, ms: Date.now() - t0 },
    nodes: s.segments,
    counts: { sections: 0, figures: 0, segments: s.segments.length },
    video: { id, duration: s.duration, captions, enriched: s.done },
  });
}

/** Official route. A removed or private video has no oEmbed: one plain line, no model call. */
async function fromGemini(id: string, url: string, khanTitle: string | null): Promise<VideoTwin> {
  const t0 = Date.now();
  const canonical = youtubeCanonical(id);
  // oEmbed first (about 0.1 s): a removed or private video must not start a job or a model call.
  const meta = await youtubeOembed(canonical, AbortSignal.timeout(5_000)).catch(() => null);
  if (!meta) throw new VideoError(E_OPEN);
  const j = await job(id, canonical);
  await firstWindow(j, FIRST_WAIT_MS);
  const no = refusalLine();
  if (no && !(await status(id)).segments.length) throw new VideoError(no); // nothing stored and no budget to read it
  return twinOf(id, url, khanTitle || meta.title, t0, j.source === "captions" ? "human" : "none", "gemini");
}

/** Opt-in route: YouTube's unofficial player API. Throws a plain Error (not VideoError) when the Gemini route should take over. */
async function fromCaptions(id: string, url: string, khanTitle: string | null): Promise<VideoTwin> {
  const t0 = Date.now();
  const canonical = youtubeCanonical(id);
  if ((await status(id)).segments.length) throw new Error("already read"); // a stored job, whichever route made it: served as is
  const p = await player(id);
  if (p.status === "ERROR") throw new VideoError(E_OPEN); // YouTube says the video does not exist
  if (!p.ok) throw new Error(`YouTube refused the captions (${p.status})`);
  const track = pickTrack(p.tracks);
  if (!track) throw new Error("no caption tracks");
  const cues = await fetchCues(track);
  if (!cues.length) throw new Error("empty captions");
  const total = Math.max(p.seconds, Math.ceil(cues[cues.length - 1].end));
  const seed: TwinNode[] = segmentCues(cues, total).map((s, i) => ({
    id: `n${String(i + 1).padStart(2, "0")}`,
    kind: "segment",
    order: i,
    level: 3,
    heading: clock(s.start),
    text: s.text,
    start: s.start,
    end: s.end,
  }));
  await job(id, canonical, seed);
  return twinOf(id, url, khanTitle || p.title || id, t0, track.kind === "asr" ? "auto" : "human", "direct");
}
