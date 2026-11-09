"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GeoLookup,
  normalizeIp,
  isPublicIp,
  trustedProxyList,
  observedPublicIp,
  normalizeLocation,
  configuredHubLocation,
  locationFromResponse,
  socketNetwork,
} = require("../lib/network-location");

const response = (ip, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ ip, city: "Example", lat: 0, lon: 0, ...extra }),
});
const fakeSocket = (ip, forwarded) => ({
  request: {
    socket: { remoteAddress: ip },
    headers: { "x-forwarded-for": forwarded },
  },
  handshake: { address: "1.1.1.1", auth: { ip: "1.1.1.1" } },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("IP normalization handles v4-mapped addresses and exact IPv6 equivalents", () => {
  assert.equal(normalizeIp(" ::ffff:8.8.8.8 "), "8.8.8.8");
  assert.equal(normalizeIp("::ffff:808:808"), "8.8.8.8");
  assert.equal(normalizeIp("0:0:0:0:0:0:0:1"), "::1");
  for (const invalid of [
    null,
    {},
    "8.8.8.8:80",
    "127.0.0.1/8",
    "fe80::1%en0",
    "x",
  ]) {
    assert.equal(normalizeIp(invalid), null);
  }
  assert.deepEqual(
    trustedProxyList("::ffff:127.0.0.1, ::1,127.0.0.1,garbage,10.0.0.0/8"),
    ["127.0.0.1", "::1"],
  );
});

test("private, loopback, documentation, multicast and bogon addresses are never public", () => {
  for (const ip of [
    "0.1.2.3",
    "10.2.3.4",
    "100.64.1.2",
    "100.127.255.255",
    "127.1.2.3",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.168.1.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.8",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::808:808",
    "2001::1",
    "2001:db8::1",
    "2002:808:808::1",
    "3fff::1",
    "::ffff:192.168.1.1",
  ])
    assert.equal(isPublicIp(ip), false, ip);
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicIp(ip), true, ip);
});

test("forwarded addresses require an exact trusted TCP peer and use only the final entry", () => {
  assert.equal(observedPublicIp(fakeSocket("8.8.8.8", "1.1.1.1")), "8.8.8.8");
  assert.equal(observedPublicIp(fakeSocket("127.0.0.1", "1.1.1.1")), null);
  assert.equal(
    observedPublicIp(fakeSocket("::ffff:127.0.0.1", "1.1.1.1, 8.8.8.8"), [
      "127.0.0.1",
    ]),
    "8.8.8.8",
  );
  assert.equal(
    observedPublicIp(fakeSocket("127.0.0.2", "8.8.8.8"), ["127.0.0.1"]),
    null,
  );
  assert.equal(
    observedPublicIp(fakeSocket("127.0.0.1", "8.8.8.8, invalid"), [
      "127.0.0.1",
    ]),
    null,
  );
  assert.equal(
    observedPublicIp(fakeSocket("127.0.0.1", ["8.8.8.8"]), ["127.0.0.1"]),
    null,
  );
  assert.equal(observedPublicIp({ handshake: { address: "8.8.8.8" } }), null);
});

test("location validation retains valid zero coordinates and rejects coercion/non-finite data", () => {
  assert.deepEqual(
    normalizeLocation(
      { label: " Zero ", latitude: 0, longitude: 0, source: "ip" },
      "manual",
    ),
    { label: "Zero", latitude: 0, longitude: 0, source: "manual" },
  );
  for (const input of [
    null,
    [],
    { latitude: "0", longitude: 0 },
    { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
  ]) {
    assert.equal(normalizeLocation(input, "manual"), null);
  }
  assert.equal(configuredHubLocation({}), null);
  assert.equal(
    configuredHubLocation({
      HUB_LOCATION_LATITUDE: "",
      HUB_LOCATION_LONGITUDE: "0",
    }),
    null,
  );
  assert.deepEqual(
    configuredHubLocation({
      HUB_LOCATION_LABEL: "Configured",
      HUB_LOCATION_LATITUDE: "0",
      HUB_LOCATION_LONGITUDE: "0",
    }),
    { label: "Configured", latitude: 0, longitude: 0, source: "configured" },
  );
});

test("both anonymous and keyed provider formats are validated against the requested IP", () => {
  const expected = {
    label: "City · Region · Country",
    latitude: 0,
    longitude: 0,
    source: "ip",
    provider: "ipapi.is",
  };
  assert.deepEqual(
    locationFromResponse(
      {
        ip: "8.8.8.8",
        city: "City",
        region: "Region",
        country: "Country",
        lat: 0,
        lon: 0,
      },
      "8.8.8.8",
    ),
    expected,
  );
  assert.deepEqual(
    locationFromResponse(
      {
        ip: "8.8.8.8",
        location: {
          city: "City",
          state: "Region",
          country: "Country",
          latitude: 0,
          longitude: 0,
        },
      },
      "8.8.8.8",
    ),
    expected,
  );
  for (const body of [
    { ip: "1.1.1.1", lat: 0, lon: 0 },
    { ip: "8.8.8.8", lat: "0", lon: 0 },
    { ip: "8.8.8.8", lat: 0, lon: 0, is_bogon: true },
    { ip: "8.8.8.8", error: "refused" },
  ]) {
    assert.equal(locationFromResponse(body, "8.8.8.8"), null);
  }
});

test("lookup caches successes for 24h, deduplicates requests and keeps key out of the URL", async () => {
  let now = Date.UTC(2026, 10, 9);
  const requests = [];
  const lookup = new GeoLookup({
    apiKey: "test-only-key",
    now: () => now,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(JSON.parse(options.body).q);
    },
  });
  const [first, same] = await Promise.all([
    lookup.lookup("8.8.8.8"),
    lookup.lookup("::ffff:8.8.8.8"),
  ]);
  assert.deepEqual(first, same);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.ipapi.is/");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    q: "8.8.8.8",
    key: "test-only-key",
  });
  assert.equal(requests[0].options.redirect, "error");
  now += 24 * 60 * 60 * 1000 - 1;
  await lookup.lookup("8.8.8.8");
  assert.equal(requests.length, 1);
  now += 2;
  await lookup.lookup("8.8.8.8");
  assert.equal(requests.length, 2);
});

