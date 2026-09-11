import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.env.SITE_ROOT || ".");
const PORT = Number(process.env.PORT || 8199);
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startServer({ root = ROOT, port = PORT } = {}) {
  const base = resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const decoded = decodeURIComponent(url.pathname);
      let relative = normalize(decoded).replace(/^[/\\]+/, "");
      if (!relative || decoded.endsWith("/")) relative = join(relative, "index.html");
      let path = resolve(base, relative);
      if (path !== base && !path.startsWith(base + "/")) throw new Error("Invalid path");
      try {
        if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      } catch {}
      const data = await readFile(path);
      response.writeHead(200, {
        "content-type": TYPES[extname(path)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(data);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveStart(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const server = await startServer();
  const address = server.address();
  console.log(`ShadowBench: http://127.0.0.1:${address.port}`);
}
