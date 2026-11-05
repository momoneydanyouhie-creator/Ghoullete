// Ghoulette matchmaking + static server. Video flows peer-to-peer (WebRTC);
// this server only pairs people and relays connection messages and chat text.
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = [path.join(dir, "public", "index.html"), path.join(dir, "index.html")].find(fs.existsSync);
const html = fs.readFileSync(htmlPath);

// STUN is free; add a TURN relay via env vars so strict networks can connect.
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(","),
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS,
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/ice") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ iceServers }));
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": "camera=(self), microphone=(self)",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const DAY = 24 * 60 * 60 * 1000;
const bans = new Map();      // ip -> expiry timestamp
const reports = new Map();   // reported ip -> Map(reporter ip -> timestamp)
const perIp = new Map();     // ip -> open connection count
let queue = [];
let nextId = 1;

const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const clean = (s) => String(s || "").replace(/[^\w \-]/g, "").trim().slice(0, 16) || "Stranger";

function leave(ws) {
  queue = queue.filter((c) => c !== ws);
  const p = ws.partner;
  if (p) { ws.partner = null; p.partner = null; send(p, { t: "bye" }); }
}

function pair(ws) {
  queue = queue.filter((c) => c.readyState === 1 && c !== ws);
  ws.since = Date.now();
  queue.push(ws);
  match();
}

// Pair people who are waiting. A skipped stranger is avoided for 30s, unless
// both have waited 8s+ (so two testers never get stuck forever).
function match() {
  const now = Date.now();
  queue = queue.filter((c) => c.readyState === 1);
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i], b = queue[j];
      if (a.noMatch.has(b.id) || b.noMatch.has(a.id)) continue; // reported
      const skipped = a.avoid.get(b.id) > now || b.avoid.get(a.id) > now;
      if (skipped && now - Math.max(a.since, b.since) < 8000) continue;
      queue = queue.filter((c) => c !== a && c !== b);
      a.partner = b; b.partner = a;
      send(a, { t: "matched", initiator: true, n: b.nick });
      send(b, { t: "matched", initiator: false, n: a.nick });
      return match();
    }
  }
}

function report(ws) {
  const p = ws.partner;
  if (!p) return;
  ws.noMatch.add(p.id);
  let m = reports.get(p.ip);
  if (!m) reports.set(p.ip, (m = new Map()));
  m.set(ws.ip, Date.now());
  for (const [k, t] of m) if (Date.now() - t > DAY) m.delete(k);
  if (m.size >= 3) { // three different people reported them: 24h ban
    bans.set(p.ip, Date.now() + DAY);
    send(p, { t: "banned" });
    p.close();
  }
  leave(ws);
}

wss.on("connection", (ws, req) => {
  ws.ip = ipOf(req);
  if ((bans.get(ws.ip) || 0) > Date.now()) { send(ws, { t: "banned" }); return ws.close(); }
  const open = (perIp.get(ws.ip) || 0) + 1;
  if (open > 4) return ws.close();
  perIp.set(ws.ip, open);
  Object.assign(ws, { id: nextId++, avoid: new Map(), noMatch: new Set(), since: 0, partner: null, nick: "Stranger", win: 0, n: 0, alive: true });
  send(ws, { t: "count", n: wss.clients.size });

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.win > 1000) { ws.win = now; ws.n = 0; }
    if (++ws.n > 60) return; // flood guard
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;
    switch (m.t) {
      case "search": leave(ws); ws.nick = clean(m.n); pair(ws); break;
      case "skip": {
        const p = ws.partner;
        if (p) { ws.avoid.set(p.id, now + 30000); p.avoid.set(ws.id, now + 30000); }
        leave(ws); break;
      }
      case "offer": case "answer": case "ice":
        if (ws.partner && m.d && JSON.stringify(m.d).length < 8000) send(ws.partner, { t: m.t, d: m.d });
        break;
      case "chat":
        if (ws.partner && typeof m.d === "string") send(ws.partner, { t: "chat", d: m.d.slice(0, 300) });
        break;
      case "report": report(ws); break;
      case "bye": leave(ws); break;
    }
  });
  ws.on("close", () => {
    leave(ws);
    const left = (perIp.get(ws.ip) || 1) - 1;
    if (left <= 0) perIp.delete(ws.ip); else perIp.set(ws.ip, left);
  });
});

// drop dead connections, share the live count
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);
setInterval(match, 2000);
setInterval(() => {
  const n = wss.clients.size;
  for (const ws of wss.clients) send(ws, { t: "count", n });
}, 5000);

server.listen(PORT, () => console.log("Ghoulette is haunting port " + PORT));
