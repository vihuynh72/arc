// Offline check: lib/parse/html.ts emits blocks of each kind in order, math is spoken, menus and furniture stay out.
import assert from "node:assert";
import { parseHtml, troublesOf } from "../../lib/parse/html";
import { cleanTitle } from "../../lib/parse/title";

const long = "Light energy is captured by pigments in the membrane and stored as chemical energy for later use by the cell. ";
const PAGE = `<html><head><meta name="citation_title" content="Light and Life"></head><body>
<div class="sidebar"><h3>Entry Navigation</h3><ul><li><a href="#a">Entry Contents</a></li><li><a href="#b">Bibliography</a></li><li><a href="/t">Academic Tools</a></li></ul></div>
<main><h1>Light and Life</h1>
<ul class="article-tabs"><li><a href="?v=1">Article</a></li><li><a href="?v=2">Authors</a></li><li><a href="?v=3">Metrics</a></li></ul>
<p>${long.repeat(6)}</p>
<h2>Steps</h2>
<p>The steps are:</p>
<ol><li>Absorb light</li><li>Split water<ul><li>Release oxygen</li></ul></li></ol>
<blockquote><p>Nature does nothing in vain.</p></blockquote>
<p>The energy is <math alttext="E = h\\nu"><mi>E</mi></math> per photon.</p>
<p><math display="block" data-mw='{"name":"math","body":{"extsrc":"x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}"}}'><mi>x</mi></math></p>
<table class="ltx_equation"><tr><td><math alttext="a^2+b^2=c^2" display="block"><mi>a</mi></math></td><td class="ltx_eqn_eqno">(2)</td></tr></table>
<table><caption>Rates</caption><tr><th>Plant</th><th>Rate</th></tr><tr><td>Oak</td><td>3</td></tr><tr><td>Fern</td><td>1</td></tr></table>
<p>Raw TeX in text: \\(\\frac{1}{2}\\) of the light.</p>
<p><math display="block"><mrow><mo>[</mo><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable><mo>]</mo></mrow></math></p>
<h2>Empty parent</h2><h3>Child</h3><p>Child text.</p>
<h2>Nothing here</h2>
<h2>References</h2><p>REFJUNK</p>
</main></body></html>`;

export default function check() {
  assert.equal(cleanTitle("Bayes' theorem - Wikipedia"), "Bayes' theorem");
  assert.equal(cleanTitle("Applying mathematical reasoning | Pre-Algebra | Khan Academy"), "Applying mathematical reasoning");
  assert.equal(cleanTitle("COVID-19 - a review of treatments and outcomes"), "COVID-19 - a review of treatments and outcomes");
  assert.equal(cleanTitle("Mitosis - Biology 2e | OpenStax"), "Mitosis");
  const so = parseHtml(`<html><head><title>Why is it faster? - Stack Overflow</title></head><body><div class="js-signup-banner"><h1>Join Stack Overflow</h1></div><div id="content"><div id="question-header"><h1>Why is it faster?</h1></div><p>${"Sorted arrays help the branch predictor guess right. ".repeat(20)}</p></div></body></html>`, "https://stackoverflow.com/q/1");
  assert.equal(so.source.title, "Why is it faster?", "a sign-up banner's h1 is not the title");
  const t = parseHtml(PAGE, "https://example.org/light");
  assert.equal(t.source.title, "Light and Life");
  const all = JSON.stringify(t);
  for (const junk of ["Entry Contents", "Bibliography", "Academic Tools", "Metrics", "REFJUNK", "Nothing here"]) assert.ok(!all.includes(junk), junk);
  assert.equal(t.nodes[0].blocks?.[0].text.slice(0, 20), "Light energy is capt", "the first words read are the article's");
  const steps = t.nodes.find((n) => n.heading === "Steps")!;
  const kinds = steps.blocks!.map((b) => `${b.kind}:${b.text.slice(0, 12)}`);
  assert.deepEqual(kinds, [
    "paragraph:The steps ar",
    "item:1. Absorb li",
    "item:2. Split wat",
    "item:Release oxyg",
    "quote:Nature does ",
    "paragraph:The energy i",
    "equation:x = (− b ± √",
    "equation:a² + b² = c²",
    "table:Rates\nPlant ",
    "paragraph:Raw TeX in t",
    "equation:[ab cd]",
  ]);
  const b = (i: number) => steps.blocks![i];
  assert.deepEqual(steps.blocks!.map((x) => x.id).slice(0, 3), [`${steps.id}.b01`, `${steps.id}.b02`, `${steps.id}.b03`]);
  assert.equal(b(5).say, "The energy is E equals h nu per photon.", "inline math is spoken inside the paragraph");
  assert.equal(b(6).say, "x equals the fraction negative b plus or minus the square root of b squared minus 4 a c, end root, over 2 a, end fraction");
  assert.equal(b(7).text, "a² + b² = c² (2)");
  assert.equal(b(7).say, "Equation 2: a squared plus b squared equals c squared");
  assert.equal(b(8).say, "Table with 2 rows and 2 columns: Rates. Plant: Oak, Rate: 3. Plant: Fern, Rate: 1.");
  assert.equal(b(9).say, "Raw TeX in text: 1 over 2 of the light.");
  assert.equal(steps.text, steps.blocks!.map((x) => x.text).join("\n\n"), "text stays the joined blocks");
  assert.ok(t.nodes.some((n) => n.heading === "Empty parent: Child"), "an empty parent merges into its first child");
  const notes = troublesOf(t);
  assert.deepEqual(notes.map((n) => [n.node, n.why, n.blocks]), [[steps.id, "equation", [b(10).id]]], "only the matrix needs the model");
}
