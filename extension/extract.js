// Arc's page reader, run inside the student's own tab (so their sign-in applies). One file, three callers:
// the extension (chrome.scripting, background.js), the no-install bookmarklet (scripts/bookmarklet.mjs inlines it), and the
// checks (Playwright injects it: scripts/checks/extract-live.mjs). Defines globalThis.__arcExtract() and __arcFrame().
// It only reads: GET requests to the page's own site, never a POST, never a click. What it returns goes to Arc's /api/ingest,
// which validates and sanitises it again (lib/server/ingest.ts). Nothing here is trusted by the server.
(() => {
  if (globalThis.__arcExtract) return;
  // Caps, so one page cannot send a mountain: images by count and size, links, caption cues, the PDF.
  const CAP = { images: 40, imageBytes: 1_500_000, imageTotal: 8_000_000, side: 1600, links: 40, cues: 3000, pdf: 25 * 1024 * 1024, html: 3_500_000, frames: 10 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const abs = (u, base) => {
    if (!u) return null;
    try {
      const x = new URL(u, base);
      return /^https?:$/.test(x.protocol) ? x.href : null;
    } catch {
      return null;
    }
  };
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "another site";
    }
  };

  /** Document complete, then a quiet spell with no DOM changes and no loading sign (learning systems render late, often after a
   * second or more of "Loading"). At most `max` ms. */
  const busy = (doc) => !!doc.querySelector("[aria-busy='true'],.loading-spinner,.spinner:not([hidden])") || /^\s*(loading|please wait)\b/i.test((doc.body?.innerText ?? "").slice(0, 400).replace(/^[\s\S]*?\n(?=\s*loading)/i, "")) || (doc.body?.innerText ?? "").trim().length < 40;
  async function settle(doc = document, quiet = 1200, max = 8000) {
    const t0 = Date.now();
    while (doc.readyState !== "complete" && Date.now() - t0 < max) await sleep(100);
    let last = Date.now();
    const mo = new MutationObserver(() => (last = Date.now()));
    mo.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
    while ((Date.now() - last < quiet || busy(doc)) && Date.now() - t0 < max) await sleep(100);
    mo.disconnect();
  }

  // ---------- links: the page's own next and previous controls, and its module or contents list ----------
  const NEXT = /^(next|next page|next item|next activity|next module|next lesson|continue)\b|^[›»→]$/i;
  const PREV = /^(prev|previous|previous page|previous item|previous activity|previous module|previous lesson|back)\b|^[‹«←]$/i;
  const NAV_BOX = "#context_modules,#section-tabs,#courseindex,.courseindex,[data-region='courseindex'],.toc,#toc,[aria-label*='contents' i],[aria-label*='course navigation' i],[aria-label*='modules' i],nav,[role='navigation']";
  const SKIP = /log ?out|sign ?out|log ?in|sign ?in|account|profile|settings|inbox|conversations|messages|notifications|grades|people|users|calendar|help|dashboard|search|skip to|privacy|cookie|accessibility|preferences|switch role/i;
  function findLinks(doc, base) {
    const here = abs(base, base);
    const site = (() => {
      try {
        return new URL(base).host;
      } catch {
        return "";
      }
    })();
    const out = [];
    const seen = new Set([here]);
    const add = (label, href, rel) => {
      const url = abs(href, base);
      label = squash(label).slice(0, 80);
      if (!url || !label || url.split("#")[0] === here?.split("#")[0]) return;
      if (new URL(url).host !== site) return; // course navigation stays on the course site
      if (seen.has(url)) {
        if (rel) for (const l of out) if (l.url === url && !l.rel) l.rel = rel;
        return;
      }
      seen.add(url);
      out.push(rel ? { label, url, rel } : { label, url });
    };
    const label = (a) => a.getAttribute("aria-label") || a.getAttribute("title") || a.textContent;
    for (const l of doc.querySelectorAll("link[rel~='next'][href],a[rel~='next'][href]")) add(l.textContent || "Next page", l.getAttribute("href"), "next");
    for (const l of doc.querySelectorAll("link[rel~='prev'][href],link[rel~='previous'][href],a[rel~='prev'][href]")) add(l.textContent || "Previous page", l.getAttribute("href"), "prev");
    // Canvas: .module-sequence-footer-button--next / --previous; Moodle 4: #next-activity-link / #prev-activity-link; others by their words.
    for (const a of doc.querySelectorAll("a[href]")) {
      const words = squash(label(a));
      const cls = `${a.id} ${a.className} ${a.parentElement?.className ?? ""}`;
      if (/next-activity|--next\b|sequence-next|next-button|btn-next|\bnext\b/i.test(cls) || NEXT.test(words)) add(words || "Next page", a.getAttribute("href"), "next");
      else if (/prev-activity|--previous\b|sequence-prev|prev-button|btn-prev|\bprev(ious)?\b/i.test(cls) || PREV.test(words)) add(words || "Previous page", a.getAttribute("href"), "prev");
    }
    // Most specific lists first (a course's modules or index), the site's general menus last; language menus never.
    for (const sel of NAV_BOX.split(",")) for (const box of doc.querySelectorAll(sel)) {
      if (box.closest("[aria-label*='language' i],.langmenu,#lang-menu,[data-region='language']")) continue;
      for (const a of box.querySelectorAll("a[href]")) {
        if (out.length >= CAP.links) return out;
        const words = squash(label(a));
        const href = a.getAttribute("href") ?? "";
        if (words.length < 2 || SKIP.test(words) || SKIP.test(href) || /^#/.test(href) || /[?&]lang=/.test(href) || a.hasAttribute("hreflang") || /\u200e?\([a-z]{2,3}(_[a-z]{2})?\)\u200e?$/i.test(words)) continue;
        add(words, href);
      }
    }
    return out.slice(0, CAP.links);
  }

  // ---------- pictures: fetched with the student's session, downscaled, sent as data ----------
  const DECOR = /avatar|icon|logo|emoji|emoticon|gravatar|profile|spinner|loading|badge|sprite|tracking|pixel|beacon|spacer|blank\.gif|transparent/i;
  async function decode(blob) {
    try {
      return await createImageBitmap(blob);
    } catch {
      // SVG and a few others: through an <img> made from the blob (same origin: the canvas stays readable)
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } catch {
        return null;
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }
  function encode(pic) {
    const w = pic.naturalWidth || pic.width, h = pic.naturalHeight || pic.height;
    if (!w || !h) return null;
    const k = Math.min(1, CAP.side / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; // transparent PNGs keep a white page behind them
    g.fillRect(0, 0, c.width, c.height);
    try {
      g.drawImage(pic, 0, 0, c.width, c.height);
      for (let q = 0.85; q >= 0.4; q -= 0.15) {
        const data = c.toDataURL("image/jpeg", q); // throws on a cross-site picture that the canvas may not read
        if (data.length * 0.75 <= CAP.imageBytes) return { data, w, h };
      }
    } catch {
      return null;
    }
    return null;
  }
  // Canvas content pictures (/courses/N/files/N/preview) redirect to a file host the page may not read; the file's own API
  // object (data-api-endpoint, same site) names a download URL that is readable. Measured on a real Canvas, November 2026.
  async function fileUrl(el, base) {
    const ep = abs(el.getAttribute("data-api-endpoint"), base);
    if (!ep || new URL(ep).origin !== new URL(base).origin || !/\/api\/v1\/(?:courses\/\d+\/)?files\/\d+/.test(ep)) return null;
    try {
      const r = await fetch(ep, { credentials: "same-origin", headers: { accept: "application/json" } });
      const d = JSON.parse((await r.text()).replace(/^while\(1\);/, ""));
      return abs(d?.url, base);
    } catch {
      return null;
    }
  }
  async function grab(src, live, el, base) {
    const viaApi = el && (await fileUrl(el, base));
    if (viaApi) src = viaApi;
    try {
      const r = await fetch(src, { credentials: "include" });
      if (r.ok && /^image\//i.test(r.headers.get("content-type") ?? "")) {
        const pic = await decode(await r.blob());
        if (pic) return encode(pic);
      }
    } catch {
      // cross-site without CORS: try the picture the page already shows
    }
    if (live?.complete && live.naturalWidth) return encode(live);
    return null;
  }

  // ---------- one document (the live page, a same-site frame, or Canvas API HTML) -> clean HTML plus findings ----------
  const MEDIA = /kaltura|panopto|instructuremedia|arc\.instructure|vimeo|brightcove|wistia|vidgrid|yuja|mediasite|echo360|warpwire|vidyard/i;
  const YT = /(?:youtube(?:-nocookie)?\.com\/embed\/|youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/;
  const LINES = {
    video: (t, h) => `A video from ${h} is here${t ? `: ${t}` : ""}. Arc cannot play it, and it has no captions Arc can reach.`,
    frame: (t, h) => `Something from ${h} is embedded here${t ? `: ${t}` : ""}. Arc cannot read it from this page.`,
    nocap: (t) => `A video is here${t ? `: ${t}` : ""}. It has no captions Arc can reach, so Arc cannot read it.`,
  };
  /** Cues of a WebVTT or SRT caption file: [{t: seconds, text}]. */
  function cuesOf(text) {
    const cues = [];
    for (const blk of String(text).replace(/\r/g, "").split(/\n\n+/)) {
      const m = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,]\d{3}\s+-->/.exec(blk);
      if (!m) continue;
      const lines = blk.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      const words = squash(lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, ""));
      if (words) cues.push({ t: (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]), text: words.slice(0, 500) });
      if (cues.length >= CAP.cues) break;
    }
    return cues;
  }

  /** Works on `root` (a detached clone or parsed document body) in place. `live(el)` gives the on-page element for a clone, when there is one. */
  async function capture(root, base, live, found, budget) {
    const doc = root.ownerDocument;
    // Canvas equations: <img class="equation_image" data-equation-content="LaTeX"> -> <math alttext> (lib/parse/html.ts reads alttext).
    for (const img of root.querySelectorAll("img.equation_image,img[data-equation-content]")) {
      const tex = img.getAttribute("data-equation-content") || (img.getAttribute("alt") ?? "").replace(/^LaTeX:\s*/i, "");
      if (!tex.trim()) continue;
      const m = doc.createElement("math");
      m.setAttribute("alttext", tex);
      if (img.closest("p") && squash(img.closest("p").textContent) === "") m.setAttribute("display", "block");
      img.replaceWith(m);
    }
    for (const el of root.querySelectorAll("script,style,noscript,template,link[rel='stylesheet'],base,meta[http-equiv]")) el.remove();
    // Frames: same-site ones inline (by the caller); YouTube becomes an Arc video; other media and tools leave one honest line.
    let fn = 0;
    for (const f of root.querySelectorAll("iframe,frame")) {
      const on = live?.(f);
      const src = abs(f.getAttribute("src") || on?.src, base);
      const title = squash(f.getAttribute("title") || f.getAttribute("aria-label") || on?.title || "").slice(0, 120);
      const yt = src && YT.exec(src);
      if (yt) {
        found.youtube.push({ id: yt[1], title });
        f.replaceWith(Object.assign(doc.createElement("p"), { textContent: `A YouTube video is here${title ? `: ${title}` : ""}. Arc can open it as a video.` }));
        continue;
      }
      let inner = null;
      try {
        inner = on?.contentDocument?.body ? on.contentDocument : null; // same-site: readable from here
      } catch {
        inner = null;
      }
      if (inner && found.depth < 2) {
        const sub = await page(inner, abs(inner.location?.href, base) || base, { ...found, depth: found.depth + 1 }, budget);
        const div = doc.createElement("div");
        div.innerHTML = sub;
        f.replaceWith(div);
        continue;
      }
      if (!src) {
        f.remove();
        continue;
      }
      const n = fn++;
      const box = doc.createElement("div");
      box.setAttribute("data-arc-frame", String(n));
      box.appendChild(Object.assign(doc.createElement("p"), { textContent: MEDIA.test(src) ? LINES.video(title, host(src)) : LINES.frame(title, host(src)) }));
      f.replaceWith(box);
      if (found.frames.length < CAP.frames) found.frames.push({ n, src, title });
    }
    // HTML5 video: caption tracks become a transcript (the server builds it); the media itself is never captured.
    for (const v of root.querySelectorAll("video")) {
      const on = live?.(v) ?? v;
      const title = squash(v.getAttribute("title") || v.getAttribute("aria-label") || "").slice(0, 120);
      const tracks = [...v.querySelectorAll("track[src]")].filter((t) => /^(captions|subtitles|)$/i.test(t.getAttribute("kind") ?? ""));
      let cues = [];
      for (const t of tracks) {
        const src = abs(t.getAttribute("src"), base);
        if (!src) continue;
        try {
          const r = await fetch(src, { credentials: "include" });
          if (r.ok) cues = cuesOf(await r.text());
        } catch {
          // unreachable: the honest line below
        }
        if (cues.length) break;
      }
      void on;
      if (cues.length) {
        const n = found.videos.length;
        found.videos.push({ n, title, cues });
        const box = doc.createElement("div");
        box.setAttribute("data-arc-video", String(n));
        v.replaceWith(box);
      } else v.replaceWith(Object.assign(doc.createElement("p"), { textContent: LINES.nocap(title) }));
    }
    for (const a of root.querySelectorAll("audio,object,embed,canvas")) a.remove();
    // Every attribute that holds an address: absolute, http(s) only. Event handlers and inline styles go.
    for (const el of root.querySelectorAll("*")) {
      for (const at of [...el.attributes]) {
        const k = at.name.toLowerCase();
        if (k.startsWith("on") || k === "style" || k === "srcdoc" || k === "formaction" || k === "action") el.removeAttribute(at.name);
        else if (k === "src" && /^arc-image:\d+$/.test(at.value)) continue; // a picture already captured (a same-site frame's)
        else if (k === "href" || k === "src" || k === "poster" || k === "xlink:href" || k === "data-src" || k === "cite") {
          const u = abs(at.value, base);
          if (u) el.setAttribute(at.name, u);
          else el.removeAttribute(at.name);
        } else if (k === "srcset" || k === "data-srcset") el.removeAttribute(at.name);
      }
    }
    // Pictures, in page order, until the caps run out. Decorative ones (icons, avatars, tiny, tracking) are skipped.
    for (const img of root.querySelectorAll("img")) {
      if (/^arc-image:/.test(img.getAttribute("src") ?? "")) continue;
      const on = live?.(img);
      const src = abs(on?.currentSrc || img.getAttribute("data-src") || img.getAttribute("src"), base);
      const words = `${img.className} ${img.getAttribute("alt") ?? ""} ${src ?? ""}`;
      const w = on?.naturalWidth || Number(img.getAttribute("width")) || 0, h = on?.naturalHeight || Number(img.getAttribute("height")) || 0;
      if (!src || DECOR.test(words) || (w && w < 48) || (h && h < 48) || img.getAttribute("role") === "presentation") {
        img.remove();
        continue;
      }
      if (budget.count >= CAP.images || budget.bytes >= CAP.imageTotal) continue; // left as a link: the student's browser may still show it
      const got = await grab(src, on, img, base);
      if (!got || got.w < 48 || got.h < 48) continue;
      const bytes = got.data.length * 0.75;
      if (budget.bytes + bytes > CAP.imageTotal) continue;
      budget.count++;
      budget.bytes += bytes;
      // The bytes travel beside the HTML, not inside it; the server swaps the placeholder for its own short-lived address.
      const k = budget.images.push(got.data) - 1;
      img.setAttribute("src", `arc-image:${k}`);
      img.setAttribute("width", String(got.w));
      img.setAttribute("height", String(got.h));
      for (const a of ["data-src", "data-lazy-src", "data-original", "data-full-src", "data-hi-res-src", "loading", "decoding", "data-api-endpoint"]) img.removeAttribute(a);
    }
  }

  /** A live document -> clean HTML: hidden parts out (display none, visibility hidden), then capture(). */
  async function page(doc, base, found, budget) {
    const real = [doc.documentElement, ...doc.documentElement.querySelectorAll("*")];
    const clone = doc.documentElement.cloneNode(true);
    const copy = [clone, ...clone.querySelectorAll("*")];
    const pair = new Map();
    const view = doc.defaultView;
    const hidden = [];
    for (let i = 0; i < real.length; i++) {
      pair.set(copy[i], real[i]);
      const el = real[i];
      if (el.closest("head") || el.closest("math") || !view) continue; // MathML is often display:none beside a picture
      const cs = view.getComputedStyle(el);
      if ((cs.display === "none" || cs.visibility === "hidden") && !el.querySelector("math")) hidden.push(copy[i]);
    }
    for (const el of hidden) el.remove();
    const body = clone.querySelector("body") ?? clone;
    await capture(clone, base, (el) => pair.get(el), found, budget);
    return found.depth ? body.innerHTML : clone.outerHTML;
  }

  // ---------- linked or embedded files: a PDF goes to Arc's PDF reader; other documents get one line ----------
  const DOC_TYPES = { doc: "a Word document", docx: "a Word document", ppt: "a slide deck", pptx: "a slide deck", xls: "a spreadsheet", xlsx: "a spreadsheet", odt: "a document", key: "a slide deck", pages: "a document" };
  function mainFile(doc, base) {
    if (doc.contentType === "application/pdf") return { kind: "pdf", url: base };
    const text = squash(doc.body?.innerText ?? doc.body?.textContent ?? "").length;
    const emb = doc.querySelector("embed[type='application/pdf'],object[type='application/pdf'],iframe[src*='.pdf' i],embed[src*='.pdf' i],object[data*='.pdf' i]");
    const embUrl = emb && abs(emb.getAttribute("src") || emb.getAttribute("data"), base);
    if (embUrl && text < 1500) return { kind: "pdf", url: embUrl };
    if (text >= 1500) return null; // the page itself is the reading
    const links = [...doc.querySelectorAll("a[href]")].map((a) => ({ a, url: abs(a.getAttribute("href"), base) })).filter((x) => x.url);
    const pdfs = links.filter((x) => /\.pdf(?:$|[?#])/i.test(x.url) || /\.pdf\b/i.test(x.a.textContent) || (/\/download\b/.test(x.url) && /download/i.test(x.a.textContent + (x.a.getAttribute("aria-label") ?? ""))));
    if (pdfs.length === 1 || (pdfs.length > 1 && new Set(pdfs.map((x) => x.url.split("?")[0])).size === 1)) return { kind: "pdf", url: pdfs[0].url };
    const other = links.find((x) => /\.(docx?|pptx?|xlsx?|odt|key|pages)(?:$|[?#])/i.exec(x.url));
    if (other) return { kind: "other", url: other.url, type: DOC_TYPES[/\.(\w+)(?:$|[?#])/.exec(other.url)[1].toLowerCase()] ?? "a file" };
    return null;
  }
  async function pdfBytes(url) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return { error: "fetch" };
      const len = Number(r.headers.get("content-length")) || 0;
      if (len > CAP.pdf) return { error: "big" };
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > CAP.pdf) return { error: "big" };
      if (String.fromCharCode(...buf.slice(0, 5)) !== "%PDF-") return { error: "notpdf" };
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { data: btoa(bin), size: buf.length };
    } catch {
      return { error: "fetch" };
    }
  }
  const PDF_LINES = {
    fetch: "This page shows a PDF that Arc could not download from here. Use its download link, then open the file in Arc.",
    big: "This PDF is larger than 25 megabytes, which is more than the Arc helper can carry. Download it, then open the file in Arc.",
    notpdf: "This page links to a file that is not really a PDF, so Arc cannot read it.",
  };

  // ---------- Canvas, through its own read-only REST API (same site, the student's session). GET only. ----------
  const CANVAS = /^\/courses\/(\d+)(?:\/([a-z_]+)(?:\/([^/?#]+))?(?:\/([^/?#]+))?)?\/?$/;
  const OFF_LIMITS = /^(grades|users|gradebook|groups|collaborations|conferences|outcomes|settings|analytics|submissions)$/; // other people's information, not study material
  const LINE = {
    off: "Arc does not read grades, class lists, messages or submissions. They hold other people's information, and they are not study material.",
    quiz: "This is a quiz. Arc reads you its instructions here, but it will not start a quiz. When you start it yourself, press the Arc shortcut on the quiz page, and Arc will read the questions to you.",
    tool: "This part of the course runs in another tool inside Canvas. Arc cannot read it from here.",
    file: (what, name) => `This is ${what}${name ? `, ${name}` : ""}. Arc reads web pages and PDFs; download it and open it in its own program.`,
    list: "Open one announcement or discussion, and Arc will read its message. Arc does not read replies: they are other people's posts.",
  };
  async function api(path, trace) {
    const shape = path.replace(/\/\d+/g, "/N").replace(/\/pages\/[^/?&]+/, "/pages/X").replace(/asset_id=[^&]+/, "asset_id=X"); // no ids or slugs
    try {
      const r = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
      const text = await r.text();
      let data = null;
      try {
        data = JSON.parse(text.replace(/^while\(1\);/, "")); // Canvas guards session JSON with this prefix
      } catch {
        data = null;
      }
      // Field names only (never values): the structure-only probe reads them (scripts/bookmarklet.mjs --probe).
      const fields = Array.isArray(data) ? [`array of ${data.length}`] : data && typeof data === "object" ? Object.keys(data).slice(0, 60) : [];
      trace.push({ endpoint: shape, status: r.status, json: data !== null, fields });
      return { ok: r.ok && data !== null, status: r.status, data };
    } catch {
      trace.push({ endpoint: shape, status: 0, json: false });
      return { ok: false, status: 0, data: null };
    }
  }
  /** Null when this is not a Canvas course address or Canvas does not answer: the caller reads the rendered page instead. */
  async function canvas(href, trace = []) {
    const u = new URL(href);
    const m = CANVAS.exec(u.pathname);
    if (!m) return null;
    const [, cid, kind = "", a = "", b = ""] = m;
    if (kind === "quizzes" && b === "take") return null; // a quiz being taken: the open tab's own page, never the API
    if (OFF_LIMITS.test(kind)) return { trace, title: "", body: "", line: LINE.off };
    const course = await api(`/api/v1/courses/${cid}`, trace); // the cheap probe: Canvas answers JSON, anything else does not
    if (!course.ok || typeof course.data?.id === "undefined") return null;
    const C = `/api/v1/courses/${cid}`;
    const out = { trace, title: "", body: "", line: "", pdfUrl: null, links: [], course: squash(course.data.name) };
    let asset = null;
    if (!kind || kind === "wiki" || (kind === "pages" && !a)) {
      const r = await api(`${C}/front_page`, trace);
      if (r.ok) Object.assign(out, { title: r.data.title, body: r.data.body ?? "" });
      else if (kind === "pages") return null;
      else return modulesPage(C, out, trace);
    } else if (kind === "pages") {
      const r = await api(`${C}/pages/${encodeURIComponent(decodeURIComponent(a))}`, trace);
      if (!r.ok) return null;
      Object.assign(out, { title: r.data.title, body: r.data.body ?? "" });
      asset = ["Page", r.data.url ?? a];
    } else if (kind === "assignments" && a === "syllabus") {
      const r = await api(`${C}?include[]=syllabus_body`, trace);
      if (!r.ok) return null;
      Object.assign(out, { title: `Syllabus: ${squash(r.data.name)}`, body: r.data.syllabus_body ?? "" });
    } else if (kind === "assignments" && /^\d+$/.test(a)) {
      const r = await api(`${C}/assignments/${a}`, trace);
      if (!r.ok) return null;
      const d = r.data;
      Object.assign(out, { title: d.name, body: `<p>${esc(assignmentFacts(d))}</p>${d.description ?? ""}` });
      if ((d.submission_types ?? []).includes("external_tool")) out.line = LINE.tool;
      asset = ["Assignment", a];
    } else if (kind === "files" && /^\d+$/.test(a)) {
      const r = await api(`${C}/files/${a}`, trace);
      if (!r.ok) return null;
      const d = r.data;
      out.title = d.display_name ?? "File";
      if (/pdf/i.test(d["content-type"] ?? "") || /\.pdf$/i.test(d.display_name ?? "")) out.pdfUrl = d.url;
      else out.line = LINE.file(DOC_TYPES[/\.(\w+)$/.exec(d.display_name ?? "")?.[1]?.toLowerCase() ?? ""] ?? `a ${d.mime_class || "file"}`, d.display_name);
      asset = ["File", a];
    } else if (kind === "quizzes" && /^\d+$/.test(a) && !b) {
      const r = await api(`${C}/quizzes/${a}`, trace);
      if (!r.ok) return null;
      Object.assign(out, { title: r.data.title, body: r.data.description ?? "", line: LINE.quiz });
      asset = ["Quiz", a];
    } else if ((kind === "discussion_topics" || kind === "announcements") && /^\d+$/.test(a)) {
      const r = await api(`${C}/discussion_topics/${a}`, trace); // the topic's own message; never its replies
      if (!r.ok) return null;
      Object.assign(out, { title: r.data.title, body: r.data.message ?? "" });
      asset = ["Discussion", a];
    } else if (kind === "discussion_topics" || kind === "announcements") {
      return Object.assign(out, { title: kind === "announcements" ? "Announcements" : "Discussions", line: LINE.list });
    } else if (kind === "modules" && !a) {
      return modulesPage(C, out, trace);
    } else if (kind === "external_tools") {
      return Object.assign(out, { line: LINE.tool });
    } else return null; // lists and other pages: the rendered page is fine
    const item = u.searchParams.get("module_item_id");
    if (asset || item) {
      const q = item ? `asset_type=ModuleItem&asset_id=${encodeURIComponent(item)}` : `asset_type=${asset[0]}&asset_id=${encodeURIComponent(asset[1])}`;
      const s = await api(`${C}/module_item_sequence?${q}`, trace);
      const it = s.ok ? (s.data.items ?? [])[0] : null;
      if (it?.prev?.html_url) out.links.push({ label: it.prev.title || "Previous page", url: it.prev.html_url, rel: "prev" });
      if (it?.next?.html_url) out.links.push({ label: it.next.title || "Next page", url: it.next.html_url, rel: "next" });
    }
    await moduleLinks(C, out, trace);
    return out;
  }
  // The facts as full sentences in their own first paragraph, in the student's local time, so the reader and the answers both use them.
  const HAND_IN = { online_upload: "uploading a file on Canvas", online_text_entry: "typing your answer into Canvas", online_url: "sending a web address on Canvas", media_recording: "recording audio or video on Canvas", online_quiz: "taking the quiz on Canvas", discussion_topic: "posting in the discussion on Canvas", external_tool: "using another tool inside Canvas", on_paper: "handing it in on paper", none: "" };
  function assignmentFacts(d) {
    const s = [];
    if (d.due_at) {
      const t = new Date(d.due_at);
      s.push(`This assignment is due ${t.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, at ${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`);
    } else s.push("This assignment has no due date.");
    if (typeof d.points_possible === "number") s.push(`It is worth ${d.points_possible} ${d.points_possible === 1 ? "point" : "points"}.`);
    const ways = (d.submission_types ?? []).map((k) => HAND_IN[k]).filter(Boolean);
    if (ways.length) s.push(`Hand it in by ${ways.join(", or by ")}.`);
    else if ((d.submission_types ?? []).includes("none")) s.push("Nothing is handed in on Canvas for this assignment.");
    if (d.locked_for_user) s.push("It is locked for you right now.");
    return s.join(" ");
  }
  async function moduleLinks(C, out, trace) {
    const r = await api(`${C}/modules?include[]=items&per_page=20`, trace); // one page: never the whole course
    if (!r.ok || !Array.isArray(r.data)) return [];
    for (const mod of r.data) for (const it of mod.items ?? []) {
      if (out.links.length >= CAP.links) break;
      if (it.type === "SubHeader" || !it.html_url || out.links.some((l) => l.url === it.html_url)) continue;
      out.links.push({ label: squash(it.title).slice(0, 80) || it.type, url: it.html_url });
    }
    return r.data;
  }
  async function modulesPage(C, out, trace) {
    const mods = await moduleLinks(C, out, trace);
    out.title = out.title || `Modules: ${out.course}`;
    out.body = mods
      .map((mod) => `<h2>${esc(mod.name)}</h2><ul>${(mod.items ?? []).map((it) => (it.type === "SubHeader" ? `<li><strong>${esc(it.title)}</strong></li>` : `<li><a href="${esc(it.html_url ?? "")}">${esc(it.title)}</a> (${esc(it.type)})</li>`)).join("")}</ul>`)
      .join("");
    return out;
  }

  /** The whole read. Returns the payload /api/ingest takes. */
  globalThis.__arcExtract = async function arcExtract(opts = {}) {
    const doc = opts.doc ?? document;
    const base = doc.location?.href ?? opts.url;
    if (!opts.noSettle) await settle(doc);
    const found = { frames: [], videos: [], youtube: [], depth: 0 };
    const budget = { count: 0, bytes: 0, images: [] };
    const lines = [];
    const out = { v: 1, url: base, title: squash(doc.title).slice(0, 300), lang: doc.documentElement.lang || undefined };
    // Canvas first, by its URL shape plus a same-site API probe; the rendered page when that fails.
    const cv = opts.canvas === false ? null : await canvas(base).catch(() => null);
    if (cv) {
      out.via = "canvas-api";
      out.trace = cv.trace;
      if (cv.title) out.title = squash(cv.title).slice(0, 300);
      if (cv.line) lines.push(cv.line);
      if (cv.pdfUrl) {
        const got = await pdfBytes(cv.pdfUrl);
        if (got.data) return { ...out, pdf: { name: out.title, data: got.data }, links: cv.links, lines };
        lines.push(PDF_LINES[got.error]);
      }
      const parsed = new DOMParser().parseFromString(`<!doctype html><html><head><title>${esc(out.title)}</title></head><body><main><h1>${esc(out.title)}</h1>${cv.body}</main></body></html>`, "text/html");
      await capture(parsed.documentElement, base, null, found, budget);
      return { ...out, html: parsed.documentElement.outerHTML.slice(0, CAP.html), images: budget.images, links: cv.links, frames: found.frames, videos: found.videos, youtube: found.youtube, lines };
    }
    const file = mainFile(doc, base);
    if (file?.kind === "pdf") {
      const got = await pdfBytes(file.url);
      if (got.data) return { ...out, pdf: { name: out.title || decodeURIComponent(file.url.split(/[?#]/)[0].split("/").pop() || ""), data: got.data }, links: findLinks(doc, base), lines };
      lines.push(PDF_LINES[got.error]);
    } else if (file?.kind === "other") lines.push(`This page mainly offers ${file.type}. Arc reads web pages and PDFs; download it and open it in its own program.`);
    const links = findLinks(doc, base);
    const html = doc.contentType === "application/pdf" ? "" : await page(doc, base, found, budget);
    return { ...out, html: html.slice(0, CAP.html), images: budget.images, links, frames: found.frames, videos: found.videos, youtube: found.youtube, lines };
  };

  /** In a cross-site frame the extension may read (the student allowed that site): its own clean HTML, for the frame marker. */
  globalThis.__arcFrame = async function arcFrame() {
    if (window.top === window) return null;
    await settle(document, 500, 4000);
    const found = { frames: [], videos: [], youtube: [], depth: 1 };
    const html = await page(document, location.href, found, { count: Infinity, bytes: 0, images: [] }); // text only: a frame's pictures stay links
    return { url: location.href, html: html.slice(0, 1_000_000) };
  };
  globalThis.__arcCanvas = canvas; // for the read-only probe (scripts/canvas-probe.mjs)
})();
