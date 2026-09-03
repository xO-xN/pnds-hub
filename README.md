# PNDS Telematic Hub

A single-file, token-authenticated Socket.IO relay for cross-internet PNDS
performances. Deployed once on a public VPS, it lets any number of PNDS sites
— each a Mac running PNDS App with a telematic score project — exchange
messages across the internet.

The hub is **deliberately dumb**: it authenticates, groups clients into rooms,
echoes, and relays with stamps. It never interprets payloads, aggregates
metrics, or keeps state. That keeps it cheap to run, trivial to operate, and
usable by any client that speaks the thin protocol below.

**It does not carry audio.** Inter-site real-time audio is carried by external
tooling (e.g. JackTrip); the hub carries control/data messages only.

## Architecture

```
Site A (Mac, PNDS App + score project) ──┐
Site B (Mac, PNDS App + score project) ──┼──►  pnds-hub (public VPS)
Site C (Mac, PNDS App + score project) ──┘
        outbound-only Socket.IO over wss://, token-authenticated
```

- Every connection is **outbound** from the sites — no port forwarding,
  works behind NAT on all sides.
- Clients in the same **room** see each other's relayed messages; rooms are
  fully isolated. One performance = one room.
- Performers' phones never touch the hub — they keep connecting to their
  local site over LAN.

## Requirements

- A Linux VPS with systemd (any small instance — see [Operations](#operations)).
- Node.js ≥ 18, npm, git (install Node via your distribution's package
  manager so systemd can find it).
- For production: a domain name pointed at the VPS, TLS terminated by a
  reverse proxy.

## Install

```bash
sudo git clone https://github.com/xO-xN/pnds-hub /opt/pnds-hub
cd /opt/pnds-hub
sudo ./install.sh
```

`install.sh`:

1. installs dependencies (`npm ci`),
2. generates `HUB_TOKEN` into `/opt/pnds-hub/hub.env` (`chmod 600`; an
   existing file is never overwritten, so reinstalls keep the token),
3. installs and starts the `pnds-hub` systemd service.

The script prints the token when it generates one — record it, every site
needs it. By default the hub listens on `127.0.0.1:4000` (loopback): it is
meant to be reached through a TLS reverse proxy (next section).

### Plain-WS quick test (no proxy yet)

For a rehearsal without a reverse proxy, edit `/opt/pnds-hub/hub.env`:

```
HUB_HOST=0.0.0.0
```

then `sudo systemctl restart pnds-hub`, open the port in the firewall, and
have sites connect to `ws://<vps-ip>:4000`. This is plaintext across the
public internet — fine for trying things out, not for a performance.

### TLS (production)

With Caddy, WebSocket proxying and certificates are automatic:

```text
hub.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

(Nginx works too — remember the `Upgrade`/`Connection` headers for
WebSocket.) Open 443 in the firewall, keep 4000 closed. Sites connect to
`wss://hub.example.com`.

## Connecting sites

Each site needs four values:

| Value | Meaning |
|---|---|
| URL | `wss://hub.example.com` (or `ws://<ip>:4000` for a quick test) |
| token | the hub's `HUB_TOKEN` — shared by all sites |
| room | one per performance; sites in different rooms never see each other |
| node | display name for this site, e.g. `site-berlin` |

Sites running the
[Telematic Network Diagnostics](https://github.com/xO-xN/Telematic-Network-Diagnostics)
project enter these through the monitor's connection form (or the
`PNDS_HUB_*` environment variables injected by PNDS App). Project-facing
integration documentation lives with the PNDS App documentation.

## Updating

```bash
sudo /opt/pnds-hub/update.sh            # latest release tag
sudo /opt/pnds-hub/update.sh v0.2.0     # a specific tag
```

`update.sh` fetches, checks out the tag, reinstalls dependencies, syncs the
systemd unit, and restarts the service. **Run it between performances only**
— the restart drops every connected site; clients reconnect automatically,
but reconnect bursts read as faults in telemetry (see [Operations](#operations)).

Verify the running version any time:

```bash
curl http://127.0.0.1:4000/
# → PNDS telematic hub v0.1.0
```

## Protocol quick reference

Server-side reference for debugging; project-facing integration docs live
with the PNDS App documentation.

| Item | Value |
|---|---|
| Transport | Socket.IO v4 (WebSocket) |
| Handshake `auth` | `{ token, room?, node? }` — the token never travels in the URL |
| Auth failure | `connect_error`, message `"invalid hub token"` |
| `welcome` (server → client) | `{ room, node, hubTime }` on room join |
| `echo` (client → server) | any JSON → stamped, returned to the **sender only** (RTT probing) |
| `relay` (client → server) | any JSON → stamped, sent to **every other client in the room** |
| Stamps | `from` = authenticated sender name, `hubReceivedAt` = hub receive time — both always overwritten by the hub (sender-supplied values cannot survive) |
| Naming | room: trimmed, ≤ 128 chars, fallback `default`; node: trimmed, ≤ 64 chars, fallback `socket.id` |
| Payload wrap | arrays/primitives travel as `{ value: <payload> }` |
| Delivery | ordered and reliable within a connection; messages in a reconnect gap are lost by design (silence is the outage signal) |

## Operations

**Capacity.** Only score servers connect — performers never touch the hub. A
telemetry client probes at ~15.5 msg/s (2 s burst at 30 msg/s alternating
with 2 s at 1 Hz) and relays one small snapshot per second. Ten sites ≈ 300
events/s and a few tens of KB/s — orders of magnitude below what the
smallest VPS handles, however the sites are split across rooms.

**Notes:**

- **Single point of failure.** One process serves all rooms; systemd covers
  crashes, not VPS/network outages. For critical events prefer a second hub
  instance on a second machine over a bigger machine.
- **Do not restart mid-performance.** Reconnect bursts surface as red in the
  telemetry project's go/no-go banner (≥ 2 reconnects within 15 s). Deploy
  and update between shows.
- **One token for everyone.** All rooms share `HUB_TOKEN`; a leaked token
  exposes every performance on the hub. Rotate it (edit `hub.env`, restart)
  when the circle grows.
- **Placement shapes the numbers.** The VPS location sets the baseline
  RTT/jitter every site measures against the hub; for multi-continent setups
  pick a reasonable middle ground.
- **End-to-end latency is the sum of two legs.** Store-and-forward adds
  sub-millisecond processing, but a message between two sites crosses
  site → hub → site (~100–300 ms+ intercontinentally). Whether that suits a
  piece is the composer's call.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Sites report `connect_error: invalid hub token` | `HUB_TOKEN` mismatch between site and hub (watch for trailing whitespace/newlines in `hub.env`) |
| Sites connect but never see each other | different `room` names |
| Cannot connect through the proxy | proxy not forwarding WebSocket upgrades; verify sites use `wss://` against the public URL |
| Red "reconnect" banners right after maintenance | the hub was restarted mid-session — expected; wait out the 15 s window |
| `curl http://127.0.0.1:4000/` shows the version text | the hub is alive — that is the health check |
| `update.sh` errors about git origin | the live dir was set up from a zip, not a git clone — re-clone |

## License

[MIT](LICENSE)
