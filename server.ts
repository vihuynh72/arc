// One process, one port: Next and the /ws/voice WebSocket. Run with `tsx server.ts`.
// Visitor limits (lib/server/limits.ts) are enforced here and nowhere else, and only when NODE_ENV=production or ARC_LIMITS=on.
// Also here, always: the cross-site refusal and body caps (lib/server/limits.ts), the loopback peer test for /api/pointer and
// /api/budget, the visitor's key for the per-visitor budget (lib/server/budget.ts runAsVisitor), and the cache janitor.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { LEVEL_NAMES, level, levelLine, recordSpeech, runAsVisitor } from "./lib/server/budget";
import { startJanitor } from "./lib/server/janitor";
import { attachVoice } from "./lib/server/live";
import { Buckets, LIMITS, LOCAL_ONLY, SAY_BUSY, SAY_SLOW, SAY_TABS, VOICE, bodyCap, classify, clientIp, crossSite, limitsOn, logIp, loopback, proxyHops, type RouteClass } from "./lib/server/limits";
import { warmAll } from "./lib/server/warm";

try {
  process.loadEnvFile(".env.local");
} catch {
  // missing .env.local is fine until a feature needs a key
}

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname: "localhost", port });
const handle = app.getRequestHandler();

const limited = limitsOn();
const hops = proxyHops();
const buckets = Object.fromEntries(Object.entries(LIMITS).map(([k, l]) => [k, new Buckets(l.cap, l.perMin)])) as Record<RouteClass, Buckets>;
const voiceByIp = new Map<string, number>();
let voiceTotal = 0;

const tooMany = (res: ServerResponse, retry: number, say: string) => {
  res.writeHead(429, { "content-type": "application/json", "retry-after": String(retry), "cache-control": "no-store" });
  res.end(JSON.stringify({ error: say, say }));
};

/** Local speech is free but CPU: its seconds go to the day's record (24 kHz 16-bit mono WAV, 44-byte header). */
function countSpeech(res: ServerResponse) {
  let bytes = 0;
  const { write, end } = res;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk as Buffer);
    return (write as (...a: unknown[]) => boolean).call(res, chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk as Buffer);
    if (res.statusCode === 200 && bytes > 44) recordSpeech((bytes - 44) / 48000);
    return (end as (...a: unknown[]) => ServerResponse).call(res, chunk, ...rest);
  }) as typeof res.end;
}

const refuse = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
};
let warnedHops = false;

function onRequest(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  // Before Next: another site's page in the owner's browser must not post here, move the pointer or read the budget.
  const why = crossSite(method, path, req.headers as Record<string, string>, false, hops);
  if (why) {
    console.log(`[origin] refused ${method} ${path}: ${why}`);
    return refuse(res, 403, "Not allowed.");
  }
  // The pointer and the budget belong to whoever sits at this machine: the socket peer must be loopback, and nothing forwarded.
  if (LOCAL_ONLY.test(path) && (!loopback(req.socket.remoteAddress) || req.headers["x-forwarded-for"] !== undefined)) return refuse(res, 404, "Not found.");
  if (!/^(GET|HEAD|OPTIONS)$/i.test(method) && path.startsWith("/api/")) {
    const cap = bodyCap(path);
    const len = req.headers["content-length"];
    if (cap !== Infinity && len === undefined) return refuse(res, 411, "Send a Content-Length.");
    if (Number(len) > cap) return refuse(res, 413, "That request is too large.");
  }
  if (!warnedHops && !hops && process.env.NODE_ENV === "production" && (req.headers["x-forwarded-for"] || req.headers["forwarded"])) {
    warnedHops = true;
    console.warn("[limits] WARNING: forwarded headers arrive but ARC_PROXY_HOPS is 0, so every visitor is keyed by the proxy's address and shares one set of limits. Set ARC_PROXY_HOPS to the number of proxies in front of Arc (README, deploy).");
  }
  if (path.startsWith("/api/")) {
    const l = level();
    if (l > 0) res.setHeader("x-arc-budget", LEVEL_NAMES[l]); // a client may speak levelLine(); the header says which
    if (l > 0) res.setHeader("x-arc-budget-say", encodeURIComponent(levelLine()));
  }
  if (path === "/api/speak") countSpeech(res);
  if (limited) {
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops);
    const cls = classify(req.method ?? "GET", path);
    if (process.env.ARC_LIMITS_LOG) console.log(`[req] ${cls} ${logIp(ip)} ${req.method} ${path}`); // for sizing the limits table
    const wait = buckets[cls].take(ip);
    if (wait) {
      console.log(`[limits] ${logIp(ip)} over the ${cls} limit (${req.method} ${path}); retry in ${wait} s`);
      return tooMany(res, wait, SAY_SLOW);
    }
  }
  // Every model call this request makes, now or in work it starts, is charged to this visitor (lib/server/budget.ts).
  return runAsVisitor(clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops), () => handle(req, res));
}

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler();
  const server = createServer(onRequest);

  const voice = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }); // the largest frame is a start with its page text (capped in live.ts)
  voice.on("connection", (ws, req: IncomingMessage) => {
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops);
    voiceTotal++;
    voiceByIp.set(ip, (voiceByIp.get(ip) ?? 0) + 1);
    ws.on("close", () => {
      voiceTotal--;
      const n = (voiceByIp.get(ip) ?? 1) - 1;
      if (n > 0) voiceByIp.set(ip, n);
      else voiceByIp.delete(ip);
    });
    attachVoice(ws, ip); // the visitor's key: its speech and questions are charged to it (lib/server/budget.ts)
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const why = crossSite("GET", path, req.headers as Record<string, string>, true, hops);
    if (why) {
      // Another site's page must not open Arc's voice (it would spend the Gemini key from the owner's browser).
      console.log(`[origin] refused a WebSocket to ${path}: ${why}`);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    if (path === "/ws/voice") {
      const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops);
      if (limited && ((voiceByIp.get(ip) ?? 0) >= VOICE.perIp || voiceTotal >= VOICE.total)) {
        console.log(`[limits] ${logIp(ip)} voice refused (${voiceByIp.get(ip) ?? 0} open from this address, ${voiceTotal} in all)`);
        const say = voiceTotal >= VOICE.total ? SAY_BUSY : SAY_TABS;
        const body = JSON.stringify({ error: say, say });
        socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\nretry-after: 60\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        return;
      }
      voice.handleUpgrade(req, socket, head, (ws) => voice.emit("connection", ws, req));
    } else {
      handleUpgrade(req, socket, head); // Next dev hot reload
    }
  });

  server.listen(port, () => {
    console.log(`Arc ready on http://localhost:${port}${limited ? ` (visitor limits on, proxy hops ${hops})` : ""}`);
    warmAll(); // background only: requests are served while models and sessions load
    startJanitor(); // trims .cache folders to their caps now and hourly (lib/server/janitor.ts)
  });
});
