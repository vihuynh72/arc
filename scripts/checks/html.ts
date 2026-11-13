// Offline check for lib/parse/html.ts, run by `npm run selfcheck`.
import assert from "node:assert";
import { parseHtml } from "../../lib/parse/html";

const ARTICLE = `<!doctype html><html><head><title>Cells | Site</title><link rel="license" href="https://creativecommons.org/licenses/by/4.0/"></head><body>
<nav><ul><li>Home</li><li>NAVJUNK menu</li></ul></nav>
<article><h1>Cells</h1>
<p>A cell is the basic unit of life. Every living thing is made of cells.[1] This first paragraph is long enough to count as real body text for the content picker, and it keeps going a little more so that the article clearly wins over the menu and the footer.</p>
<h2>Structure<span class="mw-editsection">[edit]</span></h2>
<p>The membrane surrounds the cell.[2][3]</p>
<figure><img src="/img/cell.png" alt="A cell diagram" width="640" height="480"><figcaption>Figure 2. Parts of a cell.</figcaption></figure>
<ul><li>Nucleus</li><li>Ribosome</li></ul>
<h3>Table of parts</h3>
<table><caption>Organelles</caption><tr><th>Name</th><th>Job</th></tr><tr><td>Nucleus</td><td>Holds DNA</td></tr></table>
<h2>References</h2><ol><li>REFJUNK Smith 2020.</li></ol>
</article><footer>FOOTJUNK</footer></body></html>`;

const LAZY = `<html><head><meta property="og:title" content="Lazy page"></head><body><main>
<p>${"Plants make food from light. ".repeat(30)}</p>
<img src="data:image/gif;base64,R0lGOD" data-src="//cdn.example.org/a/leaf.jpg" alt="A green leaf" width="800" height="600">
<img src="/icons/logo.png" width="32" height="32" alt="Site logo">
<h2>Light</h2><p>Light drives it.</p>
<figure><img srcset="https://cdn.example.org/s.jpg 400w, https://cdn.example.org/l.jpg 1200w" src="https://cdn.example.org/s.jpg"></figure>
</main></body></html>`;

export default function check() {
  const a = parseHtml(ARTICLE, "https://example.org/bio/cells");
  assert.equal(a.source.title, "Cells");
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.kind, n.heading]),
    [
      ["n01", "section", "Introduction"],
      ["n02", "section", "Structure"],
      ["n03", "figure", "Figure 2"],
      ["n04", "section", "Table of parts"],
      ["n05", "section", "Organelles"],
    ],
  );
  const all = JSON.stringify(a);
  for (const junk of ["NAVJUNK", "REFJUNK", "FOOTJUNK", "[edit]", "[1]", "References"]) assert.ok(!all.includes(junk), junk);
  const fig = a.nodes[2];
  assert.equal(fig.image?.url, "https://example.org/img/cell.png");
  assert.equal(fig.image?.alt, "A cell diagram");
  assert.equal(fig.text, "Figure 2. Parts of a cell.");
  assert.match(a.nodes[1].text, /membrane surrounds the cell\.\n\nNucleus\.\n\nRibosome\./);
  assert.match(a.nodes[4].text, /1 row\.\n\nName: Nucleus, Job: Holds DNA\./);
  assert.match(a.source.credit ?? "", /creativecommons/);
  assert.deepEqual(a.counts, { sections: 4, figures: 1, segments: 0 });

  const b = parseHtml(LAZY, "https://example.org/plants");
  assert.equal(b.source.title, "Lazy page");
  const figs = b.nodes.filter((n) => n.kind === "figure");
  assert.deepEqual(
    figs.map((f) => f.image?.url),
    ["https://cdn.example.org/a/leaf.jpg", "https://cdn.example.org/l.jpg"],
  );
  assert.equal(figs[0].text, "A green leaf");
  assert.equal(figs[1].text, "No caption.");
  assert.equal(figs[1].image?.alt, null);
  assert.deepEqual(
    b.nodes.map((n) => n.heading),
    ["Introduction", "Figure 1", "Light", "Figure 2"],
  );
}
