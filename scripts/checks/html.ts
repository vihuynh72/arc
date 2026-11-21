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

// Real MediaWiki markup (en.wikipedia Quadratic_formula, first figure): {{math|...{{sfrac|1|2}}...}} keeps its slash in a .sr-only span.
const SFRAC = (n: number, d: number) => `<span class="sfrac"><span typeof="mw:Entity">⁠</span><span class="tion"><span class="num">${n}</span><span class="sr-only">/</span><span class="den">${d}</span></span><span typeof="mw:Entity">⁠</span></span>`;
const WIKI = `<html><head><title>Quadratic formula - Wikipedia</title></head><body><div class="mw-body"><main><h1>Quadratic formula</h1>
<p>${"In elementary algebra, the quadratic formula is a closed-form expression describing the solutions of a quadratic equation. ".repeat(4)}</p>
<figure class="mw-default-size" typeof="mw:File/Thumb"><a href="/wiki/File:Quadratic_formula.svg"><img src="//upload.wikimedia.org/a/ab/Quadratic.svg/640px-Quadratic.svg.png" width="640" height="480" alt="Graph"></a>
<figcaption>The roots of the quadratic function <span class="texhtml "><i>y</i> = ${SFRAC(1, 2)}<i>x</i><sup>2</sup> − 3<i>x</i> + ${SFRAC(5, 2)}</span> are the places where the graph intersects the <i>x</i>-axis, the values <i>x</i> = 1 and <i>x</i> = 5.</figcaption></figure>
<table class="wikitable"><caption>Values of <span class="texhtml"><i>y</i> = ${SFRAC(1, 2)}<i>x</i></span></caption><tr><th>x</th><th>y</th></tr><tr><td>2</td><td>${SFRAC(3, 4)}</td></tr></table>
<p>A mixed number: <span class="sfrac">3<span class="tion"><span class="num">1</span><span class="sr-only">/</span><span class="den">2</span></span></span> cups, or 2<span class="frac"><sup>1</sup>\u2044<sub>4</sub></span> tsp.</p>
</main></div></body></html>`;

// Semantic Scholar: a citation string, author cards and reference listings around an abstract that lives in the JSON-LD.
const S2 = `<html><head><title>Attention | Semantic Scholar</title><meta name="s2-ui-version" content="1">
<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[]},[{"@type":"ScholarlyArticle","abstract":"The dominant sequence transduction models are recurrent. We propose the Transformer.","author":[{"name":"Ashish Vaswani"},{"name":"Noam Shazeer"},{"name":"Illia Polosukhin"}],"datePublished":"12 June 2017","publisher":{"@type":"Organization","name":"Neural Information Processing Systems"}}]]}</script></head>
<body><div><ul class="paper-meta"><li data-test-id="paper-doi">DOI: 10.1/x</li><li data-test-id="corpus-id">Corpus ID: 13756489</li></ul><h1 data-test-id="paper-detail-title">Attention is All you Need</h1>
<pre class="bibtex-citation">@inproceedings{Vaswani2017, title={Attention}}</pre><span><span>Ashish Vaswani</span></span><div><h2>41 References</h2><h3>Can Active Memory Replace Attention?</h3><p>Showing 1 through 2 of 10 Related Papers</p></div></div></body></html>`;
// IEEE Xplore: the article, then a footer of account links and help phone numbers.
const IEEE = `<html><head><title>Deep Residual Learning | IEEE</title><meta name="citation_title" content="Deep Residual Learning"></head><body><main>
<h2>Abstract:</h2><p>${"Deeper neural networks are more difficult to train. ".repeat(8)}</p><h2>Introduction</h2><p>${"Deep convolutional networks have led to breakthroughs. ".repeat(8)}</p></main>
<section id="xploreFooter"><h3>IEEE Account</h3><ul><li>Change Username/Password</li></ul><h3>Need Help?</h3><p>US &amp; Canada: +1 800 678 4333</p></section></body></html>`;

