// Called once by server.ts after listen. Each warm-up runs in the background, never awaited by a request; a failure is one log line.
const warmOne = (name: string, job: () => Promise<unknown>) => {
  const t = Date.now();
  job().then(
    () => console.log(`[warm] ${name} ready in ${Date.now() - t} ms`),
    (e) => console.log(`[warm] ${name} skipped: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`),
  );
};

export function warmAll() {
  // The speak route waits on this same globalThis promise, so a first request mid-load does not start a second load.
  if (process.env.ARC_KOKORO !== "off") warmOne("kokoro", () => import("./kokoro").then((m) => m.model()));
  warmOne("bright data browser", () => import("./remote").then((m) => m.remoteConnect()));
  warmOne("decide upstream", () => import("./decide").then((m) => m.warm()));
}
