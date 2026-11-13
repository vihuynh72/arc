// One process, one port: Next and the /ws/voice WebSocket. Run with `tsx server.ts`.
import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { attachVoice } from "./lib/server/live";

try {
  process.loadEnvFile(".env.local");
} catch {
  // missing .env.local is fine until a feature needs a key
}

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname: "localhost", port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler();
  const server = createServer((req, res) => handle(req, res));

  const voice = new WebSocketServer({ noServer: true });
  voice.on("connection", (ws) => attachVoice(ws));

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/ws/voice") {
      voice.handleUpgrade(req, socket, head, (ws) => voice.emit("connection", ws, req));
    } else {
      handleUpgrade(req, socket, head); // Next dev hot reload
    }
  });

  server.listen(port, () => console.log(`Arc ready on http://localhost:${port}`));
});
