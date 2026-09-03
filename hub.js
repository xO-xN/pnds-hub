#!/usr/bin/env node
/**
 * PNDS telematic hub — the center of a star topology, deployed on a
 * public VPS. Sites (each a Mac running PNDS App with a telematic
 * score project) connect outbound and exchange messages through it.
 *
 * Design principle: the hub is deliberately dumb. It authenticates,
 * groups clients into rooms, echoes, and relays with stamps. It never
 * interprets payloads, aggregates metrics, or keeps state — every
 * client holds its own full picture of the network.
 *
 * What it does not carry: audio. Inter-site real-time audio is the
 * job of external tooling (e.g. JackTrip); this relay carries
 * control/data messages only.
 *
 * Protocol (see "Protocol quick reference" in README.md):
 *   Handshake auth:  { token, room?, node? } — the token rides the
 *                    auth field, never the URL query string.
 *   Server emits:    welcome { room, node, hubTime }
 *   Client emits:    echo  <any JSON> → stamped, sent back to the
 *                                      sender (RTT probing)
 *                    relay <any JSON> → stamped, forwarded to every
 *                                      other client in the room
 *   Stamps:          from          = authenticated sender name
 *                                   (hub-authoritative, always
 *                                   overwritten — not spoofable)
 *                    hubReceivedAt = hub receive time (always
 *                                   overwritten)
 *   Auth failure:    connect_error, message "invalid hub token"
 *
 * Environment variables (hub.env under systemd):
 *   HUB_TOKEN  required — shared secret for all sites.
 *              Generate with: openssl rand -hex 24
 *   HUB_PORT   optional, default 4000
 *   HUB_HOST   optional, default 0.0.0.0 (hub.env sets 127.0.0.1 so
 *              the hub is reached through a TLS reverse proxy)
 *
 * Production: install.sh / update.sh manage the systemd service.
 */

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { Server } = require("socket.io");

const VERSION = require("./package.json").version;
const DEFAULT_ROOM = "default";
const ROOM_MAX = 128; // room name limit, in characters
const NODE_MAX = 64; // node display-name limit, in characters

/**
 * Constant-time token comparison: hash both sides with SHA-256 first
 * (equalizing length, which timingSafeEqual requires), then compare.
 */
function tokenMatches(actual, expected) {
  const a = crypto.createHash("sha256").update(String(actual), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Name sanitization, shared by rooms and node names: non-strings and
 * blank-after-trim values return null (callers fall back to their
 * defaults); overlong values are truncated.
 */
function sanitizeName(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Stamp an outbound payload. Plain objects are shallow-copied; arrays
 * and primitives are wrapped as { value }. `from` and `hubReceivedAt`
 * are force-overwritten — the hub is the single authority for both
 * keys, so sender-supplied values never survive.
 */
function stampedBody(payload, from, receivedAt) {
  const body =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? { ...payload }
      : { value: payload };
  body.from = from;
  body.hubReceivedAt = receivedAt;
  return body;
}

/** Attach the hub to an http server. Returns the socket.io Server. */
function attachHub(httpServer, token, { log = (...a) => console.log("[hub]", ...a) } = {}) {
  const io = new Server(httpServer, {
    // Sites are Node processes connecting server-to-server; allow all
    // origins so browser clients may connect directly as well.
    cors: { origin: "*" },
  });

  // Auth middleware: a mismatched token rejects the connection — the
  // client sees connect_error("invalid hub token").
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (!tokenMatches(auth.token, token)) {
      return next(new Error("invalid hub token"));
    }
    socket.data.room = sanitizeName(auth.room, ROOM_MAX) || DEFAULT_ROOM;
    socket.data.node = sanitizeName(auth.node, NODE_MAX) || socket.id;
    next();
  });

  io.on("connection", (socket) => {
    const { room, node } = socket.data;
    socket.join(room);
    socket.emit("welcome", { room, node, hubTime: Date.now() });
    log(`join  room=${room} node=${node} id=${socket.id}`);

    // RTT echo: the client sends { seq, sentAt } and computes RTT from
    // its own clock; the hub just stamps and returns — it never times
    // or interprets anything.
    socket.on("echo", (payload) => {
      socket.emit("echo", stampedBody(payload, node, Date.now()));
    });

    // Room broadcast: every other client in the same room. Telemetry
    // clients relay one small stats snapshot per second; other
    // projects may relay whatever JSON they like.
    socket.on("relay", (payload) => {
      socket.to(room).emit("relay", stampedBody(payload, node, Date.now()));
    });

    socket.on("disconnect", (reason) => {
      log(`leave room=${room} node=${node} id=${socket.id} reason=${reason}`);
    });
  });

  return io;
}

function main() {
  const token = process.env.HUB_TOKEN;
  if (!token || !token.trim()) {
    console.error("[hub] HUB_TOKEN is required — generate one with: openssl rand -hex 24");
    process.exit(1);
  }
  const port = Number(process.env.HUB_PORT || 4000);
  const host = process.env.HUB_HOST || "0.0.0.0";

  // Plain-text health check: hitting the port in a browser (or an
  // uptime probe) confirms the hub process is alive and reports the
  // running version — the fastest way to verify an update landed.
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`PNDS telematic hub v${VERSION}\n`);
  });

  const io = attachHub(httpServer, token);

  httpServer.listen(port, host, () => {
    console.log(`[hub] PNDS telematic hub v${VERSION} listening on ${host}:${port}`);
  });

  // Graceful shutdown: close socket.io, then the http server; a 2 s
  // fallback exit covers sockets that refuse to drain (systemd
  // restarts the unit anyway).
  const shutdown = (signal) => {
    console.log(`[hub] ${signal} received, closing…`);
    io.close();
    httpServer.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) main();

// Exported for testing.
module.exports = { attachHub, sanitizeName, tokenMatches, stampedBody, DEFAULT_ROOM };
