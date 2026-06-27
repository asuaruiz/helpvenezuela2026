// Servidor estático mínimo con MIME correcto + gzip (para que el service worker funcione
// y se ahorren datos en la transferencia del shell).
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { extname, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd());
const PORT = process.env.PORT || 8787;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };

function send(req, res, path, noStore) {
  const buf = readFileSync(path);
  const type = MIME[extname(path)] || "application/octet-stream";
  const accepts = (req.headers["accept-encoding"] || "").includes("gzip");
  const head = { "Content-Type": type, "Cache-Control": noStore ? "no-cache" : "public, max-age=300" };
  if (accepts && buf.length > 600) {
    res.writeHead(200, { ...head, "Content-Encoding": "gzip" });
    res.end(gzipSync(buf));
  } else {
    res.writeHead(200, head);
    res.end(buf);
  }
}

http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split("?")[0]);
  if (f === "/") f = "/index.html";
  const path = resolve(ROOT, "." + f);
  if (path !== ROOT && !path.startsWith(ROOT + sep)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    statSync(path);
    send(req, res, path, f === "/sw.js" || extname(path) === ".html");
  } catch {
    // SPA fallback: las rutas con slug (/ver-todos, /resumen, /ficha/<slug>/<id>, …) no son
    // archivos reales; sirven el shell index.html para que el ruteo del cliente las resuelva.
    if (!extname(f)) {
      try { send(req, res, resolve(ROOT, "./index.html"), true); return; } catch {}
    }
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
