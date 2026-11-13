import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "kokoro-js", "onnxruntime-node", "ws"],
};

export default nextConfig;
