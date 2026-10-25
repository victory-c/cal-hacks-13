#!/usr/bin/env node
// Static server for web/dist, node:http only (same shape as status/serve.mjs). Runs through tsx
// so it can read .env with @canon/shared's loadEnv():  node --import tsx scripts/serve.mjs
// Port: WEB_PORT, default 4200. Every response is no-store: dist/ is rebuilt all weekend.
// Also serves /bench/<name>.json from <repo>/bench/results/: the counter's "vs full history" slot
// reads latest.json there (lane A's `npm run run -w bench` writes it). Same origin, so the Canon
// server needs no bench route. Top-level *.json only: results/raw/ holds full transcripts.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORTS, REPO_ROOT, env, loadEnv } from "@canon/shared";

loadEnv();

const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const benchResults = resolve(REPO_ROOT, "bench", "results");
const BENCH_PREFIX = "/bench/";
const port = Number(env("WEB_PORT", String(DEFAULT_PORTS.web)));

if (!Number.isInteger(port) || port <= 0) {
  console.error(`web: WEB_PORT must be a port number (got "${env("WEB_PORT")}")`);
  process.exit(1);
}
if (!existsSync(join(dist, "index.html"))) {
  console.error(`web: nothing to serve, ${dist} has no index.html.\n     Build first: npm run build -w web   (or npm run dev -w web, which builds, watches and serves)`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
    return;
  }
  let root = dist;
  let rel = pathname === "/" ? "index.html" : pathname;
  if (pathname.startsWith(BENCH_PREFIX)) {
    const name = pathname.slice(BENCH_PREFIX.length);
    if (!/^[\w.-]+\.json$/.test(name)) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${pathname} (only /bench/<name>.json from bench/results/)`);
      return;
    }
    root = benchResults;
    rel = name;
  }
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${pathname}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`web: port ${port} is already in use. Stop the other process or set WEB_PORT in .env.`);
  else console.error("web:", err);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`web → http://localhost:${port}`);
});
