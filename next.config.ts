import type { NextConfig } from "next";

// On every response. No page of Arc is meant to be framed (clickjacking: a hidden Arc under another site's buttons), so pages
// say frame-ancestors 'none'. A full script policy (script-src with nonces for Next's inline bootstrap, connect-src for the
// voice socket, frame-src for YouTube, img-src for figures from any study site) is the next step, not done here.
const base = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "kokoro-js", "onnxruntime-node", "ws"],
  async headers() {
    return [
      { source: "/:path*", headers: base },
      { source: "/((?!api/).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] }, // pages, not API replies
    ];
  },
};

export default nextConfig;
