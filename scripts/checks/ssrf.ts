// Offline check for lib/server/safeFetch.ts: which addresses Arc may fetch on the server. DNS names that resolve to loopback
// (localtest.me) need a resolver, so they are checked only when one answers; literal addresses need none.
import assert from "node:assert";
import http from "node:http";
import { lookup } from "node:dns/promises";
import { checkUrl, normalizeUrl, safeFetch } from "../../lib/server/safeFetch";

export default async function check() {
  const table: [string, string][] = [
    ["http://127.0.0.1:3000/", "port"],
    ["http://127.0.0.1/", "private"],
    ["http://[::1]/", "private"],
    ["http://2130706433/", "private"], // decimal 127.0.0.1
    ["http://0x7f.1/", "private"], // hex
    ["http://0177.0.0.1/", "private"], // octal
    ["http://[::ffff:127.0.0.1]/", "private"],
    ["http://[::ffff:7f00:1]/", "private"],
    ["http://[2002:7f00:1::1]/", "private"], // 6to4 of 127.0.0.1
    ["http://[2002:c0a8:101::]/", "private"], // 6to4 of 192.168.1.1
    ["http://[2002:a9fe:a9fe::1]/", "private"], // 6to4 of 169.254.169.254 (cloud metadata)
    ["http://[2002::1]/", "private"], // 6to4 of 0.0.0.0, compressed
    ["http://[2002:808:808::1]/", "ok"], // 6to4 of 8.8.8.8: a public address
    ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "private"], // Teredo
    ["http://[2001::7f00:1]/", "private"], // Teredo, compressed
    ["http://[2001:4860:4860::8888]/", "ok"], // public IPv6 (Google DNS), not Teredo
    ["http://169.254.169.254/latest/meta-data/", "private"],
    ["http://192.168.1.1/", "private"],
    ["http://10.0.0.5/", "private"],
    ["http://172.20.1.1/", "private"],
    ["http://100.64.1.1/", "private"],
    ["http://[fd00::1]/", "private"],
    ["http://[fe80::1]/", "private"],
    ["http://0.0.0.0/", "private"],
    ["http://224.0.0.1/", "private"],
    ["http://localhost/", "private"],
    ["http://app.localhost/", "private"],
    ["http://printer.local/", "private"],
    ["http://metadata.google.internal/", "private"],
    ["http://user:pass@example.org/", "scheme"],
    ["ftp://example.org/", "scheme"],
    ["http://93.184.215.14/", "ok"],
    ["http://192.0.66.108/", "ok"], // www.nasa.gov: only 192.0.0/24 and 192.0.2/24 are reserved
    ["http://192.0.2.1/", "private"],
    ["http://8.8.8.8:8080/", "port"],
  ];
  for (const [u, want] of table) {
    const c = await checkUrl(u);
    assert.equal(c.ok ? "ok" : c.why, want, u);
  }
  if ((await lookup("localtest.me").catch(() => null))?.address === "127.0.0.1") assert.equal((await checkUrl("http://localtest.me/")).ok, false, "a name that resolves to loopback");

  // What the student types becomes an address, or nothing.
  assert.equal(normalizeUrl("wikipedia.org/wiki/Mitosis"), "https://wikipedia.org/wiki/Mitosis");
  assert.equal(normalizeUrl("  HTTPS://EN.WIKIPEDIA.ORG/wiki/Mitosis  "), "https://en.wikipedia.org/wiki/Mitosis");
  assert.equal(normalizeUrl("https://en.wikipedia.org/wiki/Cell?utm_source=x&id=2#Structure"), "https://en.wikipedia.org/wiki/Cell?id=2#Structure");
  assert.equal(normalizeUrl("file:///etc/passwd"), "scheme");
  assert.equal(normalizeUrl("javascript:alert(1)"), "scheme");
  assert.equal(normalizeUrl("data:text/html,<h1>hi</h1>"), "scheme");
  assert.equal(normalizeUrl("htp:/not a url"), null);
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("http://2130706433/"), "http://127.0.0.1/");

  // A page that redirects to a private address is refused at that hop. The test's own loopback listener stands in for the public
  // page (allowed for hop 0 only); the redirect target goes through the real check.
  const srv = http.createServer((_q, r) => r.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end());
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  const first = (u: string, hop: number) => (hop === 0 ? Promise.resolve({ ok: true as const, url: new URL(u), address: "127.0.0.1", family: 4 as const }) : checkUrl(u));
  await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`, {}, first), /public web addresses/, "redirect hop to cloud metadata");
  await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), /public web addresses/, "loopback itself");
  srv.close();
}
