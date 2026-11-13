// Live Gemini check: `npx tsx scripts/try-gemini.ts` (run twice: the second tour comes from cache).
import { getTour } from "../lib/server/tour";
import { videoToTwin } from "../lib/server/video";

process.loadEnvFile(".env.local");

const FIG2 = "https://mdpi-res.com/sensors/sensors-24-01935/article_deploy/html/images/sensors-24-01935-g002-550.jpg";
const VIDEO = "https://www.youtube.com/watch?v=EPvd-3712U8"; // Khan Academy, Calculating atomic weight, 4:26

(async () => {
  let t = Date.now();
  const tour = await getTour(FIG2);
  console.log(`getTour: ${Date.now() - t} ms`);
  if (!tour) throw new Error("no tour");
  console.log(tour.title, "|", tour.overview);
  for (const s of tour.stops) console.log(s.n, s.label, JSON.stringify(s.box_2d), s.confidence, "|", s.says);
  if (tour.stops.length < 5 || tour.stops.length > 10) throw new Error(`stops: ${tour.stops.length}`);
  for (const s of tour.stops) {
    const [y0, x0, y1, x1] = s.box_2d;
    if (![y0, x0, y1, x1].every((v) => v >= 0 && v <= 1000) || y0 >= y1 || x0 >= x1) throw new Error(`bad box ${s.n}`);
  }

  t = Date.now();
  const twin = await videoToTwin(VIDEO);
  console.log(`videoToTwin: ${Date.now() - t} ms (source.ms ${twin.source.ms})`, twin.counts);
  console.log(twin.source.title);
  for (const n of twin.nodes) {
    console.log(n.kind === "section" ? `${n.id} # ${n.heading}: ${n.text}` : `${n.id}   [${n.start}-${n.end}] ${n.heading} | ${n.text}`);
  }
  const segs = twin.nodes.filter((n) => n.kind === "segment");
  if (twin.counts.sections < 2 || segs.length < 5) throw new Error("too few chapters/segments");
  segs.forEach((s, i) => {
    if (s.end! <= s.start! || (i && s.start! < segs[i - 1].start!)) throw new Error("times not ascending");
  });
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
