"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { io: client } = require("socket.io-client");
const { attachHub, stampedBody } = require("../hub");
const { GeoLookup } = require("../lib/network-location");

const TOKEN = "fixture-only-hub-token";

async function startHub(t, options = {}) {
  const server = http.createServer();
  const io = attachHub(server, TOKEN, {
    log() {},
    geoLookup: { lookup: async () => null },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
  });
  return {
    connect({ node = "self", room = "room", token = TOKEN, headers } = {}) {
      const socket = client(`http://127.0.0.1:${server.address().port}`, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        auth: { token, room, node },
        extraHeaders: headers,
      });
      sockets.push(socket);
      const welcome = once(socket, "welcome").then(([value]) => value);
      socket.connect();
      return { socket, welcome };
    },
  };
}

const ack = (socket, event, body) =>
  new Promise((resolve, reject) => {
    socket
      .timeout(1000)
      .emit(event, body, (error, value) =>
        error ? reject(error) : resolve(value),
      );
  });
const receive = (socket, event) => once(socket, event).then(([body]) => body);

test(
  "legacy echo/relay and auth work on a real loopback server without any location requests",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const hub = await startHub(t, {
      geoLookup: {
        lookup: async () => {
          calls += 1;
          return null;
        },
      },
    });
    const a = hub.connect({
      node: "a",
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    const b = hub.connect({ node: "b" });
    const other = hub.connect({ node: "other", room: "other-room" });
    const [welcome] = await Promise.all([a.welcome, b.welcome, other.welcome]);
    assert.equal(welcome.node, "a");
    assert.equal(welcome.room, "room");
    assert.equal(typeof welcome.hubTime, "number");
    assert.deepEqual(welcome.network, {
      ip: null,
      location: null,
      hubLocation: null,
      manualLocationSupported: true,
    });
    assert.equal(calls, 0, "an untrusted XFF must never trigger a lookup");
    const echo = receive(a.socket, "echo");
    a.socket.emit("echo", { seq: 1, from: "forged", hubReceivedAt: -1 });
    const echoed = await echo;
    assert.equal(echoed.seq, 1);
    assert.equal(echoed.from, "a");
    assert.ok(echoed.hubReceivedAt > 0);
    let wrongRoom = 0,
      senderEcho = 0;
    other.socket.on("relay", () => {
      wrongRoom += 1;
    });
    a.socket.on("relay", () => {
      senderEcho += 1;
    });
    const relayed = receive(b.socket, "relay");
    a.socket.emit("relay", {
      type: "custom",
      network: { custom: true },
      from: "forged",
    });
    const body = await relayed;
    assert.deepEqual(body.network, { custom: true });
    assert.equal(body.from, "a");
    assert.equal(wrongRoom, 0);
    assert.equal(senderEcho, 0);
    const bad = hub.connect({ token: "wrong-test-token" });
    const [error] = await once(bad.socket, "connect_error");
    assert.equal(error.message, "invalid hub token");
    assert.equal(calls, 0);
  },
);

test(
  "welcome is immediate; lookup updates metadata; manual zero-coordinate correction and clear are acknowledged",
  { timeout: 5000 },
  async (t) => {
    let resolveLookup,
      calls = 0;
    const hub = await startHub(t, {
      environment: {
        HUB_TRUST_PROXY: "127.0.0.1",
        HUB_LOCATION_LABEL: "Deployment",
        HUB_LOCATION_LATITUDE: "0",
        HUB_LOCATION_LONGITUDE: "0",
      },
      geoLookup: {
        lookup: () => {
          calls += 1;
          return new Promise((resolve) => {
            resolveLookup = resolve;
          });
        },
      },
    });
    const a = hub.connect({
      node: "a",
      headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8" },
    });
    const b = hub.connect({ node: "b" });
    const welcome = await a.welcome;
    await b.welcome;
    assert.equal(welcome.network.ip, "8.8.8.8");
    assert.equal(welcome.network.location, null);
    assert.deepEqual(welcome.network.hubLocation, {
      label: "Deployment",
      latitude: 0,
      longitude: 0,
      source: "configured",
    });
    assert.equal(calls, 1);
    const echo = receive(a.socket, "echo");
    a.socket.emit("echo", { seq: 10 });
    assert.equal((await echo).seq, 10, "pending lookup cannot block echo");
    const initialRelay = receive(b.socket, "relay");
    a.socket.emit("relay", {
      type: "tnd-stats",
      network: { ip: "forged", location: { latitude: 90 } },
    });
    assert.equal((await initialRelay).network.ip, "8.8.8.8");
    const manualEvent = receive(a.socket, "network");
    assert.deepEqual(
      await ack(a.socket, "location", {
        label: "Venue",
        latitude: 0,
        longitude: 0,
        source: "configured",
        provider: "forged",
      }),
      { ok: true },
    );
    assert.deepEqual((await manualEvent).location, {
      label: "Venue",
      latitude: 0,
      longitude: 0,
      source: "manual",
    });
    assert.deepEqual(
      await ack(a.socket, "location", {
        label: "invalid",
        latitude: "0",
        longitude: 0,
      }),
      { ok: false },
    );
    const automaticEvent = receive(a.socket, "network");
    resolveLookup({
      label: "Estimate",
      latitude: 1,
      longitude: 2,
      source: "ip",
      provider: "ipapi.is",
    });
    assert.equal(
      (await automaticEvent).location.source,
      "manual",
      "late lookup cannot overwrite manual correction",
    );
    const manualRelay = receive(b.socket, "relay");
    a.socket.emit("relay", { type: "tnd-stats", network: null });
    assert.equal((await manualRelay).network.location.label, "Venue");
    const cleared = receive(a.socket, "network");
    assert.deepEqual(await ack(a.socket, "location", null), { ok: true });
    assert.equal((await cleared).location.source, "ip");
  },
);

test(
  "reconnect reuses IP cache but never inherits another socket's manual correction",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const geoLookup = new GeoLookup({
      fetchImpl: async (_, options) => {
        calls += 1;
        return {
          status: 200,
          ok: true,
          json: async () => ({
            ip: JSON.parse(options.body).q,
            city: "Cached",
            lat: 10,
            lon: 20,
          }),
        };
      },
    });
    const hub = await startHub(t, {
      environment: { HUB_TRUST_PROXY: "127.0.0.1" },
      geoLookup,
    });
    const a = hub.connect({
      node: "a",
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    const updates = receive(a.socket, "network");
    await a.welcome;
    assert.equal((await updates).location.label, "Cached");
    await ack(a.socket, "location", {
      label: "Manual",
      latitude: 0,
      longitude: 0,
    });
    a.socket.disconnect();
    const again = hub.connect({
      node: "a",
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    const reused = receive(again.socket, "network");
    await again.welcome;
    assert.equal((await reused).location.label, "Cached");
    assert.equal(calls, 1);
  },
);

test("legacy payload wrapping and authoritative stamps are unchanged", () => {
  assert.deepEqual(stampedBody([1, 2], "node", 42), {
    value: [1, 2],
    from: "node",
    hubReceivedAt: 42,
  });
  assert.deepEqual(stampedBody(null, "node", 42), {
    value: null,
    from: "node",
    hubReceivedAt: 42,
  });
  assert.deepEqual(
    stampedBody({ from: "spoof", hubReceivedAt: -1 }, "node", 42),
    { from: "node", hubReceivedAt: 42 },
  );
});
