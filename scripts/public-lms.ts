// Runs extension/extract.js on public learning-system pages (no sign-in) and sends each to Arc's /api/ingest, printing structure:
//   npx tsx scripts/public-lms.ts [url ...]   (Arc at http://localhost:3000; Google Chrome, headless)
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
type Sent = { via?: string; trace?: { endpoint: string; status: number }[]; html?: string; images?: unknown[]; frames?: unknown[]; lines?: unknown[]; links: { rel?: string; label: string }[] };
type Got = { nodes: { heading: string; text: string }[]; counts: { sections: number; figures: number }; source: { assessment?: boolean } };

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : [
  // The vendors' own demo and help pages only; pass any other public page as an argument.
  "https://school.moodledemo.net/course/view.php?id=51",
  "https://help.blackboard.com/Learn/Student/Ultra/Course_Content",
  "https://documentation.brightspace.com/EN/le/content/learner/content_navigate_content_topics.htm",
];
const EXTRACT = readFileSync("extension/extract.js", "utf8");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  for (const url of URLS) {
    const page = await b.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.evaluate(EXTRACT);
      const t0 = Date.now();
      const p = (await page.evaluate(() => (globalThis as unknown as { __arcExtract: () => unknown }).__arcExtract())) as Sent;
      const ms = Date.now() - t0;
      const res = await fetch("http://localhost:3000/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
      const r = await res.json();
      const t = r.id ? ((await (await fetch("http://localhost:3000/api/ingest", { headers: { "x-arc-doc": r.id } })).json()) as Got) : null;
      const chars = t ? t.nodes.reduce((n, x) => n + x.text.length, 0) : 0;
      console.log(`\n${new URL(page.url()).host}${new URL(page.url()).pathname} (${ms} ms, via ${p.via ?? "rendered page"}${p.trace ? `; api ${p.trace.map((x) => `${x.endpoint.split("?")[0]} ${x.status}`).join(", ")}` : ""})`);
      console.log(`  sent: html ${p.html?.length ?? 0}, pictures ${p.images?.length ?? 0}, frames ${p.frames?.length ?? 0}, lines ${p.lines?.length ?? 0}`);
      console.log(`  links ${p.links.length}: ${p.links.filter((l) => l.rel).map((l) => `${l.rel}:${l.label}`).join(", ") || "no next/prev"}; first: ${p.links.slice(0, 6).map((l) => l.label).join(" | ")}`);
      console.log(t ? `  twin: ${t.counts.sections} sections, ${t.counts.figures} figures, ${chars} chars, assessment ${!!t.source.assessment}; headings: ${t.nodes.slice(0, 8).map((n) => n.heading).join(" | ")}` : `  ingest ${res.status}: ${r.error}`);
      if (t) console.log(`  opening words: ${t.nodes[0]?.text.slice(0, 140).replace(/\s+/g, " ")}`);
    } catch (e) {
      console.log(`\n${url}: ${(e as Error).message.split("\n")[0]}`);
    }
    await page.close();
  }
  await b.close();
})();
