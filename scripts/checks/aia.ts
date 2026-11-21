// Offline check of lib/server/aia.ts: which fetched certificate may complete a site's chain. The certificates below are test
// material made for this check (a root, an intermediate it signed, a site certificate the intermediate signed, and an unrelated
// root with a site certificate of its own). They are valid until 2126, trusted by nothing, and their private keys were not kept.
import assert from "node:assert";
import { X509Certificate } from "node:crypto";
import { chainGap, issuerOf, issuerUrl, rootSigned } from "../../lib/server/aia";

const ROOT = `-----BEGIN CERTIFICATE-----
MIIBaDCCAQ6gAwIBAgIUQuQQFuq5g3+CeuELcaq0RDoy/6AwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOQXJjIGNoZWNrIHJvb3QwIBcNMjYxMTIxMTMwMjExWhgPMjEy
NjEwMjgxMzAyMTFaMBkxFzAVBgNVBAMMDkFyYyBjaGVjayByb290MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAECZXt4t5zLGCQE2OvRBrPywXDxCby4Rh0CiyGu8rx
kWUUfQ21J0NAv1GlWEkIcOlZirCUwT2cJzrveRgXqT4FkqMyMDAwHQYDVR0OBBYE
FD9/AwRFsxIOTOFYr/eulVcguBVgMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0E
AwIDSAAwRQIhANvGQsbltvcYnRmnNx+JsRbmJtsBDDuQnHY1xIQjxsEfAiApURwq
GjJn9psqBeHNglEojeHGpaUxevHePKR2I/sKfQ==
-----END CERTIFICATE-----`;
const INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIUCgz1UWqXcEuOj584SxjIoJwEFKMwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOQXJjIGNoZWNrIHJvb3QwIBcNMjYxMTIxMTMwMjExWhgPMjEy
NjEwMjgxMzAyMTFaMCExHzAdBgNVBAMMFkFyYyBjaGVjayBpbnRlcm1lZGlhdGUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT3W2Fzd2eZr6E5EjsCwcqG2yYZAP5u
Ggqa2jU4AgUju1B+9CfSQrCb9djDB6Puv0saNjH7PjvTMKGm25ke8q0io2YwZDAS
BgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUZUSx
Jzd0gz9V2wlrkppV0aylnUkwHwYDVR0jBBgwFoAUP38DBEWzEg5M4Viv966VVyC4
FWAwCgYIKoZIzj0EAwIDSAAwRQIhANKEmR8cfj1E/xJs5yYlskGJjR4l6YVwHOjw
dlFEblx7AiAFULvSmBnK8dYNV2vc9p3qQtu7BdvGHEDoJJSaTFj9UA==
-----END CERTIFICATE-----`;
const SITE = `-----BEGIN CERTIFICATE-----
MIIB4zCCAYqgAwIBAgIUQAJXA4qRQp/pQc5fp6UQNBhydS8wCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWQXJjIGNoZWNrIGludGVybWVkaWF0ZTAgFw0yNjExMjExMzAy
MTFaGA8yMTI2MTAyODEzMDIxMVowGTEXMBUGA1UEAwwOc2Nob29sLmV4YW1wbGUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARqv4KdZlydcI5v13vPyQlv4AX5u93x
KqB1cakfILzKnovVng+2u+Gvo2Hnu8uAKJvvLRwolI2O0gTFnTn7wgn3o4GlMIGi
MAkGA1UdEwQCMAAwGQYDVR0RBBIwEIIOc2Nob29sLmV4YW1wbGUwHwYDVR0jBBgw
FoAUZUSxJzd0gz9V2wlrkppV0aylnUkwWQYIKwYBBQUHAQEETTBLMCgGCCsGAQUF
BzAChhxodHRwOi8vY2VydHMuZXhhbXBsZS9pbnQuY3J0MB8GCCsGAQUFBzABhhNo
dHRwOi8vb2NzcC5leGFtcGxlMAoGCCqGSM49BAMCA0cAMEQCIBZFIX7mT7Vq58GQ
IMZ4ftyxVtEvg5h+fimPyJc1aCvUAiBP2sSxOYQIhtawMPt7pyXW8eDG14WqDuyk
9uRsio67Kw==
-----END CERTIFICATE-----`;
const OTHER_ROOT = `-----BEGIN CERTIFICATE-----
MIIBcTCCARigAwIBAgIUC14bBwfYaskNWF8Qs5wzJA9ef3MwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTU29tZW9uZSBlbHNlJ3Mgcm9vdDAgFw0yNjExMjExMzAyMTFa
GA8yMTI2MTAyODEzMDIxMVowHjEcMBoGA1UEAwwTU29tZW9uZSBlbHNlJ3Mgcm9v
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJutRLQ73zBWm4LESlwqHu3n8Zgq
CNbFfTfNII6Cy1Zepm9BIU+ha4kEtofF8pSipAZO5rs51i3zj2+Q8raf312jMjAw
MB0GA1UdDgQWBBQF88Tnufi2RYuX4uqtEpd+Izv9yDAPBgNVHRMBAf8EBTADAQH/
MAoGCCqGSM49BAMCA0cAMEQCIG4JGcMcZ7Qm3SaGVBDT4uIRbcyNfDhNwGEXd7Bv
id/nAiBblpdDXHr9JSpy3iJPm4OnlV6u5gub7ETJPoF/7eT+YQ==
-----END CERTIFICATE-----`;
const OTHER_SITE = `-----BEGIN CERTIFICATE-----
MIIB4jCCAYegAwIBAgIUIOikRNk/4Wy+yw0QbA3SA4PO/d8wCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTU29tZW9uZSBlbHNlJ3Mgcm9vdDAgFw0yNjExMjExMzAyMTFa
GA8yMTI2MTAyODEzMDIxMVowGTEXMBUGA1UEAwwOc2Nob29sLmV4YW1wbGUwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAAR6/CHHE2QDrY8WnzsS/JdFRUUZHQdGHWsJ
Cuv7b0hZ5dBpmRCn/K78cpdwmM1OTrBUx2LlZg0nkq2FrhLfnGEfo4GlMIGiMAkG
A1UdEwQCMAAwGQYDVR0RBBIwEIIOc2Nob29sLmV4YW1wbGUwHwYDVR0jBBgwFoAU
BfPE57n4tkWLl+LqrRKXfiM7/cgwWQYIKwYBBQUHAQEETTBLMCgGCCsGAQUFBzAC
hhxodHRwOi8vY2VydHMuZXhhbXBsZS9pbnQuY3J0MB8GCCsGAQUFBzABhhNodHRw
Oi8vb2NzcC5leGFtcGxlMAoGCCqGSM49BAMCA0kAMEYCIQDt8U9DZXFDmEJB1afQ
XwgeHf5uYaUVPsNXIPfsFdy74QIhAO/DWigWaoQZGLyIHrzvjlXMnb+i1I6ggLFi
oOk+muUa
-----END CERTIFICATE-----`;

export default function check() {
  const site = new X509Certificate(SITE), otherSite = new X509Certificate(OTHER_SITE), intermediate = new X509Certificate(INTERMEDIATE);
  const bytes = (text: string) => new Uint8Array(Buffer.from(text));

  // The missing intermediate, as PEM and as DER (the usual form at a CA Issuers address): it signed the site's certificate.
  assert.equal(issuerOf(bytes(INTERMEDIATE), site)?.toString(), intermediate.toString());
  assert.equal(issuerOf(new Uint8Array(intermediate.raw), site)?.toString(), intermediate.toString());

  // Never an issuer: a certificate that did not sign this one; a site certificate (not a CA); one out of date; a file that is not
  // a certificate; and any self-signed certificate, whether someone's own root or the real one (a root is never taken from a server).
  assert.equal(issuerOf(bytes(INTERMEDIATE), otherSite), null, "did not sign this site");
  assert.equal(issuerOf(bytes(SITE), site), null, "not a CA certificate");
  assert.equal(issuerOf(bytes(INTERMEDIATE), site, Date.UTC(2200, 0, 1)), null, "expired");
  assert.equal(issuerOf(bytes(INTERMEDIATE), site, Date.UTC(2000, 0, 1)), null, "not yet valid");
  assert.equal(issuerOf(bytes("<html>Not found</html>"), site), null, "not a certificate");
  assert.equal(issuerOf(bytes(OTHER_ROOT), otherSite), null, "an untrusted root that signed the site is never accepted");
  assert.equal(issuerOf(bytes(ROOT), intermediate), null, "a self-signed certificate is never accepted from a server");

  // A repair ends well only at a certificate signed by a root this machine trusts.
  assert.ok(rootSigned(intermediate, [OTHER_ROOT, ROOT]));
  assert.ok(!rootSigned(intermediate, [OTHER_ROOT]), "not signed by a trusted root");
  assert.ok(!rootSigned(intermediate, []), "no roots");
  assert.ok(!rootSigned(intermediate), "the machine's real roots did not sign the test intermediate");
  assert.ok(!rootSigned(site, [ROOT]), "the site's certificate is two steps from the root");
  assert.ok(!rootSigned(intermediate, ["not a certificate"]), "a broken root entry is skipped");

  // The issuer's address: the http one named by the certificate, nothing else.
  assert.equal(issuerUrl(site.infoAccess), "http://certs.example/int.crt");
  assert.equal(issuerUrl("OCSP - URI:http://ocsp.example\nCA Issuers - URI:https://certs.example/int.crt"), null, "https is not followed");
  assert.equal(issuerUrl("OCSP - URI:http://ocsp.example"), null);
  assert.equal(issuerUrl(undefined), null);

  // Only the two "chain stops early" errors start a repair; a wrong name, an expired or a self-signed certificate never does.
  assert.deepEqual(
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", undefined].map(chainGap),
    [true, true, false, false, false, false, false],
  );
}
