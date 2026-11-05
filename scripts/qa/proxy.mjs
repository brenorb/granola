// TLS front door for Granola QA. Chromium maps every production hostname to
// this port, so the production build runs unchanged while all traffic stays
// on local services. A control port injects outages and socket drops.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const PORT = Number(process.env.PROXY_PORT ?? 8443);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8444);
const QA_ROOT = process.env.QA_ROOT ?? "/tmp/granola-qa";
const DIST = process.env.DIST ?? new URL("../../dist", import.meta.url).pathname;
const TLS = `${QA_ROOT}/tls`;

const backends = {
  "testnut.cashu.space": 3338,
  "testnut.cashudevkit.org": 3339,
  "nos.lol": 7001,
  "relay.primal.net": 7002,
  "offchain.pub": 7003,
  "auth.nostr1.com": 7004
};

// host -> { mode: "down" | "slow", delayMs }
const faults = new Map();
const sockets = new Map(); // host -> Set<socket>
const stats = new Map();

function count(host, kind) {
  const key = `${host} ${kind}`;
  stats.set(key, (stats.get(key) ?? 0) + 1);
}

function track(host, socket) {
  if (!sockets.has(host)) sockets.set(host, new Set());
  sockets.get(host).add(socket);
  socket.on("close", () => sockets.get(host)?.delete(socket));
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function serveStatic(req, res) {
  const url = new URL(req.url, "https://brenorb.com");
  if (url.pathname === "/granola") {
    res.writeHead(301, { location: "/granola/" });
    return res.end();
  }
  if (!url.pathname.startsWith("/granola/")) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  let rel = decodeURIComponent(url.pathname.slice("/granola/".length));
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<h1>404</h1>");
  }
  res.writeHead(200, {
    "content-type": types[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "max-age=600",
    "x-content-type-options": "nosniff"
  });
  fs.createReadStream(file).pipe(res);
}

async function applyFault(host) {
  const fault = faults.get(host);
  if (!fault) return true;
  if (fault.mode === "down") return false;
  if (fault.mode === "slow") await new Promise((r) => setTimeout(r, fault.delayMs ?? 3000));
  return true;
}

const server = https.createServer({
  key: fs.readFileSync(`${TLS}/key.pem`),
  cert: fs.readFileSync(`${TLS}/cert.pem`)
}, async (req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  count(host, `${req.method}`);
  if (host === "brenorb.com") return serveStatic(req, res);
  const port = backends[host];
  if (!port) {
    res.writeHead(502);
    return res.end("unknown host");
  }
  if (!(await applyFault(host))) {
    req.socket.destroy();
    return;
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: req.headers.host }
  }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on("upgrade", async (req, socket, head) => {
  const host = (req.headers.host ?? "").split(":")[0];
  count(host, "WS");
  const port = backends[host];
  if (!port || !(await applyFault(host))) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(port, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  track(host, socket);
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
});

server.listen(PORT, "127.0.0.1", () => console.log(`proxy on ${PORT}`));

http.createServer((req, res) => {
  const url = new URL(req.url, "http://control");
  const host = url.searchParams.get("host");
  if (url.pathname === "/fault" && host) {
    const mode = url.searchParams.get("mode");
    if (mode === "up") faults.delete(host);
    else faults.set(host, { mode, delayMs: Number(url.searchParams.get("delayMs") ?? 3000) });
    if (mode === "down") for (const s of sockets.get(host) ?? []) s.destroy();
    res.end(JSON.stringify({ host, mode }));
    return;
  }
  if (url.pathname === "/drop" && host) {
    const set = sockets.get(host) ?? new Set();
    const n = set.size;
    for (const s of set) s.destroy();
    res.end(JSON.stringify({ host, dropped: n }));
    return;
  }
  if (url.pathname === "/stats") {
    res.end(JSON.stringify(Object.fromEntries(stats), null, 1));
    return;
  }
  if (url.pathname === "/reset") {
    faults.clear();
    stats.clear();
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(CONTROL_PORT, "127.0.0.1", () => console.log(`control on ${CONTROL_PORT}`));
