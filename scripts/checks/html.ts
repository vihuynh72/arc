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

const STORE = `<html><head><title>Shop</title></head><body><header>HEADJUNK</header><main>
<h2>Best Sellers</h2>
<ul class="grid">
<li class="item"><a href="/p/mug"><img src="/mug.jpg" alt="Mug" width="400" height="400"><h3>Blue Mug</h3></a><span class="badge" aria-hidden="true">Best seller</span><div class="price"><span class="visually-hidden">Regular price</span><s>$24.99</s> <span>$19.99</span></div><p class="vendor">Acme Ceramics</p></li>
<li class="item"><a href="/p/pan"><h3>Iron Pan</h3></a><div class="price"><span class="visually-hidden">Regular price</span>$40.00 <s>$0.00</s></div></li>
<li class="item"><a href="/p/jug"><h3>Glass Jug</h3></a><div class="price">$15.50</div><p>Holds two litres.</p></li>
</ul>
<h2>New Arrivals</h2>
<div class="row">
<div class="product-card"><a class="card__heading" href="/p/a">Wool Scarf</a><span class="badge badge--sold-out">Sold out</span><div class="price">$32.00</div></div>
<div class="product-card"><a class="card__heading" href="/p/b">Linen Shirt</a><div class="price">$58.00</div></div>
<div class="product-card"><a class="card__heading" href="/p/c">Canvas Tote</a><div class="price">$21.00</div></div>
</div></main><footer>FOOTJUNK</footer></body></html>`;

const NEWS = `<html><head><title>Story</title></head><body><main><article><h1>Story</h1>
<p>${"The city council voted on the new bridge after a long debate. ".repeat(30)}</p>
<h2>Reaction</h2><p>${"Residents said the plan was overdue and welcomed the news. ".repeat(10)}</p>
<section><h2>Most viewed</h2><ol>
<li><a href="/n/1"><h3>Unrelated headline one</h3></a><p>Teaser one.</p></li>
<li><a href="/n/2"><h3>Unrelated headline two</h3></a><p>Teaser two.</p></li>
<li><a href="/n/3"><h3>Unrelated headline three</h3></a><p>Teaser three.</p></li>
<li><a href="/n/4"><h3>Unrelated headline four</h3></a><p>Teaser four.</p></li>
</ol></section></article></main></body></html>`;

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

  // Cards: each becomes one node under the heading that introduces its collection.
  const c = parseHtml(STORE, "https://shop.example.org/");
  assert.deepEqual(
    c.nodes.map((n) => [n.level, n.heading, n.text]),
    [
      [2, "Best Sellers", "3 items."],
      [3, "Blue Mug", "Best seller. Price: $19.99, was $24.99. Acme Ceramics."],
      [3, "Iron Pan", "Price: $40.00."],
      [3, "Glass Jug", "Price: $15.50. Holds two litres."],
      [2, "New Arrivals", "3 items."],
      [3, "Wool Scarf", "Sold out. Price: $32.00."],
      [3, "Linen Shirt", "Price: $58.00."],
      [3, "Canvas Tote", "Price: $21.00."],
    ],
  );
  assert.ok(!JSON.stringify(c).includes("JUNK"));
  assert.deepEqual(c.counts, { sections: 8, figures: 0, segments: 0 });

  // An article's "Most viewed" strip is chrome, not content.
  const d = parseHtml(NEWS, "https://news.example.org/story");
  assert.deepEqual(d.nodes.map((n) => n.heading), ["Introduction", "Reaction"]);
  assert.ok(!/Unrelated|Most viewed|Teaser/.test(JSON.stringify(d)));
}