test("lookup never submits non-public addresses and backs off failures for five minutes", async () => {
  let now = 0,
    calls = 0;
  const lookup = new GeoLookup({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  await lookup.lookup("127.0.0.1");
  await lookup.lookup("192.0.2.1");
  assert.equal(calls, 0);
  assert.equal(await lookup.lookup("8.8.8.8"), null);
  assert.equal(calls, 1);
  now = 299999;
  await lookup.lookup("8.8.8.8");
  assert.equal(calls, 1);
  now = 300001;
  await lookup.lookup("8.8.8.8");
  assert.equal(calls, 2);
});

test("lookup caps anonymous UTC budget and resets it on the next day", async () => {
  let now = Date.UTC(2026, 10, 9, 23, 59),
    calls = 0;
  const lookup = new GeoLookup({
    now: () => now,
    fetchImpl: async (_, options) => {
      calls += 1;
      return response(JSON.parse(options.body).q);
    },
  });
  for (let index = 0; index < 35; index += 1)
    await lookup.lookup(`8.8.0.${index}`);
  assert.equal(calls, 30);
  now += 61000;
  await lookup.lookup("8.8.0.31");
  assert.equal(calls, 31);
});

test("a key raises the local daily ceiling to 1000, with the same bounded cache", async () => {
  let calls = 0;
  const lookup = new GeoLookup({
    apiKey: "test-key",
    fetchImpl: async (_, options) => {
      calls += 1;
      return response(JSON.parse(options.body).q);
    },
  });
  for (let index = 0; index < 1002; index += 1)
    await lookup.lookup(`8.8.${index >> 8}.${index & 255}`);
  assert.equal(calls, 1000);
  assert.equal(lookup.cache.size, 512);
});

for (const status of [403, 429])
  test(`provider ${status} suspends all new lookups until UTC midnight`, async () => {
    let now = Date.UTC(2026, 10, 9, 23, 59),
      calls = 0;
    const lookup = new GeoLookup({
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status };
      },
    });
    await lookup.lookup("8.8.8.8");
    await lookup.lookup("1.1.1.1");
    assert.equal(calls, 1);
    now += 61000;
    await lookup.lookup("1.1.1.1");
    assert.equal(calls, 2);
  });

test("timeout aborts a stuck provider and returns unknown without hanging the caller", async () => {
  let signal;
  const lookup = new GeoLookup({
    timeoutMs: 10,
    fetchImpl: (_, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(await lookup.lookup("8.8.8.8"), null);
  assert.equal(signal.aborted, true);
});

test("concurrency, queued requests and LRU cache remain bounded", async () => {
  const waiting = [];
  let active = 0,
    highest = 0;
  const lookup = new GeoLookup({
    concurrency: 2,
    queueLimit: 3,
    cacheLimit: 2,
    fetchImpl: (_, options) => {
      active += 1;
      highest = Math.max(active, highest);
      return new Promise((resolve) =>
        waiting.push(() => {
          active -= 1;
          resolve(response(JSON.parse(options.body).q));
        }),
      );
    },
  });
  const promises = [
    lookup.lookup("8.8.8.1"),
    lookup.lookup("8.8.8.2"),
    lookup.lookup("8.8.8.3"),
  ];
  assert.equal(await lookup.lookup("8.8.8.4"), null);
  assert.equal(active, 2);
  assert.equal(lookup.pending.size, 3);
  waiting.shift()();
  await tick();
  waiting.shift()();
  await tick();
  waiting.shift()();
  await Promise.all(promises);
  await tick();
  assert.equal(highest, 2);
  assert.equal(lookup.pending.size, 0);
  assert.equal(lookup.cache.size, 2);
  assert.equal(lookup.cache.has("8.8.8.1"), false);
});

test("manual correction survives late automatic result; null clears it; closed sockets discard results", async () => {
  let finish;
  const updates = [];
  const session = socketNetwork(fakeSocket("8.8.8.8"), {
    lookup: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onUpdate: (value) => updates.push(value),
  });
  const resolving = session.resolve();
  assert.equal(
    session.setLocation({
      label: "Actual venue",
      latitude: 0,
      longitude: 0,
      source: "configured",
    }),
    true,
  );
  finish({
    label: "IP estimate",
    latitude: 1,
    longitude: 2,
    source: "ip",
    provider: "ipapi.is",
  });
  await resolving;
  assert.equal(session.snapshot().location.source, "manual");
  assert.equal(session.snapshot().location.latitude, 0);
  assert.equal(session.setLocation({ latitude: "0", longitude: 0 }), false);
  assert.equal(session.setLocation(null), true);
  assert.equal(session.snapshot().location.source, "ip");
  assert.equal(updates.length, 3);
  const detachedUpdates = [];
  const detached = socketNetwork(fakeSocket("8.8.8.8"), {
    lookup: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onUpdate: (value) => detachedUpdates.push(value),
  });
  const pending = detached.resolve();
  detached.close();
  finish({ label: "stale", latitude: 0, longitude: 0, source: "ip" });
  await pending;
  assert.equal(detachedUpdates.length, 0);
  assert.equal(detached.setLocation(null), false);
});
