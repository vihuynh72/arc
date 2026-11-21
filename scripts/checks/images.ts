// Offline check for lib/server/images.ts: the image proxy never reaches private addresses and only passes real images.
import assert from "node:assert";
import { privateAddress, publicUrl, sniff } from "../../lib/server/images";

export default async function check() {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1"])
    assert.ok(privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.ok(!privateAddress(ip), ip);
  for (const u of ["http://localhost/x.png", "http://127.0.0.1/x.png", "http://[::1]/x.png", "file:///etc/passwd", "http://user:pw@example.org/x.png", "http://example.org:8080/x.png", "http://169.254.169.254/latest", "http://printer.local/a.png"])
    assert.equal(await publicUrl(u), null, u);
  assert.ok(await publicUrl("https://93.184.215.14/a.png"), "a public literal address passes without DNS");
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
  assert.equal(sniff(Buffer.from("<!doctype html><html><title>Just a moment...</title>")), null, "a challenge page is not an image");
}
