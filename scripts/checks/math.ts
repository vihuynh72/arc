// Offline check for lib/parse/math.ts (LaTeX and MathML to shown and spoken forms), run by `npm run selfcheck`.
import assert from "node:assert";
import * as cheerio from "cheerio";
import { mathmlToTex, texToSpeech } from "../../lib/parse/math";

const say = (t: string) => texToSpeech(t).say;

export default function check() {
  assert.equal(say("a^2 + b^2 = c^2"), "a squared plus b squared equals c squared");
  assert.equal(texToSpeech("a^2 + b^2 = c^2").text, "a² + b² = c²");
  assert.equal(say("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"), "x equals the fraction negative b plus or minus the square root of b squared minus 4 a c, end root, over 2 a, end fraction");
  assert.equal(say("\\frac{1}{2}"), "1 over 2");
  assert.equal(say("\\tfrac12 x"), "1 over 2 x");
  assert.equal(say("P(A\\mid B)"), "P of A given B");
  assert.equal(say("P(A\\vert B)"), "P of A given B");
  assert.equal(say("\\sum_{i=1}^{n} i"), "the sum from i equals 1 to n of i");
  assert.equal(say("\\int_0^1 x^2\\,dx"), "the integral from 0 to 1 of x squared d x");
  assert.equal(say("\\lim_{x \\to 0} f(x)"), "the limit as x approaches 0 of f of x");
  assert.equal(say("x_{i+1}"), "x sub i plus 1, end sub");
  assert.equal(say("\\sqrt[3]{27}"), "the cube root of 27");
  assert.equal(say("\\alpha \\leq \\Gamma"), "alpha is less than or equal to capital gamma");
  assert.equal(say("(a+b)^2"), "the quantity a plus b, squared");
  assert.equal(say("f'(x)"), "f prime of x");
  assert.equal(say("e^{i\\pi} + 1 = 0"), "e to the power of i pi, end power, plus 1 equals 0");
  assert.equal(say("{\\displaystyle E=mc^{2}}"), "E equals m c squared");
  assert.equal(say("\\ce{H2O}"), "H 2 O");
  assert.equal(say("\\|\\mathbf{v}\\|^2 = \\sum_{k=1}^3 \\|\\mathbf{v}_k\\|^2"), "the norm of v, squared equals the sum from k equals 1 to 3 of the norm of v sub k, squared");
  assert.equal(say("|b| = \\sgn(b) b"), "the absolute value of b equals sign of of b b");
  assert.ok(texToSpeech("\\frac{a}{b}").ok);
  assert.ok(!texToSpeech("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}").ok, "a matrix is left to the model");
  assert.ok(!texToSpeech("\\weirdcommand{x}").ok, "unknown commands are flagged");

  // MathML without TeX: rebuilt, then spoken.
  const $ = cheerio.load(`<math><mfrac><mrow><mi>a</mi><mo>+</mo><mn>1</mn></mrow><msup><mi>b</mi><mn>2</mn></msup></mfrac></math>`, { xml: true });
  const tex = mathmlToTex($("math")[0]);
  assert.equal(tex, "\\frac{a+1}{{b}^{2}}");
  assert.equal(say(tex), "the fraction a plus 1, over b squared, end fraction");
  const $2 = cheerio.load(`<math><msqrt><mi>x</mi></msqrt><mo>≤</mo><mi>π</mi></math>`, { xml: true });
  assert.equal(say(mathmlToTex($2("math")[0])), "the square root of x is less than or equal to pi");

  // A stacked fraction beside another factor is bracketed: "1/2x²" would read as 1/(2x²).
  assert.equal(texToSpeech("y = \\tfrac{1}{2}x^2 - 3x + \\tfrac{5}{2}").text, "y = (1/2)x² − 3x + 5/2");
  assert.equal(texToSpeech("\\frac{1}{2}").text, "1/2");
    assert.equal(texToSpeech("\\frac{a}{b}c").text, "(a/b)c");
}
