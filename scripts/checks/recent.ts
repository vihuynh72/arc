// Run by scripts/selfcheck.ts: the list of pages opened before (lib/client/recent.ts) round-trips, rejects anything malformed, keeps
// at most 30, moves a reopened page to the top with its place, finds a title by a few words, writes nothing about a private page,
// an assessment or an upload, and does nothing (never throws) when storage refuses.
import assert from "node:assert";
import { GREETING } from "../../lib/keys";
import { updatePlace } from "../../lib/client/place";
import { clearRecent, findRecent, greeting, keepRecentPlace, MAX_RECENT, parseRecent, readRecent, RECENT_KEY, rememberRecent, saidTitle, type Recent, without, withEntry, withPlace } from "../../lib/client/recent";

const e = (n: number, o: Partial<Recent> = {}): Recent => ({ url: `https://example.org/${n}`, title: `Title ${n}`, kind: "page", at: n, ...o });

export default function check() {
  // parse: exactly entries, else nothing (an entry that is not one is dropped, the rest stay)
  const good = [e(1, { place: { id: "n04", b: 2, page: 3 } }), e(2, { kind: "video" }), e(3, { kind: "pdf" })];
  assert.deepEqual(parseRecent(JSON.stringify(good)), good);
  for (const bad of [null, undefined, "", "x", "{}", "null", '{"url":"https://a.org"}']) assert.deepEqual(parseRecent(bad as string), [], `rejects ${bad}`);
  const mixed = [good[0], { ...e(4), url: "javascript:alert(1)" }, { ...e(5), url: "upload:notes" }, { ...e(6), kind: "audio" }, { ...e(7), title: "  " }, { ...e(8), at: "now" }, { ...e(9), place: { id: "a b", b: 0 } }, null, 5, good[2]];
  assert.deepEqual(parseRecent(JSON.stringify(mixed)), [good[0], good[2]], "only the well-formed entries stay");
  assert.equal(parseRecent(JSON.stringify(Array.from({ length: 40 }, (_, i) => e(i)))).length, MAX_RECENT);

  // add: newest first, a reopened link moves up and keeps its place, the cap drops the oldest
  let l: Recent[] = [];
  for (let i = 1; i <= 35; i++) l = withEntry(l, e(i));
  assert.equal(l.length, MAX_RECENT);
  assert.equal(l[0].url, "https://example.org/35");
  assert.equal(l.at(-1)?.url, "https://example.org/6", "1 to 5 were dropped");
  l = withPlace(l, "https://example.org/20", { id: "n09", b: 0 });
  l = withEntry(l, e(20, { at: 99, title: "Better title" }));
  assert.equal(l[0].title, "Better title");
  assert.deepEqual(l[0].place, { id: "n09", b: 0 }, "reopened: the place stays");
  assert.equal(l.filter((x) => x.url === "https://example.org/20").length, 1);
  assert.equal(l.length, MAX_RECENT);
  assert.deepEqual(withPlace(l, "https://example.org/none", { id: "n01", b: 0 }), l, "no entry, nothing changes");
  assert.equal(withPlace(l, "https://example.org/30", { id: "n02", b: 1 })[1].url, l[1].url, "a place update keeps the order");
  assert.equal(without(l, "https://example.org/20").length, MAX_RECENT - 1);

  // find by words: filler ignored, best title wins, newest on a tie, none when no word fits
  const list = [e(1, { title: "Knee sensors for rehabilitation" }), e(2, { title: "Biology 2e: The Cell Cycle" }), e(3, { title: "Cell biology notes" })];
  assert.equal(findRecent(list, "my biology paper")?.url, list[1].url, "newest of two that hold the word");
  assert.equal(findRecent(list, "the cell cycle")?.url, list[1].url, "two words beat one");
  assert.equal(findRecent(list, "that knee one")?.url, list[0].url);
  assert.equal(findRecent(list, "sensor")?.url, list[0].url, "a plural fits");
  assert.equal(findRecent(list, "my chemistry paper"), null);
  assert.equal(findRecent(list, "my paper"), null, "only filler says nothing");
  assert.equal(findRecent([], "biology"), null);
  assert.equal(saidTitle("Development of Wearable Devices for Collecting Digital Rehabilitation and Fitness Data from Lower Limbs"), "Development of Wearable Devices for Collecting Digital Rehabilitation");
  assert.equal(saidTitle("Heating and Cooling: a long subtitle"), "Heating and Cooling");

  // storage that works: only public pages are written, never a private page, an assessment or an upload
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const g = globalThis as unknown as { localStorage?: unknown; sessionStorage?: unknown };
  g.localStorage = store;
  g.sessionStorage = { ...store, getItem: (k: string) => mem.get(`s:${k}`) ?? null, setItem: (k: string, v: string) => void mem.set(`s:${k}`, v) };
  assert.equal(greeting(), GREETING, "nothing kept: the plain greeting");
  const pub = { url: "https://example.org/paper", title: "Biology of the Cell: a long subtitle", kind: "page" as const };
  rememberRecent(pub);
  rememberRecent({ url: "https://school.example/course", title: "Private course", kind: "page", private: true });
  rememberRecent({ url: "https://school.example/quiz", title: "Quiz 1", kind: "page", assessment: true });
  rememberRecent({ url: "upload:abc", title: "My notes.pdf", kind: "pdf" });
  assert.deepEqual(readRecent().map((x) => x.url), [pub.url], "only the public page");
  assert.deepEqual([...mem.keys()], [RECENT_KEY], "nothing else is stored");
  assert.equal(greeting(), `${GREETING} Say continue to go back to Biology of the Cell.`);
  updatePlace(pub.url, { id: "n05", b: 1 });
  keepRecentPlace(pub.url);
  assert.deepEqual(readRecent()[0].place, { id: "n05", b: 1 });
  rememberRecent(pub); // opened again: the place stays
  assert.deepEqual(readRecent()[0].place, { id: "n05", b: 1 });
  clearRecent();
  assert.deepEqual(readRecent(), []);
  assert.equal(mem.has(RECENT_KEY), false, "cleared means gone, not an empty list");
  mem.set(RECENT_KEY, "garbage");
  assert.deepEqual(readRecent(), [], "a hand-edited value is no list");

  // storage that refuses (private window, blocked site data): nothing throws, nothing is found
  const nope = () => {
    throw new Error("SecurityError");
  };
  g.localStorage = { getItem: nope, setItem: nope, removeItem: nope };
  assert.doesNotThrow(() => (rememberRecent(pub), keepRecentPlace(pub.url), clearRecent()));
  assert.deepEqual(readRecent(), []);
  assert.equal(greeting(), GREETING);
  delete g.localStorage; // no storage object at all
  assert.deepEqual(readRecent(), []);
  delete g.sessionStorage;
}
