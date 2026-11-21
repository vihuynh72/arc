// Reddit threads and subreddits (students read course subreddits). Called by app/api/load. Routes, in order:
// 1. Reddit's own public Atom feed (thread or listing URL + ".rss"), one plain fetch through lib/server/safeFetch.ts.
// 2. A thread collected earlier by Bright Data's Web Scraper API (Reddit Posts dataset), stored in .cache/reddit/.
// 3. Thread only: ask the Web Scraper API for it in the background (it takes minutes, measured 381 s) and say so in one line.
// All three only with ARC_REDDIT_SCRAPER=on (default off): by default a Reddit link gets REDDIT_LINES.off at once and nothing runs.
// The Web Unlocker and the Browser API refuse reddit.com on this account (Bright Data's robots.txt policy), so they are not tried.
// A thread becomes the post plus up to 50 comments, each one block that starts with who wrote it; deleted and removed are skipped.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Block, Twin, TwinNode } from "@/lib/types";
import { safeFetch } from "@/lib/server/safeFetch";

const MAX_COMMENTS = 50;
const MAX_DEPTH = 2; // a reply to a reply is read; deeper replies are left out
const DATASET = "gd_lvz8ah06191smkebj4"; // Bright Data "Reddit - Posts" (collect by URL)
const UA = "Arc/0.1 (accessible study reader)";
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const cacheFile = (thread: string) => `.cache/reddit/${sha(thread)}.json`;
const GONE = /^\s*\[(deleted|removed)\]\s*$/i;

export type RedditLink = { kind: "thread"; url: string; sub: string } | { kind: "listing"; url: string; sub: string | null };
/** A Reddit link as a thread or a listing (subreddit, its search, Reddit search). Null when it is not Reddit or is neither. */
export function redditLink(raw: string): RedditLink | null {
  const u = new URL(raw);
  const h = u.hostname.replace(/^(www|old|new|np|m)\./, "");
  if (h === "redd.it" && /^\/\w+$/.test(u.pathname)) return { kind: "thread", url: `https://www.reddit.com/comments${u.pathname}/`, sub: "" };
  if (h !== "reddit.com") return null;
  const t = /^\/(?:r\/(\w+)\/)?comments\/(\w+)(?:\/([^/]*))?/.exec(u.pathname);
  if (t) return { kind: "thread", url: `https://www.reddit.com/${t[1] ? `r/${t[1]}/` : ""}comments/${t[2]}/${t[3] ? `${t[3]}/` : ""}`, sub: t[1] ?? "" };
  const s = /^\/r\/(\w+)\/?(hot|new|top|rising|search)?\/?$/.exec(u.pathname);
  if (s) return { kind: "listing", url: `https://www.reddit.com/r/${s[1]}/${s[2] ? `${s[2]}/` : ""}${u.search}`, sub: s[1] };
  if (/^\/search\/?$/.test(u.pathname) && u.searchParams.get("q")) return { kind: "listing", url: `https://www.reddit.com/search/${u.search}`, sub: null };
  return null;
}
const feedUrl = (l: RedditLink) => {
  const u = new URL(l.url);
  u.pathname = u.pathname.replace(/\/?$/, "/.rss");
  return u.href;
};

