// Some sites send their certificate without the certificates above it (a school or government server set up by hand, or a site
// on a certificate authority's newer hierarchy that this Node version does not know yet). A browser fetches each missing one from
// the address the certificate below it names ("CA Issuers") and then verifies the chain as usual; Node does not, so such a site
// fails for Arc while it opens for the student. These are the rules of that repair. Nothing new is trusted: each fetched
// certificate must have signed the one below it, the last must be signed by a root this machine already trusts, and the real
// request is then verified in full (chain, dates, host name) by Node. Caller: lib/server/safeFetch.ts. Check: scripts/checks/aia.ts.
import { X509Certificate } from "node:crypto";
import tls from "node:tls";

/** Node's error codes for "this chain stops before a root I know". */
export const chainGap = (code: unknown) => code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";

/** Where a certificate says its issuer's certificate can be fetched. Plain http only: the standard form; the file is verified, never trusted. */
export const issuerUrl = (infoAccess = "") => /CA Issuers - URI:(http:\/\/[^\s"]+)/.exec(infoAccess)?.[1] ?? null;

/**
 * A fetched file as the certificate that issued `child`: a CA certificate, in date, whose key signed `child`. Null for anything
 * else: another site's intermediate, an expired one, a site certificate, a file that is not a certificate, and any self-signed
 * certificate (a root is trusted because this machine holds it, never because a server pointed to it).
 * shortcut: DER or PEM only, not a PKCS#7 bundle; upgrade if such sites turn up.
 */
export function issuerOf(file: Uint8Array, child: X509Certificate, now = Date.now()): X509Certificate | null {
  try {
    const c = new X509Certificate(Buffer.from(file));
    const inDate = Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
    const selfSigned = c.checkIssued(c) && c.verify(c.publicKey);
    return c.ca && inDate && !selfSigned && child.checkIssued(c) && child.verify(c.publicKey) ? c : null;
  } catch {
    return null;
  }
}

/** Whether a root this machine trusts signed the certificate: the only way a repair ends well. */
export function rootSigned(c: X509Certificate, roots: readonly string[] = tls.rootCertificates): boolean {
  return roots.some((pem) => {
    try {
      const r = new X509Certificate(pem);
      return c.checkIssued(r) && c.verify(r.publicKey);
    } catch {
      return false;
    }
  });
}
