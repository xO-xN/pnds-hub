"use strict";

const { isIP } = require("node:net");

function ipv6Number(ip) {
  const halves = ip.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function normalizeIp(value) {
  if (typeof value !== "string") return null;
  const ip = value.trim();
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6 || ip.includes("%")) return null;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const number = ipv6Number(canonical);
  if (number >> 32n === 0xffffn) {
    const low = Number(number & 0xffffffffn);
    return [24, 16, 8, 0].map((shift) => (low >>> shift) & 255).join(".");
  }
  return canonical;
}

function isPublicIp(value) {
  const ip = normalizeIp(value);
  if (!ip) return false;
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const number = ipv6Number(ip);
  // Only global unicast; exclude special-use, documentation and 6to4 ranges.
  return (
    number >> 125n === 1n &&
    number >> 105n !== ipv6Number("2001:0:0:0:0:0:0:0") >> 105n &&
    number >> 96n !== 0x20010db8n &&
    number >> 112n !== 0x2002n &&
    number >> 108n !== 0x3fff0n
  );
}

function trustedProxyList(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map(normalizeIp).filter(Boolean))];
}

function observedPublicIp(socket, trustedProxies = []) {
  // Read the TCP peer, never a client-supplied handshake/auth field.
  const remote = normalizeIp(socket.request?.socket?.remoteAddress);
  if (!remote) return null;
  let candidate = remote;
  if (trustedProxies.includes(remote)) {
    const forwarded = socket.request?.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string") {
      // A configured proxy must append the actual connecting IP. Ignore all
      // entries to its left: they may have been supplied by that client.
      candidate = normalizeIp(forwarded.split(",").at(-1));
    }
  }
  return isPublicIp(candidate) ? candidate : null;
}

function normalizeLocation(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { latitude, longitude } = value;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    return null;
  const label =
    typeof value.label === "string" ? value.label.trim().slice(0, 96) : "";
  return {
    label: label || `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
    latitude,
    longitude,
    source,
  };
}

function configuredHubLocation(environment) {
  const latitude = environment.HUB_LOCATION_LATITUDE;
  const longitude = environment.HUB_LOCATION_LONGITUDE;
  if (
    typeof latitude !== "string" ||
    !latitude.trim() ||
    typeof longitude !== "string" ||
    !longitude.trim()
  )
    return null;
  return normalizeLocation(
    {
      label: environment.HUB_LOCATION_LABEL,
      latitude: Number(latitude),
      longitude: Number(longitude),
    },
    "configured",
  );
}

function locationFromResponse(body, ip) {
  if (
    !body ||
    body.error ||
    body.is_bogon === true ||
    normalizeIp(body.ip) !== ip
  )
    return null;
  // Anonymous responses use flat lat/lon; keyed responses use location.*.
  const input =
    body.location && typeof body.location === "object" ? body.location : body;
  const parts = [input.city, input.state || input.region, input.country]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim());
  const location = normalizeLocation(
    {
      label: [...new Set(parts)].join(" · "),
      latitude: input.latitude ?? input.lat,
      longitude: input.longitude ?? input.lon,
    },
    "ip",
  );
  return location ? { ...location, provider: "ipapi.is" } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const nextUtcDay = (at) => (Math.floor(at / DAY_MS) + 1) * DAY_MS;

class GeoLookup {
  constructor({
    apiKey = "",
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = 2000,
    cacheLimit = 512,
    concurrency = 2,
    queueLimit = 64,
  } = {}) {
    this.apiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cacheLimit = cacheLimit;
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.running = 0;
    this.budgetDay = Math.floor(now() / DAY_MS);
    this.used = 0;
    this.blockedUntil = 0;
  }

  lookup(value) {
    const ip = normalizeIp(value);
    if (!isPublicIp(ip)) return Promise.resolve(null);
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAt > this.now()) {
      this.cache.delete(ip);
      this.cache.set(ip, cached);
      return Promise.resolve(cached.location ? { ...cached.location } : null);
    }
    this.cache.delete(ip);
    if (this.pending.has(ip)) return this.pending.get(ip);
    if (this.pending.size >= this.queueLimit) return Promise.resolve(null);
    let finish;
    const promise = new Promise((resolve) => {
      finish = resolve;
    });
    this.pending.set(ip, promise);
    this.queue.push({ ip, finish });
    this.drain();
    return promise;
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const { ip, finish } = this.queue.shift();
      this.running += 1;
      this.query(ip)
        .then(
          ({ location, expiresAt }) => {
            this.cache.set(ip, { location, expiresAt });
            while (this.cache.size > this.cacheLimit)
              this.cache.delete(this.cache.keys().next().value);
            return location;
          },
          () => null,
        )
        .then((location) => {
          this.pending.delete(ip);
          this.running -= 1;
          finish(location ? { ...location } : null);
          this.drain();
        });
    }
  }

  async query(ip) {
    const at = this.now();
    const day = Math.floor(at / DAY_MS);
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.used = 0;
    }
    if (at < this.blockedUntil || this.used >= (this.apiKey ? 1000 : 30)) {
      return {
        location: null,
        expiresAt: Math.max(this.blockedUntil, nextUtcDay(at)),
      };
    }
    this.used += 1;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("lookup timeout"));
      }, this.timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await this.fetchImpl("https://api.ipapi.is/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: ip,
            ...(this.apiKey ? { key: this.apiKey } : {}),
          }),
          signal: controller.signal,
          redirect: "error",
        });
        if (response.status === 429 || response.status === 403) {
          // Shared NAT/account budgets can be exhausted outside this process.
          // Stop every new lookup until UTC midnight; never hammer a refusal.
          this.blockedUntil = nextUtcDay(this.now());
          return { location: null, expiresAt: this.blockedUntil };
        }
        if (!response.ok) throw new Error("lookup unavailable");
        const location = locationFromResponse(await response.json(), ip);
        return {
          location,
          expiresAt: this.now() + (location ? DAY_MS : FAILURE_BACKOFF_MS),
        };
      })();
      return await Promise.race([request, deadline]);
    } catch {
      return { location: null, expiresAt: this.now() + FAILURE_BACKOFF_MS };
    } finally {
      clearTimeout(timer);
    }
  }
}

function socketNetwork(
  socket,
  { lookup, trustedProxies = [], hubLocation = null, onUpdate },
) {
  const ip = observedPublicIp(socket, trustedProxies);
  let automatic = null;
  let manual = null;
  let closed = false;
  const snapshot = () => ({
    ip,
    location: manual ? { ...manual } : automatic ? { ...automatic } : null,
    hubLocation: hubLocation ? { ...hubLocation } : null,
    manualLocationSupported: true,
  });
  return {
    snapshot,
    setLocation(value) {
      if (closed) return false;
      const location =
        value === null ? null : normalizeLocation(value, "manual");
      if (value !== null && !location) return false;
      manual = location;
      onUpdate(snapshot());
      return true;
    },
    async resolve() {
      if (!ip) return;
      try {
        const location = await lookup(ip);
        if (closed) return;
        automatic = location;
        onUpdate(snapshot());
      } catch {
        /* A failed estimate never changes relay availability. */
      }
    },
    close() {
      closed = true;
    },
  };
}

module.exports = {
  normalizeIp,
  isPublicIp,
  trustedProxyList,
  observedPublicIp,
  normalizeLocation,
  configuredHubLocation,
  locationFromResponse,
  GeoLookup,
  socketNetwork,
};