type Post = { title: string; author: string; text: string; sub: string; comments: { author: string; text: string; depth: number }[] };
const plain = (html: string) => {
  const $ = cheerio.load(html);
  $("br").replaceWith("\n");
  $("p,li,blockquote,pre").each((_, e) => void $(e).append("\n"));
  return $.root().text().replace(/\[link\]|\[comments\]/g, "").replace(/submitted by\s+\/u\/\S+/i, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
};
const who = (s: string) => s.replace(/^\/?u\//, "").trim() || "someone";

/** Reddit's Atom feed for a thread: the first entry is the post (t3_), the rest are comments (t1_), newest replies flattened. */
export function parseThreadFeed(xml: string): Post | null {
  const $ = cheerio.load(xml, { xml: true });
  const entries = $("entry").toArray();
  if (!entries.length) return null;
  const e = (i: number) => $(entries[i]);
  const post = e(0);
  const sub = /\/r\/(\w+)/.exec(post.find("category").attr("term") ?? post.find("link").attr("href") ?? "")?.[1] ?? post.find("category").attr("term") ?? "";
  const comments = entries.slice(1).flatMap((_, i) => {
    const c = e(i + 1);
    const text = plain(c.find("content").text());
    return !text || GONE.test(text) ? [] : [{ author: who(c.find("author name").text()), text, depth: 0 }];
  });
  return { title: post.find("title").first().text().trim(), author: who(post.find("author name").text()), text: plain(post.find("content").text()), sub, comments: comments.slice(0, MAX_COMMENTS) };
}

/** A subreddit or search feed: one result per thread. */
export function parseListingFeed(xml: string): { title: string; url: string; snippet: string }[] {
  const $ = cheerio.load(xml, { xml: true });
  return $("entry")
    .map((_, x) => {
      const t = $(x);
      return { title: t.find("title").first().text().trim(), url: t.find("link").attr("href") ?? "", snippet: `Posted by ${who(t.find("author name").text())}. ${plain(t.find("content").text()).slice(0, 240)}`.trim() };
    })
    .get()
    .filter((r) => r.title && /\/comments\//.test(r.url));
}

type Scraped = { title?: string; user_posted?: string; description?: string; community_name?: string; comments?: Comment[] };
type Comment = { comment?: string; user_commenting?: string; replies?: Comment[] };
/** One record of the Bright Data Reddit Posts dataset. */
export function fromScraper(r: Scraped): Post | null {
  if (!r?.title) return null;
  const comments: Post["comments"] = [];
  const walk = (cs: Comment[] = [], depth: number) => {
    for (const c of cs) {
      if (comments.length >= MAX_COMMENTS) return;
      const text = (c.comment ?? "").trim();
      if (text && !GONE.test(text) && c.user_commenting !== "[deleted]") comments.push({ author: who(c.user_commenting ?? ""), text, depth });
      if (depth < MAX_DEPTH) walk(c.replies, depth + 1);
    }
  };
  walk(r.comments, 0);
  return { title: r.title, author: who(r.user_posted ?? ""), text: r.description ?? "", sub: r.community_name ?? "", comments };
}

/** The post and its comments as a twin: the post, then one section whose blocks are the comments, each naming its writer. */
export function threadTwin(p: Post, url: string, via: Twin["source"]["via"], credit: string): Twin {
  const nodes: TwinNode[] = [{ id: "n01", kind: "section", order: 1, level: 2, heading: p.title, text: [`Posted by ${p.author}${p.sub ? ` in r/${p.sub}` : ""}.`, p.text].filter(Boolean).join("\n\n") }];
  if (p.comments.length) {
    const blocks: Block[] = p.comments.map((c, i) => ({ id: `n02.b${String(i + 1).padStart(2, "0")}`, kind: "paragraph", text: `${c.depth ? "Reply from" : "From"} ${c.author}: ${c.text.replace(/\s*\n\s*/g, " ")}` }));
    nodes.push({ id: "n02", kind: "section", order: 2, level: 2, heading: `Comments (${p.comments.length})`, text: blocks.map((b) => b.text).join("\n\n"), blocks });
  }
  return { id: "twin-" + sha(url).slice(0, 8), source: { url, kind: "page", title: p.title, via, credit }, nodes, counts: { sections: nodes.length, figures: 0, segments: 0 } };
}

export const REDDIT_LINES = {
  off: "Arc can't open Reddit pages yet. If the thread is open in your browser, the Arc helper can read it from your tab.",
  asked: "Reddit does not let Arc read this thread directly. Arc has asked Bright Data to collect it, which takes a few minutes; paste the link again then. If it is open in your browser, the Arc extension can read it from your tab.",
  waiting: "Bright Data is still collecting this Reddit thread. Paste the link again in a minute or two. If it is open in your browser, the Arc extension can read it from your tab.",
  gone: "This Reddit thread was removed, or it is private, so there is nothing to read.",
  listing: "Reddit does not let Arc read its lists of threads. Paste one thread's link, or say search, and the topic.",
};

const feed = async (url: string, signal: AbortSignal) => {
  const res = await safeFetch(url, { headers: { "user-agent": UA, accept: "application/atom+xml" }, signal }).catch(() => null);
  const body = res?.ok ? await res.text().catch(() => "") : "";
  if (res && !res.ok) await res.body?.cancel().catch(() => {});
  console.log(`[reddit] feed ${res?.status ?? "error"} ${new URL(url).host}${new URL(url).pathname}`); // host and path: a query can carry what the student searched
  return body;
};

// Background collection by the Web Scraper API: one snapshot per thread, polled until ready, then stored. Never awaited by a load.
const pending = ((globalThis as unknown as { __arcReddit?: Map<string, number> }).__arcReddit ??= new Map());
const BD = "https://api.brightdata.com/datasets/v3";
async function collect(thread: string) {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token || pending.has(thread)) return;
  pending.set(thread, Date.now());
  const H = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const r = await fetch(`${BD}/trigger?dataset_id=${DATASET}&include_errors=true`, { method: "POST", headers: H, body: JSON.stringify([{ url: thread }]), signal: AbortSignal.timeout(20_000) });
    const id = ((await r.json().catch(() => ({}))) as { snapshot_id?: string }).snapshot_id;
    console.log(`[reddit] scraper trigger ${r.status} ${id ?? ""}`);
    if (!id) return;
    for (let i = 0; i < 40; i++) {
      await new Promise((ok) => setTimeout(ok, 20_000)); // shortcut: polls every 20 s for up to 13 min; a webhook would need a public address
      const p = (await (await fetch(`${BD}/progress/${id}`, { headers: H })).json().catch(() => ({}))) as { status?: string };
      if (p.status === "failed") return;
      if (p.status !== "ready") continue;
      const rows = await (await fetch(`${BD}/snapshot/${id}?format=json`, { headers: H })).text();
      await mkdir(".cache/reddit", { recursive: true });
      await writeFile(cacheFile(thread), rows);
      console.log(`[reddit] scraper ready ${id} after ${Math.round((Date.now() - pending.get(thread)!) / 1000)} s`);
      return;
    }
  } catch (e) {
    console.log(`[reddit] scraper error ${(e as Error).message.slice(0, 80)}`);
  } finally {
    pending.delete(thread);
  }
}

const err = (message: string, status: number) => Object.assign(new Error(message), { name: "PageError", status });

/** A thread as a twin, or a listing as results (via app/api/load's results twin). Throws a PageError with one plain line otherwise. */
export async function redditLoad(link: RedditLink): Promise<{ twin: Twin } | { results: { title: string; url: string; snippet: string }[] }> {
  // Opt-in only (ARC_REDDIT_SCRAPER=on): the Web Scraper API costs per link and takes minutes, and Reddit's terms do not permit
  // automated collection without its consent. Default: one honest line at once, nothing fetched, nothing in the background.
  if (process.env.ARC_REDDIT_SCRAPER !== "on") throw err(REDDIT_LINES.off, 502);
  const xml = await feed(feedUrl(link), AbortSignal.timeout(4000));
  if (link.kind === "listing") {
    const results = xml ? parseListingFeed(xml) : [];
    if (results.length) return { results };
    throw err(REDDIT_LINES.listing, 502);
  }
  const fromFeed = xml ? parseThreadFeed(xml) : null;
  if (fromFeed?.title) return { twin: threadTwin(fromFeed, link.url, "direct", "From Reddit's public feed for this thread.") };
  const stored = await readFile(cacheFile(link.url), "utf8").catch(() => null);
  if (stored) {
    const rows = (() => {
      try {
        return JSON.parse(stored) as (Scraped & { error?: string })[];
      } catch {
        return [];
      }
    })();
    const p = Array.isArray(rows) ? fromScraper(rows[0]) : null;
    if (p) return { twin: threadTwin(p, link.url, "cache", "Collected from Reddit by Bright Data's Web Scraper API.") };
    throw err(REDDIT_LINES.gone, 404); // the scraper answered with no post: removed, deleted or private
  }
  if (pending.has(link.url)) throw err(REDDIT_LINES.waiting, 503);
  void collect(link.url);
  throw err(REDDIT_LINES.asked, 503);
}
