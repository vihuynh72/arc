// Prints the no-install routes, each a self-contained copy of extension/extract.js plus a few lines:
//   node scripts/bookmarklet.mjs [arc origin]            a bookmarklet (javascript: address) for the bookmarks bar
//   node scripts/bookmarklet.mjs [arc origin] --console  the same hand-off to paste into DevTools on the page (same tab, window.name)
//   node scripts/bookmarklet.mjs --probe                 a structure-only Canvas probe to paste into DevTools: no text, names or titles
// The page content goes only to the Arc origin named here: postMessage with that exact target origin, or window.name read by Arc
// at /?receive=name. Arc checks the shape and size, then posts it to its own /api/ingest like a helper page (lib/client/helper.ts).
import { readFileSync } from "node:fs";

const arc = (process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3000").replace(/\/+$/, "");
const EXTRACT = readFileSync(new URL("../extension/extract.js", import.meta.url), "utf8");

// Bookmarklet: the Arc tab opens first (inside the click, so no pop-up block), the page is read, then handed over once Arc says ready.
const bookmarklet = `(async()=>{const ARC=${JSON.stringify(arc)};const w=window.open(ARC+"/?receive=1","_blank");if(!w){alert("Allow pop-ups for this site, then press the Arc bookmark again.");return}let ready=false,page=null;const send=()=>ready&&page&&w.postMessage({type:"arc:page",page},ARC);addEventListener("message",(e)=>{if(e.source===w&&e.origin===ARC&&e.data&&e.data.type==="arc:ready"){ready=true;send()}});${EXTRACT}
page=JSON.stringify(await globalThis.__arcExtract());send()})()`;

// Console: same tab. The page goes into window.name, then this tab goes to Arc, which reads and clears it.
const consoleCode = `${EXTRACT}
(async()=>{const page=await globalThis.__arcExtract();window.name=JSON.stringify({arc:1,...page});location.href=${JSON.stringify(`${arc}/?receive=name`)}})();`;

const probe = `${EXTRACT}
(async()=>{
  const here=location.href;
  const shape=(u)=>{try{const x=new URL(u,here);return (x.host===location.host?"":x.host)+x.pathname.replace(/\\/\\d+/g,"/N").replace(/\\/pages\\/[^/]+/,"/pages/X").replace(/\\/files\\/N\\/[^/]+$/,"/files/N/…")}catch{return "?"}};
  const t0=performance.now();
  const r=await globalThis.__arcExtract({noSettle:true});
  const ms=Math.round(performance.now()-t0);
  const doc=new DOMParser().parseFromString(r.html||"","text/html");
  const byHost=(els,attr)=>{const m={};for(const e of els){let h;try{h=new URL(e.getAttribute(attr)||"",here).host}catch{h="?"}m[h]=(m[h]||0)+1}return m};
  const count=(s)=>doc.querySelectorAll(s).length;
  return {
    page:shape(here), ms, via:r.via||"rendered page",
    api:(r.trace||[]).map(t=>({endpoint:t.endpoint.split("?")[0],params:(t.endpoint.split("?")[1]||"").split("&").map(x=>x.split("=")[0]).filter(Boolean).join(" "),status:t.status,json:t.json,fields:t.fields})),
    payloadFields:Object.keys(r), htmlLength:(r.html||"").length,
    structure:{h1:count("h1"),h2:count("h2"),h3:count("h3"),h4:count("h4"),p:count("p"),li:count("li"),table:count("table"),tableInLi:count("li table"),nestedTable:count("table table"),math:count("math"),equationImagesLeft:count("img.equation_image"),forms:count("form"),inputs:count("input,textarea,select")},
    pictures:{captured:(r.images||[]).length,kb:Math.round((r.images||[]).reduce((n,d)=>n+d.length*0.75,0)/1024),capturedPlaceholders:count("img[src^='arc-image:']"),leftAsLinksByHost:byHost(doc.querySelectorAll("img:not([src^='arc-image:'])"),"src")},
    linksInText:byHost(doc.querySelectorAll("a[href]"),"href"),
    frames:(r.frames||[]).map(f=>shape(f.src)), youtube:(r.youtube||[]).length, videos:(r.videos||[]).map(v=>({cues:v.cues.length})),
    pdf:r.pdf?{bytes:Math.round(r.pdf.data.length*0.75)}:null, lines:(r.lines||[]).length,
    navigation:(r.links||[]).map(l=>({rel:l.rel||null,path:shape(l.url),labelChars:l.label.length})),
  };
})().then((o)=>{const out=JSON.parse(JSON.stringify(o).replace(/[?=&]/g," "));console.log(JSON.stringify(out,null,1));return out});`; // no query strings anywhere: some tools refuse to show them

const mode = process.argv.includes("--probe") ? probe : process.argv.includes("--console") ? consoleCode : `javascript:${encodeURIComponent(bookmarklet)}`;
process.stdout.write(mode + "\n");