export default function check() {
  // A wiki thumbnail links to its file page, whose namespace word differs by language: the picture is the image file, never that page.
  for (const ns of ["Archivo", "Ficheiro", "Bestand", "T%E1%BA%ADp_tin", "%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB", "File"]) {
    const w = parseHtml(
      `<html><head><title>Fotosíntesis</title></head><body><main><h1>Fotosíntesis</h1><p>${"La fotosíntesis convierte la luz en energía química. ".repeat(8)}</p><figure typeof="mw:File/Thumb"><a href="/wiki/${ns}:Photosynthesis-es.png" class="mw-file-description"><img src="//upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Photosynthesis-es.png/500px-Photosynthesis-es.png" width="500" height="400" alt=""></a><figcaption>Esquema de la fotosíntesis.</figcaption></figure></main></body></html>`,
      "https://es.wikipedia.org/wiki/Fotos%C3%ADntesis",
    );
    const pic = w.nodes.find((n) => n.kind === "figure")?.image?.url ?? "";
    assert.match(pic, /^https:\/\/upload\.wikimedia\.org\/.*500px-Photosynthesis-es\.png$/, `${ns}: ${pic}`);
  }

  const a = parseHtml(ARTICLE, "https://example.org/bio/cells");
  assert.equal(a.source.title, "Cells");
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.kind, n.heading]),
    [
      ["n01", "section", "Introduction"],
      ["n02", "section", "Structure"],
      ["n03", "figure", "Figure 2"],
      ["n04", "section", "Table of parts"],
    ],
  );
  const all = JSON.stringify(a);
  for (const junk of ["NAVJUNK", "REFJUNK", "FOOTJUNK", "[edit]", "[1]", "References"]) assert.ok(!all.includes(junk), junk);
  const fig = a.nodes[2];
  assert.equal(fig.image?.url, "https://example.org/img/cell.png");
  assert.equal(fig.image?.alt, "A cell diagram");
  assert.equal(fig.text, "Figure 2. Parts of a cell.");
  assert.match(a.nodes[1].text, /membrane surrounds the cell\.\n\nNucleus\.\n\nRibosome\./);
  const tb = a.nodes[3].blocks?.[0];
  assert.equal(tb?.kind, "table");
  assert.equal(tb?.text, "Organelles\nName | Job\nNucleus | Holds DNA");
  assert.equal(tb?.say, "Table with 1 row and 2 columns: Organelles. Name: Nucleus, Job: Holds DNA.");
  assert.match(a.source.credit ?? "", /creativecommons/);
  assert.deepEqual(a.counts, { sections: 3, figures: 1, segments: 0 });
  assert.deepEqual(a.nodes[1].blocks?.map((b) => [b.id, b.kind]), [["n02.b01", "paragraph"], ["n02.b02", "item"], ["n02.b03", "item"]]);

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

  // Fractions in a caption keep their structure (they once read "12x² − 3x + 52").
  const w = parseHtml(WIKI, "https://en.wikipedia.org/wiki/Quadratic_formula");
  const capFig = w.nodes.find((n) => n.kind === "figure")!;
  assert.ok(capFig.text.startsWith("The roots of the quadratic function y = (1/2) x² − 3x + (5/2) are"), capFig.text);
  assert.ok(!/12x|52 /.test(capFig.text));
  assert.ok(/Values of y = \(1\/2\) x/.test(JSON.stringify(w)), "a table caption goes through the same conversion");
  assert.ok(/3 1\/2 cups, or 2 1\/4 tsp/.test(JSON.stringify(w)), "an {{sfrac|3|1|2}} mixed number " + JSON.stringify(w.nodes.map((n) => n.text.slice(-120))));

  // Semantic Scholar keeps title, authors, venue and abstract; the citation string, cards and listings go.
  const s2 = parseHtml(S2, "https://www.semanticscholar.org/paper/x/204e");
  assert.deepEqual(s2.nodes.map((n) => n.heading), ["Authors", "Published", "Abstract"]);
  assert.equal(s2.nodes[0].text, "Ashish Vaswani, Noam Shazeer, and Illia Polosukhin.");
  assert.equal(s2.nodes[1].text, "Neural Information Processing Systems, 12 June 2017.");
  assert.ok(s2.nodes[2].text.startsWith("The dominant sequence transduction models"));
  assert.ok(!/inproceedings|Corpus ID|Related Papers|Active Memory/.test(JSON.stringify(s2)));
  // IEEE Xplore: no footer links or phone numbers after the article.
  const ie = parseHtml(IEEE, "https://ieeexplore.ieee.org/document/7780459");
  assert.deepEqual(ie.nodes.map((n) => n.heading), ["Abstract:", "Introduction"]);
  assert.ok(!/IEEE Account|Need Help|800 678/.test(JSON.stringify(ie)));
}
