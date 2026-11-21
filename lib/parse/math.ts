// LaTeX (and MathML, via a small MathML -> LaTeX step) to a shown form and a spoken form. Deterministic; no model.
// Callers: lib/parse/html.ts (every formula on a page). Checked by scripts/checks/math.ts.
// `ok: false` means some command was not understood: the spoken form is a best effort and the block is flagged for the model.
import type { AnyNode, Element } from "domhandler";

type Node =
  | { t: "seq"; items: Node[] }
  | { t: "sym"; v: string }
  | { t: "num"; v: string }
  | { t: "frac"; n: Node; d: Node }
  | { t: "sqrt"; x: Node; idx?: Node }
  | { t: "script"; base: Node; sup?: Node; sub?: Node }
  | { t: "big"; name: string } // sum, integral, product, limit
  | { t: "fn"; name: string }
  | { t: "text"; v: string; say?: string }
  | { t: "accent"; name: string; x: Node }
  | { t: "fence"; open: string; close: string; body: Node };

const GREEK = "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega".split(" ");
const GREEK_CH = "αβγδεεζηθθικλμνξοπϖρϱσςτυφϕχψω";
const CAP_GREEK: Record<string, string> = { Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω" };
// command -> [shown, spoken]
const SYM: Record<string, [string, string]> = {
  pm: ["±", "plus or minus"], mp: ["∓", "minus or plus"], times: ["×", "times"], cdot: ["·", "times"], div: ["÷", "divided by"], ast: ["*", "times"],
  le: ["≤", "is less than or equal to"], leq: ["≤", "is less than or equal to"], ge: ["≥", "is greater than or equal to"], geq: ["≥", "is greater than or equal to"],
  neq: ["≠", "is not equal to"], ne: ["≠", "is not equal to"], approx: ["≈", "is approximately"], equiv: ["≡", "is equivalent to"], sim: ["∼", "is similar to"],
  simeq: ["≃", "is approximately"], cong: ["≅", "is congruent to"], propto: ["∝", "is proportional to"], ll: ["≪", "is much less than"], gg: ["≫", "is much greater than"],
  to: ["→", "goes to"], rightarrow: ["→", "goes to"], longrightarrow: ["→", "goes to"], leftarrow: ["←", "comes from"], Rightarrow: ["⇒", "implies"], implies: ["⇒", "implies"],
  Leftrightarrow: ["⇔", "if and only if"], iff: ["⇔", "if and only if"], leftrightarrow: ["↔", "goes both ways with"], mapsto: ["↦", "maps to"], rightleftharpoons: ["⇌", "is in equilibrium with"],
  in: ["∈", "is in"], notin: ["∉", "is not in"], subset: ["⊂", "is a subset of"], subseteq: ["⊆", "is a subset of"], cup: ["∪", "union"], cap: ["∩", "intersection"],
  emptyset: ["∅", "the empty set"], varnothing: ["∅", "the empty set"], forall: ["∀", "for all"], exists: ["∃", "there exists"], neg: ["¬", "not"], lnot: ["¬", "not"],
  land: ["∧", "and"], wedge: ["∧", "and"], lor: ["∨", "or"], vee: ["∨", "or"], infty: ["∞", "infinity"], partial: ["∂", "partial"], nabla: ["∇", "del"],
  circ: ["∘", "composed with"], degree: ["°", "degrees"], prime: ["′", "prime"], ldots: ["…", "dot dot dot"], cdots: ["⋯", "dot dot dot"], dots: ["…", "dot dot dot"], vdots: ["⋮", "dot dot dot"],
  mid: ["∣", "given"], vert: ["|", "vertical bar"], parallel: ["∥", "is parallel to"], perp: ["⊥", "is perpendicular to"], angle: ["∠", "angle"], triangle: ["△", "triangle"],
  hbar: ["ħ", "h bar"], ell: ["ℓ", "l"], Re: ["ℜ", "the real part of"], Im: ["ℑ", "the imaginary part of"], aleph: ["ℵ", "aleph"], therefore: ["∴", "therefore"], because: ["∵", "because"],
  langle: ["⟨", "open angle bracket"], rangle: ["⟩", "close angle bracket"], lbrace: ["{", "open brace"], rbrace: ["}", "close brace"], "{": ["{", "open brace"], "}": ["}", "close brace"],
  Vert: ["‖", "norm"], "%": ["%", "percent"], "$": ["$", "dollars"], "&": ["&", "and"], "#": ["#", "number"], _: ["_", "underscore"], lvert: ["|", ""], rvert: ["|", ""], lVert: ["‖", ""], rVert: ["‖", ""],
  colon: [":", ":"], setminus: ["∖", "minus"], oplus: ["⊕", "xor"], otimes: ["⊗", "tensor"], bullet: ["•", "dot"], star: ["⋆", "star"], dagger: ["†", "dagger"],
};
const BIG: Record<string, [string, string]> = {
  sum: ["Σ", "the sum"], prod: ["∏", "the product"], int: ["∫", "the integral"], iint: ["∬", "the double integral"], iiint: ["∭", "the triple integral"], oint: ["∮", "the contour integral"],
  lim: ["lim", "the limit"], limsup: ["lim sup", "the limit superior"], liminf: ["lim inf", "the limit inferior"], bigcup: ["⋃", "the union"], bigcap: ["⋂", "the intersection"],
  max: ["max", "the maximum"], min: ["min", "the minimum"], sup: ["sup", "the supremum"], inf: ["inf", "the infimum"], argmax: ["arg max", "the arg max"], argmin: ["arg min", "the arg min"],
};
const FN: Record<string, string> = {
  sin: "sine", cos: "cosine", tan: "tangent", cot: "cotangent", sec: "secant", csc: "cosecant", arcsin: "arc sine", arccos: "arc cosine", arctan: "arc tangent",
  sinh: "hyperbolic sine", cosh: "hyperbolic cosine", tanh: "hyperbolic tangent", log: "log", ln: "natural log", lg: "log", exp: "exp", det: "determinant of", dim: "dimension of",
  ker: "kernel of", sgn: "sign of", sign: "sign of", tr: "trace of", rank: "rank of", diag: "diag", Var: "variance of", Cov: "covariance of", deg: "degree of", gcd: "g c d of", Pr: "probability of", arg: "argument of", mod: "mod", bmod: "mod", pmod: "mod", operatorname: "",
};
const ACCENT: Record<string, [string, string]> = {
  hat: ["̂", "hat"], widehat: ["̂", "hat"], bar: ["̄", "bar"], overline: ["̅", "bar"], vec: ["⃗", "vector"], dot: ["̇", "dot"], ddot: ["̈", "double dot"],
  tilde: ["̃", "tilde"], widetilde: ["̃", "tilde"], underline: ["̲", "underlined"], overrightarrow: ["⃗", "vector"], boldsymbol: ["", ""], mathbf: ["", ""], bm: ["", ""],
};
const STYLE = new Set("mathrm mathit mathsf mathtt mathcal mathbb mathfrak mathscr textbf textit emph displaystyle textstyle scriptstyle rm it bf boldsymbol mathbf bm cal".split(" "));
const IGNORE = new Set("left right big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr quad qquad , ; ! : > displaystyle textstyle scriptstyle limits nolimits label nonumber notag tag phantom hphantom vphantom strut, mathstrut color textcolor".split(" "));
const OP: Record<string, string> = { "=": "equals", "+": "plus", "-": "minus", "−": "minus", "<": "is less than", ">": "is greater than", "/": "divided by", "!": "factorial", ",": ",", ".": ".", ";": ";", ":": ":", "'": "prime", "|": "|", "*": "times" };

class Parser {
  i = 0;
  ok = true;
  toks: string[];
  constructor(src: string) {
    this.toks = src.match(/\\[a-zA-Z]+\*?|\\[\s\S]|[0-9]+(?:\.[0-9]+)?|\s+|[\s\S]/g) ?? [];
  }
  peek() {
    while (this.i < this.toks.length && /^\s+$/.test(this.toks[this.i])) this.i++;
    return this.toks[this.i];
  }
  next() {
    const t = this.peek();
    this.i++;
    return t;
  }
  /** One argument: a {group} or a single token. */
  arg(): Node {
    const t = this.peek();
    if (t === "{") {
      this.next();
      const s = this.seq("}");
      this.next();
      return s;
    }
    if (t === undefined) return { t: "seq", items: [] };
    if (/^[0-9]{2,}$/.test(t)) {
      // \frac12: an argument is one digit
      this.toks.splice(this.i, 1, t[0], t.slice(1));
    }
    return this.atom() ?? { t: "seq", items: [] };
  }
  /** Raw text of a {group}, for \text{...} and \begin{...}. */
  raw(): string {
    if (this.peek() !== "{") return this.next() ?? "";
    this.next();
    let depth = 1;
    let out = "";
    while (this.i < this.toks.length) {
      const t = this.toks[this.i++];
      if (t === "{") depth++;
      if (t === "}" && --depth === 0) break;
      out += t;
    }
    return out;
  }
  seq(end?: string): Node {
    const items: Node[] = [];
    for (let t = this.peek(); t !== undefined && t !== end && !(end === "\\right" && t === "\\right"); t = this.peek()) {
      if (t === "}" && end !== "}") {
        this.next();
        continue;
      }
      if (t === "^" || t === "_") {
        this.next();
        const prev = items.pop() ?? { t: "seq", items: [] };
        const s: Extract<Node, { t: "script" }> = prev.t === "script" && !prev[t === "^" ? "sup" : "sub"] ? prev : { t: "script", base: prev };
        s[t === "^" ? "sup" : "sub"] = this.arg();
        items.push(s);
        continue;
      }
      if (t === "'" && items.length) {
        // f' is f with a prime
        this.next();
        const prev = items.pop()!;
        items.push(prev.t === "script" && !prev.sup ? { ...prev, sup: { t: "sym", v: "prime" } } : { t: "script", base: prev, sup: { t: "sym", v: "prime" } });
        continue;
      }
      const a = this.atom();
      if (!a) continue;
      if (a.t === "sym" && (a.v === "|" || a.v === "Vert" || a.v === "vert")) {
        // |x| and \|v\| pairs fold into an absolute value and a norm; a lone | (P(A|B)) stays a bar
        const k = items.map((x) => x.t === "sym" && x.v === a.v).lastIndexOf(true);
        if (k >= 0 && k < items.length - 1) {
          const body = items.splice(k).slice(1);
          items.push({ t: "fence", open: a.v, close: a.v, body: body.length === 1 ? body[0] : { t: "seq", items: body } });
          continue;
        }
      }
      if (a.t === "sym" && (a.v === ")" || a.v === "]")) {
        // a closing bracket folds its contents into a fence, so a power or "of" applies to the whole bracket
        const want = a.v === ")" ? "(" : "[";
        let k = items.length - 1;
        while (k >= 0 && !(items[k].t === "sym" && (items[k] as { v: string }).v === want)) k--;
        if (k >= 0) {
          const body = items.splice(k).slice(1);
          items.push({ t: "fence", open: want, close: a.v, body: body.length === 1 ? body[0] : { t: "seq", items: body } });
          continue;
        }
      }
      items.push(a);
    }
    return items.length === 1 ? items[0] : { t: "seq", items };
  }
  atom(): Node | null {
    const t = this.next();
    if (t === undefined) return null;
    if (t === "{") {
      const s = this.seq("}");
      this.next();
      return s;
    }
    if (/^[0-9]/.test(t)) return { t: "num", v: t };
    if (t === "&" || t === "~") return null;
    if (t === "\\\\") {
      if (this.peek() === "[") while (this.i < this.toks.length && this.next() !== "]"); // \\[3mu] line break with spacing
      return { t: "sym", v: ";" };
    }
    if (!t.startsWith("\\")) return { t: "sym", v: t };
    const c = t.slice(1).replace(/\*$/, "");
    if (c === "frac" || c === "dfrac" || c === "tfrac" || c === "cfrac") return { t: "frac", n: this.arg(), d: this.arg() };
    if (c === "binom" || c === "dbinom" || c === "tbinom") {
      const n = this.arg();
      const k = this.arg();
      return { t: "seq", items: [{ t: "fn", name: "__choose" }, n, { t: "fn", name: "__choose2" }, k, { t: "text", v: ")" }] };
    }
    if (c === "sqrt") {
      let idx: Node | undefined;
      if (this.peek() === "[") {
        this.next();
        idx = this.seq("]");
        this.next();
      }
      return { t: "sqrt", x: this.arg(), idx };
    }
    if (c === "left") {
      const open = this.next() ?? "(";
      const body = this.seq("\\right");
      this.next();
      const close = this.next() ?? ")";
      return { t: "fence", open: open.replace(/^\\/, ""), close: close.replace(/^\\/, ""), body };
    }
    if (c === "text" || c === "textrm" || c === "mbox" || c === "textnormal" || c === "textsf" || c === "texttt") return { t: "text", v: this.raw() };
    if (c === "operatorname") return { t: "fn", name: this.raw() };
    if (c === "PageIndex") return { t: "text", v: this.raw() }; // LibreTexts numbering macro: Figure \(\PageIndex{1}\)
    if (c === "ce" || c === "pu") {
      const r = this.raw();
      return { t: "text", v: r.replace(/<=>|<->/g, "⇌").replace(/->/g, "→").replace(/[{}]/g, ""), say: chem(r) };
    }
    if (c === "begin") {
      const env = this.raw();
      const body = this.seq("\\end");
      this.next();
      this.raw();
      if (/matrix|array|cases|aligned|align|gathered|split|eqnarray/.test(env)) {
        if (/matrix|array/.test(env)) this.ok = false; // a matrix needs a real reading; leave it to the model
        return /cases/.test(env) ? { t: "seq", items: [{ t: "text", v: "cases:" }, body] } : body;
      }
      return body;
    }
    if (c === "end") return null;
    if (c in BIG) return { t: "big", name: c };
    if (c in FN) return { t: "fn", name: c };
    if (c in ACCENT) {
      const x = this.arg();
      return ACCENT[c][1] ? { t: "accent", name: c, x } : x;
    }
    if (STYLE.has(c)) {
      const word = this.peek() === "{" ? this.toks.slice(this.i, this.toks.indexOf("}", this.i) + 1).join("") : "";
      if (/^\{[A-Za-z]{2,}\}$/.test(word)) return { t: "text", v: this.raw() }; // \mathrm{softmax} is a word
      return this.arg();
    }
    if (IGNORE.has(c)) {
      if (c === "color" || c === "textcolor" || c === "label" || c === "tag") this.raw();
      if (c === "phantom" || c === "hphantom" || c === "vphantom") this.raw();
      return null;
    }
    if (c === "|") return { t: "sym", v: "Vert" }; // \| is a norm bar
    if (c in CAP_GREEK || GREEK.includes(c) || c in SYM) return { t: "sym", v: c };
    if (c.startsWith("var") && GREEK.includes(c.slice(3))) return { t: "sym", v: c.slice(3) };
    this.ok = false;
    return { t: "text", v: c };
  }
}

/** mhchem: "H2O", "2H2 + O2 -> 2H2O" -> "H 2 O", "... yields ...". */
function chem(s: string): string {
  return s
    .replace(/<=>|<->/g, " is in equilibrium with ")
    .replace(/->/g, " yields ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/^([0-9]+)(?=[A-Z])|\s([0-9]+)(?=[A-Z])/g, (m) => `${m} `)
    .replace(/\^\{?([0-9]*[+-])\}?/g, " with charge $1 ")
    .replace(/([A-Za-z\)])([0-9]+)/g, "$1 $2 ")
    .replace(/[{}_^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const simple = (n: Node): boolean =>
  n.t === "sym" || n.t === "num" || n.t === "text" || (n.t === "seq" && n.items.length <= 1 && n.items.every(simple)) || (n.t === "script" && !!n.base && simple(n.base) && (!n.sup || simple(n.sup)) && !n.sub);
const isRel = (s: string) => ["=", "<", ">"].includes(s) || /^(le|leq|ge|geq|neq|ne|approx|equiv|sim|simeq|cong|propto|ll|gg|to|rightarrow|in|subset|subseteq|implies|Rightarrow|iff)$/.test(s);

function speak(n: Node, ctx: { paren?: boolean } = {}): string {
  switch (n.t) {
    case "num":
      return n.v;
    case "text":
      return n.say ?? (/^[()\[\]]$/.test(n.v.trim()) ? "" : n.v.trim());
    case "sym": {
      const v = n.v;
      if (GREEK.includes(v)) return v;
      if (v in CAP_GREEK) return `capital ${v.toLowerCase()}`;
      if ((v === "|" || v === "vert") && ctx.paren) return "given"; // P(A|B)
      if (v in SYM) return SYM[v][1];
      return OP[v] ?? v;
    }
    case "fn":
      if (n.name === "__choose") return "the binomial coefficient";
      if (n.name === "__choose2") return "choose";
      return FN[n.name] ?? n.name;
    case "big":
      return BIG[n.name][1];
    case "frac": {
      const a = speak(n.n);
      const b = speak(n.d);
      if (n.n.t === "sym" && n.n.v === "d" && /^d /.test(b)) return `d by ${b}`; // d/dx
      return simple(n.n) && simple(n.d) ? `${a} over ${b}` : `the fraction ${a}, over ${b}, end fraction`;
    }
    case "sqrt": {
      const x = speak(n.x);
      const root = !n.idx ? "the square root of" : speak(n.idx) === "3" ? "the cube root of" : `the ${speak(n.idx)}th root of`;
      return simple(n.x) ? `${root} ${x}` : `${root} ${x}, end root`;
    }
    case "accent": {
      const x = speak(n.x);
      return n.name === "vec" || n.name === "overrightarrow" ? `vector ${x}` : `${x} ${ACCENT[n.name][1]}`;
    }
    case "fence": {
      const inner = speak(n.body, { paren: true });
      if (n.open === "|" || n.open === "lvert" || n.open === "vert") return `the absolute value of ${inner}`;
      if (n.open === "lVert" || n.open === "Vert") return `the norm of ${inner}`;
      if (n.open === "lfloor") return `the floor of ${inner}`;
      if (n.open === "lceil") return `the ceiling of ${inner}`;
      if (n.open === "langle") return `the angle bracket ${inner}`;
      return simple(n.body) ? inner : `the quantity ${inner}`;
    }
    case "script": {
      if (n.base.t === "fence" && (!simple(n.base.body) || (n.base.open !== "(" && n.base.open !== "["))) {
        // (a+b)^2: "the quantity a plus b, squared"
        return `${speak(n.base)}, ${speak({ ...n, base: { t: "text", v: "" } })}`.replace(/,\s+$/, "");
      }
      const base = n.base;
      if (base.t === "big") {
        const lo = n.sub ? speak(n.sub) : "";
        const hi = n.sup ? speak(n.sup) : "";
        if (base.name === "lim") return `the limit as ${lo.replace(/ goes to /, " approaches ")} of`;
        if (/^(max|min|sup|inf|argmax|argmin)$/.test(base.name)) return `${BIG[base.name][1]} over ${lo} of`;
        return `${BIG[base.name][1]}${lo ? ` from ${lo}` : ""}${hi ? ` to ${hi}` : ""} of`;
      }
      let s = speak(base);
      if (n.sub) s += simple(n.sub) ? ` sub ${speak(n.sub)}` : ` sub ${speak(n.sub)}, end sub,`;
      if (n.sup) {
        const p = speak(n.sup);
        if (p === "2") s += " squared";
        else if (p === "3") s += " cubed";
        else if (p === "prime" || p === "′") s += " prime";
        else if (n.sup.t === "sym" && n.sup.v === "circ") s += " degrees";
        else if (p === "T" && base.t === "sym") s += " transpose";
        else s += simple(n.sup) ? ` to the power of ${p}` : ` to the power of ${p}, end power,`;
      }
      return s;
    }
    case "seq": {
      const out: string[] = [];
      const items = n.items;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        const nx = items[k + 1];
        // "-b" at the start or after a relation or an open paren reads "negative b"
        const prev = items[k - 1];
        if (it.t === "sym" && (it.v === "-" || it.v === "−") && (!prev || (prev.t === "sym" && (isRel(prev.v) || prev.v === "(" || prev.v === "pm")))) {
          out.push("negative");
          continue;
        }
        if (it.t === "fence" && (it.open === "(" || it.open === "[")) {
          const fnPrev = prev && ((prev.t === "sym" && /^[fghPEFGQVLp]$/.test(prev.v)) || prev.t === "fn" || prev.t === "text" || (prev.t === "script" && prev.base.t === "sym" && /^[fghFGP]$/.test(prev.base.v)));
          const inner = speak(it.body, { paren: true });
          out.push(fnPrev ? `of ${inner}${simple(it.body) || k + 1 === items.length ? "" : ","}` : speak(it, ctx) + (simple(it.body) || k + 1 === items.length ? "" : ","));
          continue;
        }
        if (it.t === "sym" && it.v === "d" && nx && (nx.t === "sym" || nx.t === "script") && prev && !(prev.t === "sym" && /^[a-zA-Z]$/.test(prev.v))) {
          out.push("d");
          continue;
        }
        out.push(speak(it, ctx));
      }
      return out.filter(Boolean).join(" ");
    }
  }
}

function show(n: Node): string {
  switch (n.t) {
    case "num":
      return n.v;
    case "text":
      return n.v;
    case "sym": {
      const v = n.v;
      const g = GREEK.indexOf(v);
      if (g >= 0) return GREEK_CH[g];
      if (v in CAP_GREEK) return CAP_GREEK[v];
      if (v in SYM) return SYM[v][0];
      return v === "-" ? "−" : v;
    }
    case "fn":
      return n.name === "__choose" ? "C(" : n.name === "__choose2" ? ", " : n.name;
    case "big":
      return BIG[n.name][0];
    case "frac": {
      const w = (x: Node) => (simple(x) ? show(x) : `(${show(x)})`);
      return `${w(n.n)}/${w(n.d)}`;
    }
    case "sqrt":
      return `${n.idx ? (show(n.idx) === "3" ? "∛" : show(n.idx)) : "√"}${simple(n.x) ? show(n.x) : `(${show(n.x)})`}`;
    case "accent":
      return show(n.x) + ACCENT[n.name][0];
    case "fence": {
      const o: Record<string, string> = { lvert: "|", vert: "|", lVert: "‖", Vert: "‖", lfloor: "⌊", lceil: "⌈", langle: "⟨", ".": "", "{": "{", lbrace: "{" };
      const c: Record<string, string> = { rvert: "|", vert: "|", rVert: "‖", Vert: "‖", rfloor: "⌋", rceil: "⌉", rangle: "⟩", ".": "", "}": "}", rbrace: "}" };
      return `${o[n.open] ?? n.open}${show(n.body)}${c[n.close] ?? n.close}`;
    }
    case "script": {
      const sup: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", i: "ⁱ" };
      const sub: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋" };
      const conv = (x: Node, map: Record<string, string>, mark: string) => {
        const s = show(x);
        return [...s].every((ch) => ch in map) ? [...s].map((ch) => map[ch]).join("") : `${mark}${s.length > 1 ? `(${s})` : s}`;
      };
      let s = show(n.base);
      if (n.sub) s += conv(n.sub, sub, "_");
      if (n.sup) s += n.sup.t === "sym" && n.sup.v === "prime" ? "′" : conv(n.sup, sup, "^");
      return s;
    }
    case "seq": {
      let s = "";
      // "1/2x²" would read as 1/(2x²): a fraction beside another factor is bracketed, "(1/2)x²"
      const glue = (x?: Node) => !!x && (x.t === "num" || x.t === "script" || x.t === "fence" || x.t === "accent" || x.t === "sqrt" || x.t === "frac" || (x.t === "sym" && /^[A-Za-z]+$/.test(x.v) && !(x.v in SYM)));
      n.items.forEach((it, k) => {
        const p = it.t === "frac" && (glue(n.items[k - 1]) || glue(n.items[k + 1])) ? `(${show(it)})` : show(it);
        const rel = it.t === "sym" && (isRel(it.v) || it.v === "+" || it.v === "-" || it.v === "pm" || it.v === "times" || it.v === "cdot");
        s += rel ? ` ${p} ` : it.t === "fn" || it.t === "big" || (it.t === "script" && it.base.t === "big") ? `${p} ` : p;
      });
      return s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
    }
  }
}

export type Math = { text: string; say: string; ok: boolean };

/** One formula in LaTeX. Unknown commands keep `ok` false so the caller can flag the block. */
export function texToSpeech(tex: string): Math {
  const src = tex
    .replace(/^\s*\{\\displaystyle\s*([\s\S]*)\}\s*$/, "$1")
    .replace(/\\(?:displaystyle|textstyle)\b/g, "")
    .replace(/\\[,;:!> ]/g, " ")
    .trim()
    .replace(/[,.]$/, "");
  const p = new Parser(src);
  const tree = p.seq();
  const say = speak(tree)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/,(\s*,)+/g, ",")
    .replace(/,\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text: show(tree), say, ok: p.ok && !!say };
}

// MathML -> LaTeX, for <math> without alttext or a TeX annotation. Covers the elements MathJax and MediaWiki emit.
const MO: Record<string, string> = { "−": "-", "±": "\\pm", "∓": "\\mp", "×": "\\times", "⋅": "\\cdot", "·": "\\cdot", "≤": "\\le", "≥": "\\ge", "≠": "\\neq", "≈": "\\approx", "→": "\\to", "∈": "\\in", "∞": "\\infty", "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∂": "\\partial", "∣": "\\mid", "′": "'", "⁡": "", "⁢": "", "⁣": "", "⁤": "" };
const MI_GREEK = new Map([...GREEK_CH].map((ch, i) => [ch, `\\${GREEK[i]} `]));
for (const [k, v] of Object.entries(CAP_GREEK)) MI_GREEK.set(v, `\\${k} `);

export function mathmlToTex(el: AnyNode): string {
  const kids = (e: Element) => e.children.filter((c) => c.type === "tag") as Element[];
  const txt = (e: AnyNode): string => (e.type === "text" ? (e as unknown as { data: string }).data : "children" in e ? (e as Element).children.map(txt).join("") : "");
  const go = (e: Element): string => {
    const k = kids(e);
    const g = (i: number) => (k[i] ? `{${go(k[i])}}` : "{}");
    switch (e.tagName.toLowerCase()) {
      case "mfrac":
        return `\\frac${g(0)}${g(1)}`;
      case "msup":
        return `${g(0)}^${g(1)}`;
      case "msub":
        return `${g(0)}_${g(1)}`;
      case "msubsup":
        return `${g(0)}_${g(1)}^${g(2)}`;
      case "munderover":
        return `${g(0)}_${g(1)}^${g(2)}`;
      case "munder":
        return `${g(0)}_${g(1)}`;
      case "mover": {
        const acc = txt(k[1] ?? e).trim();
        if (acc === "¯" || acc === "‾" || acc === "_") return `\\bar${g(0)}`;
        if (acc === "^" || acc === "ˆ") return `\\hat${g(0)}`;
        if (acc === "→" || acc === "⃗") return `\\vec${g(0)}`;
        if (acc === "˙" || acc === ".") return `\\dot${g(0)}`;
        if (acc === "~" || acc === "˜") return `\\tilde${g(0)}`;
        return `${g(0)}^${g(1)}`;
      }
      case "msqrt":
        return `\\sqrt{${k.map(go).join("")}}`;
      case "mroot":
        return `\\sqrt[${go(k[1])}]{${go(k[0])}}`;
      case "mi": {
        const s = txt(e).trim();
        if (MI_GREEK.has(s)) return MI_GREEK.get(s)!;
        if (s.length > 1 && /^[a-z]+$/.test(s) && s in FN) return `\\${s} `;
        return s.length > 1 ? `\\text{${s}}` : s;
      }
      case "mn":
        return txt(e).trim();
      case "mo": {
        const s = txt(e).trim();
        return s in MO ? MO[s] + " " : MI_GREEK.get(s) ?? s;
      }
      case "mtext":
        return `\\text{${txt(e)}}`;
      case "mspace":
        return " ";
      case "annotation":
      case "annotation-xml":
        return "";
      case "mtable":
        return `\\begin{matrix}${k.map(go).join(" \\\\ ")}\\end{matrix}`;
      case "mtr":
      case "mlabeledtr":
        return k.map(go).join(" & ");
      case "semantics":
        return k[0] ? go(k[0]) : "";
      case "mfenced":
        return `\\left${e.attribs.open ?? "("}${k.map(go).join(",")}\\right${e.attribs.close ?? ")"}`;
      default:
        return k.length ? k.map(go).join("") : txt(e).trim();
    }
  };
  return go(el as Element).replace(/\s+/g, " ").trim();
}
