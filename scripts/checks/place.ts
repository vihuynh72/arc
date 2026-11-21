// Run by scripts/selfcheck.ts: the place kept in the tab (lib/client/place.ts) round-trips, rejects anything that is not exactly a
// place, keeps nothing about private pages, uploads or assessments, and does nothing (never throws) when storage refuses.
import assert from "node:assert";
import { addressFor, clearGone, dropPlace, isPublic, markGone, parsePlace, placeKey, readPlace, serialise, takeGone, updatePlace, worthKeeping } from "../../lib/client/place";

export default function check() {
  const p = { id: "n04", b: 2, page: 3, t: 100 };
  assert.deepEqual(parsePlace(serialise(p)), p);
  assert.deepEqual(parsePlace(serialise({ id: "n01", b: -1 })), { id: "n01", b: -1 });
  for (const bad of [null, undefined, "", "x", "[]", "null", '{"id":"n1"}', '{"id":"n1","b":1.5}', '{"id":"n1","b":-2}', '{"id":"a b","b":0}', '{"id":"n1","b":0,"page":0}', '{"id":"n1","b":0,"t":-1}', '{"id":1,"b":0}'])
    assert.equal(parsePlace(bad as string), null, `rejects ${bad}`);

  // Only a real move is worth keeping: not the heading of the first node, not the first second of a lecture.
  assert.equal(worthKeeping({ id: "n01", b: -1 }, "n01"), false);
  assert.equal(worthKeeping({ id: "n01", b: 0 }, "n01"), true);
  assert.equal(worthKeeping({ id: "n03", b: -1 }, "n01"), true);
  assert.equal(worthKeeping({ id: "", b: -1, t: 0.4 }), false);
  assert.equal(worthKeeping({ id: "", b: -1, t: 100 }), true);

  // What may be kept: a public link only.
  assert.equal(isPublic({ url: "https://www.mdpi.com/1424-8220/24/6/1935" }), true);
  assert.equal(isPublic({ url: "https://school.example/course", private: true }), false);
  assert.equal(isPublic({ url: "https://school.example/quiz", assessment: true }), false);
  assert.equal(isPublic({ url: "upload:notes" }), false);
  assert.equal(addressFor("https://a.org/x?y=1&z=2"), "/?url=https%3A%2F%2Fa.org%2Fx%3Fy%3D1%26z%3D2");

  // Storage that works: written, merged, read back, dropped; the marker is one word and is taken once.
  const mem = new Map<string, string>();
  const g = globalThis as unknown as { sessionStorage?: unknown };
  g.sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const url = "https://example.org/a";
  updatePlace(url, { id: "n04", b: 2 });
  updatePlace(url, { t: 100 });
  assert.deepEqual(readPlace(url), { id: "n04", b: 2, t: 100 });
  assert.deepEqual([...mem.keys()], [placeKey(url)], "only the place is stored, under its link");
  updatePlace("https://example.org/b", { id: "n09", b: 0 });
  dropPlace(url);
  assert.equal(readPlace(url), null);
  assert.deepEqual(readPlace("https://example.org/b"), { id: "n09", b: 0 }, "another link's place stays");
  mem.set(placeKey(url), "garbage");
  assert.equal(readPlace(url), null, "a hand-edited value is no place");
  mem.clear();
  markGone("private");
  assert.deepEqual([...mem.values()], ["private"], "nothing about the page itself, only that one was open");
  assert.equal(takeGone(), "private");
  assert.equal(takeGone(), null, "said once");
  markGone("file");
  clearGone();
  assert.equal(takeGone(), null);

  // Storage that refuses (private window, blocked site data): nothing throws, nothing is found.
  const nope = () => {
    throw new Error("SecurityError");
  };
  g.sessionStorage = { getItem: nope, setItem: nope, removeItem: nope };
  assert.doesNotThrow(() => (updatePlace(url, { id: "n01", b: 0 }), dropPlace(url), markGone("file"), clearGone()));
  assert.equal(readPlace(url), null);
  assert.equal(takeGone(), null);
  delete g.sessionStorage; // no storage object at all (a ReferenceError inside the try)
  assert.equal(readPlace(url), null);
}
