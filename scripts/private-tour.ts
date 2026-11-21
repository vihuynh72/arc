// A figure tour on a picture from a private page: built (Gemini vision), served from memory, nothing under .cache/.
//   npx tsx scripts/private-tour.ts   (Arc at http://localhost:3000, Gemini available; one tour, about one light-model call)
import assert from "node:assert";
import { execSync } from "node:child_process";
import { png } from "./private-fixture.mjs";

const ARC = "http://localhost:3000";
(async () => {
  const pic = `data:image/png;base64,${png(480, 320).toString("base64")}`;
  const marker = `TOURMARK${Date.now()}`;
  const r = await (await fetch(`${ARC}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://canvas.example.edu/courses/1/pages/diagram", html: `<main><h1>Membrane diagram ${marker}</h1><p>The diagram shows a membrane with a channel.</p><p><img src="arc-image:0" alt="A blue box beside a dark diagonal line" width="480" height="320"></p></main>`, images: [pic] }) })).json();
  const twin = await (await fetch(`${ARC}/api/ingest`, { headers: { "x-arc-doc": r.id } })).json();
  const img: string = twin.nodes.find((n: { kind: string }) => n.kind === "figure").image.url;
  const key = new URL(img).searchParams.get("img")!;
  const t0 = Date.now();
  let res = await fetch(`${ARC}/api/tour?image=${encodeURIComponent(img)}`);
  for (let k = 0; k < 30 && res.status === 404; k++) {
    await new Promise((d) => setTimeout(d, 1500));
    res = await fetch(`${ARC}/api/tour?image=${encodeURIComponent(img)}`);
  }
  const tour = await res.json();
  console.log(`tour: ${res.status} in ${Date.now() - t0} ms: "${tour.title}", ${tour.stops?.length} stops; overview: ${tour.overview}`);
  for (const s of tour.stops ?? []) console.log(`  stop ${s.n}: ${s.label}: ${s.says}`);
  assert.equal(res.status, 200);
  const t1 = Date.now();
  const again = await fetch(`${ARC}/api/tour?image=${encodeURIComponent(img)}`);
  console.log(`asked again: ${again.status} in ${Date.now() - t1} ms (no model call: held in memory)`);
  const hits = execSync(`grep -rlaF '${key}' .cache/ 2>/dev/null || true; grep -rlaF '${marker}' .cache/ 2>/dev/null || true`).toString().trim();
  console.log(`files under .cache/ naming the picture or the page: ${hits || "none"}`);
  assert.equal(hits, "");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
