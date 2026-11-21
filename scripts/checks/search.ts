// Run by scripts/selfcheck.ts: the search's order (relevance before source, study sources first, mirrors once) and its race
// (a failing route and a slow one: the slow one's answer is used; empty only when every route has finished empty).
import assert from "node:assert/strict";
import { contentWords, hasStudy, mirror, order, race, relevant, type Hit } from "../../lib/server/search";

const h = (url: string, title: string, snippet = ""): Hit => ({ url, title, snippet });

export default async function check() {
  assert.deepEqual(contentWords("the one about how cells divide"), ["cells", "divide"]);
  assert.ok(relevant(h("https://x.org", "Cell division"), "biology cells divide"), "stems: cells/cell, divide/division");
  assert.ok(!relevant(h("https://www.youtube.com/watch?v=1", "OpenStax Biology 2e Chapters 1.1 & 1.2: The Science of Biology"), "photosynthesis"));

  // Relevance before source: the unrelated OpenStax video goes below a relevant page from an unknown site.
  const list = order(
    [
      h("https://www.youtube.com/watch?v=1", "OpenStax Biology 2e Chapters 1.1 & 1.2", "The science of biology"),
      h("https://example.net/p", "Photosynthesis explained", "How plants make sugar"),
      h("https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis", "8.1 Overview of Photosynthesis - Biology 2e | OpenStax"),
      h("https://courses.lumenlearning.com/x/chapter/overview", "Overview of Photosynthesis | OpenStax Biology 2e - Lumen Learning"),
      h("https://bio.libretexts.org/x/8.1", "8.1: Overview of Photosynthesis - Biology LibreTexts"),
      h("https://bio.libretexts.org/x/5", "5: Photosynthesis - Biology LibreTexts"),
      h("https://mhcc.pressbooks.pub/micro/8-6", "8.6 Photosynthesis – Microbiology (OpenStax)"),
    ],
    "photosynthesis openstax biology",
  );
  assert.equal(list[0].url, "https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis");
  assert.equal(list.filter((x) => mirror(x.title) === "m:overview of photosynthesis").length, 1, "the mirrored chapter is listed once");
  assert.ok(list.some((x) => x.url.includes("pressbooks")), "one word in common is not a mirror");
  assert.ok(hasStudy(list));
  assert.ok(!hasStudy(order([h("https://www.youtube.com/watch?v=1", "Unrelated vlog")], "krebs cycle")), "an unrelated video is not a study source");
  assert.ok(list.findIndex((x) => x.url.includes("youtube")) > list.findIndex((x) => x.url.includes("example.net")));

  // The race: Google fails, DuckDuckGo is slow but answers, Bing answers too few: the slow full answer wins.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const three = [h("https://a.org/1", "A one"), h("https://a.org/2", "A two"), h("https://a.org/3", "A three")];
  const won = await race([
    ["google", 0, async () => Promise.reject(new Error("down"))],
    ["ddg", 10, async () => (await sleep(120), three)],
    ["bing", 20, async () => [h("https://b.org/1", "B one")]],
  ]);
  assert.equal(won.via, "ddg");
  // Every route too few: the largest partial answer, not "no results".
  const part = await race([
    ["google", 0, async () => [h("https://a.org/1", "A one"), h("https://a.org/2", "A two")]],
    ["ddg", 5, async () => Promise.reject(new Error("timeout"))],
  ]);
  assert.equal(part.results.length, 2);
  await assert.rejects(race([["google", 0, async () => []], ["ddg", 5, async () => Promise.reject(new Error("x"))]]), /web search failed/);
}
