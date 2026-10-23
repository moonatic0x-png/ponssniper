import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config, log } from "../config.mjs";
import { getState, openDb, getCursor } from "../db/db.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startDash({
  host = config.dashHost,
  port = config.dashPort,
  readOnly = false,
  wallet = config.readAddress || null,
} = {}) {
  openDb();
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.pathname === "/api/state") {
        const state = getState();
        const heartbeat = getCursor("heartbeat");
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            ...state,
            live: config.live,
            readOnly: !!readOnly,
            wallet: wallet || null,
            heartbeat,
            ts: Date.now(),
          }),
        );
        return;
      }
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      let path = url.pathname === "/" ? "/index.html" : url.pathname;
      path = path.replace(/\.\./g, "");
      const file = join(PUBLIC, path);
      if (!file.startsWith(PUBLIC) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  });

  server.listen(port, host, () => {
    log(`[dash] http://${host}:${port}`);
  });
  return server;
}
