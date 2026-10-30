# DongLoRa Console

A browser console for a [DongLoRa](https://github.com/donglora) USB LoRa dongle: device info and the config the radio
actually applied, live RX decoded by protocol [plugins](#plugins) (MeshCore and Meshtastic), the nodes they learn about
and a map of those that report a position, the channel messages they can read, link and decode errors with their
bytes, a shell, and [scripts](#scripts) of your own that react to traffic and drive the radio.

It talks DongLoRa Protocol v1.0 over WebSerial, plus the v1.1 additions when the firmware has them, so it needs Chrome or
Edge on desktop. It was built against a Heltec V4 (ESP32-S3 + SX1262) on DongLoRa firmware 1.5.2 and 1.6.0, and defaults
to the MeshCore USA/Canada settings.

It can also reach the dongle through the [console server](#console-server), which shares it via donglora-mux with
scripts and a JSON API, and lets the dongle sit on another machine.

## Running it

The latest `main` is published at <https://syntroniks.github.io/donglora-console/>. To run it locally:

```sh
pnpm install
pnpm dev          # http://localhost:5174, hot reload (5173 is meshcore-console's)
```

Click **Connect USB** and pick the dongle (the picker only lists USB 1209:5741 and the USB-UART bridges some boards
use), or **Demo radio** for a simulated dongle in the page (a Heltec V4.2 on firmware 1.6.0). On connect the console
reads GET_INFO, sends SET_CONFIG with the requested config (MeshCore USA/Canada unless changed) and starts RX.

| Command | What it does |
| --- | --- |
| `pnpm dev` | dev server with hot reload |
| `pnpm build` | type-check and build into `dist/` |
| `pnpm test` | unit tests (Vitest, about a second) |
| `pnpm typecheck` / `pnpm lint` | TypeScript 7 / oxlint |
| `pnpm probe [port] [--seconds 60]` | receive-only check against a real dongle from Node |
| `pnpm server [--demo]` | the [console server](#console-server): JSON API, `/ws` relay, built console |

`pnpm probe` finds the dongle by USB VID:PID and refuses to open a port that isn't one. It runs GET_INFO, SET_CONFIG
with the USA/Canada preset and RX_START, prints every RX event for the given time (failed ones with their stage,
reason and bytes), then RX_STOP and a summary. On firmware with RADIO_STATUS it also prints, once a second, the
instantaneous RSSI, the measured noise floor, the device's RX counters and the front-end state, and adds them to the
summary. It never transmits. Disconnect the browser first, and don't connect
it while the probe runs. The probe's lock doesn't stop Chrome from opening the same tty. When both have it open, replies
split between them, and Chrome's `PARMRK` setting makes the other reader see every 0xFF byte doubled, which shows up
as COBS link errors.

## Console server

WebSerial gives one tab the serial port to itself, so nothing else can read the radio while the console is connected.
The console server (`server/`) puts [donglora-mux](https://github.com/donglora/mux-rs) in front of the dongle and is
itself a mux client:

```
dongle ── USB ── donglora-mux ──┬── console server ──┬── /api   JSON API and events, from its own session
                                │   (pnpm server)    ├── /ws    one mux session per console page
                                │                    └── /      the built console
                                └── client-py, client-rs, other mux clients
```

mux owns the port. It gives every client its own tags, keeps RX on while any client wants it and locks the config to
the first client that sets it; other clients get `ALREADY_MATCHED` or `LOCKED_MISMATCH` back. The server's session
asks for its `--preset` on connect, so it normally holds that lock, and `PUT /api/config` changes the config for
everyone. Upstream mux 1.0.2 answers RADIO_STATUS with `EUNKNOWN_CMD` because its protocol crate predates it; the
console then keeps the session alive with PING. Built against `protocol-rs` 1.3 (`[patch.crates-io]` to the sibling
checkout) it forwards RADIO_STATUS like any other command.

```sh
donglora-mux --tcp none     # owns the dongle; Unix socket only (its default TCP listener is 0.0.0.0:5741)
pnpm server                 # http://127.0.0.1:5742; finds mux's socket like client-rs does
pnpm server --demo          # a simulated firmware 1.6.0 dongle instead, no hardware or mux needed
```

Open http://127.0.0.1:5742 (after `pnpm build`) or the `pnpm dev` page and click **Connect server**. The dev and
preview servers proxy `/api` and `/ws` to 5742, so the page reaches the server on its own origin. The URL is editable
on the welcome screen and remembered; on `*.github.io` it defaults to `ws://localhost:5742/ws`.

| Option | |
| --- | --- |
| `--mux <path\|host:port>` | mux socket; default `$DONGLORA_MUX`, then `$XDG_RUNTIME_DIR/donglora/mux.sock`, then `/tmp/donglora-mux.sock` |
| `--demo` | simulated dongle, one per connection |
| `--port <n>` / `--host <addr>` | listen address, default `127.0.0.1:5742` |
| `--allow-origin <url>` | another web origin allowed to use the API and `/ws` (repeatable) |
| `--allow-tx` | let `/api/tx`, `/ws` clients and scripts transmit |
| `--tx-power <dBm>` | TX power in the session's config (the preset's 10 dBm otherwise); the dongle's GET_INFO range applies |
| `--name <sender>` | the name `POST /api/messages` and scripts' `radio.say()` send as when none is given (default `DongLoRa`) |
| `--preset <id>` | config the server's session asks for, default `meshcore-us`; any plugin preset |
| `--script <file.js>` | run a [script](#scripts) against the server's session (repeatable) |

### API

JSON in and out. Bytes are lowercase hex, the 64-bit capability bitmap is a `0x` string, times are `Date.now()`
milliseconds. Errors are `{"error": "..."}` with 400 for bad input, 403 for refused, 502 when the dongle or mux
answered ERR, 503 when the server has no dongle session and 504 on a timeout.

| Endpoint | |
| --- | --- |
| `GET /api` | the endpoint list |
| `GET /api/server` | version, upstream, whether TX is allowed, open `/ws` relays |
| `GET /api/state` | connection, GET_INFO, requested and applied config, RX on/off, stats, keepalive health, noise floor, counts |
| `GET /api/info` | GET_INFO |
| `GET /api/config` / `PUT /api/config` | requested and applied config; PUT takes `{"preset": "meshcore-eu"}` or LoRa fields (`freqHz`, `sf`, `bw`, `cr` as wire enums, `txPowerDbm`, ...) laid over the requested config, and restarts RX if it was on |
| `GET /api/plugins` | protocol plugins with their presets, and which one decodes the current config |
| `GET /api/presets` | every plugin preset |
| `POST /api/rx/start` / `POST /api/rx/stop` | RX for the server's session |
| `GET /api/packets?limit=50&after=<id>&protocol=<id>` | received packets with their plugin decode, newest first |
| `GET /api/nodes?protocol=<id>` | nodes the plugins learned about, most recently heard first |
| `GET /api/messages?limit=100&protocol=<id>` | channel messages, newest first, received and sent |
| `POST /api/messages` | post `{"text", "channel"?, "sender"?, "protocol"?}` through the plugin for the radio config; only with `--allow-tx` |
| `GET /api/scripts` | scripts started with `--script`, running or not, with their recent output |
| `GET /api/radio` | last RADIO_STATUS, counters at the start of the session, noise floor, keepalive health |
| `GET /api/link-errors?limit=100` / `GET /api/log` | link errors and the session log, newest first |
| `POST /api/tx` | `{"hex": "..."}`, only with `--allow-tx`; answers TX_DONE |
| `GET /api/events` | server-sent events: `state` on connect and at most once a second after, `packet`, `node`, `message`, `link-error`, `log`, `tx-done` |

```sh
curl -s localhost:5742/api/nodes
curl -s -X PUT -H 'content-type: application/json' -d '{"preset":"meshcore-us"}' localhost:5742/api/config
curl -sN localhost:5742/api/events
```

`/ws` carries the DongLoRa byte stream in binary messages, so any DongLoRa client works over it: the console uses
`WebSocketTransport` (`src/protocol/transports/websocket.ts`) with its usual client. The relay decodes each frame and
re-encodes it on the way to mux. Without `--allow-tx` it answers TX with `ERR(EUNKNOWN_CMD)` itself, as mux does for a
command it won't forward, and the console refuses to arm TX on such a server.

### Who can reach it

It listens on loopback. It refuses a request whose `Host` isn't a loopback name, which stops DNS rebinding, and a
browser request (or WebSocket upgrade) whose `Origin` isn't the server itself, `https://syntroniks.github.io` or an
`--allow-origin`. That keeps a page you happen to visit from driving the radio; requests without an Origin, such as
curl, are allowed. A page on `https://` can reach `http://localhost` and `ws://localhost`, after Chrome's local
network prompt; the server answers the Private Network Access preflight. Any other host needs TLS (`wss://`) in
front, and with `--host` set to a non-loopback address anyone who reaches the port can use the radio, so put
authentication in front as well.

## Plugins

Each LoRa protocol is a plugin (`src/plugins/`) with no UI of its own: presets (the PHY), a decoder that turns bytes
into a status, a summary, labelled fields and tinted byte ranges, and a `learn` step that says what a packet with a good
CRC tells about nodes and messages. The views, the shell, the server API and scripts are generic over that, so a
plugin shows up everywhere at once.

| Plugin | Claims packets when | Decodes | Learns |
| --- | --- | --- | --- |
| MeshCore | sync word 0x12 (0x1424) | header, path, adverts (Ed25519 checked), Public channel, addressed traffic | nodes from adverts with a valid signature; Public channel posts |
| Meshtastic | sync word 0x2B (0x24B4) | 16-byte header, AES-CTR with the default channel keys, `Data` protobuf: text, position, node info, telemetry, routing, traceroute | nodes from any packet it decrypts (Meshtastic broadcasts aren't signed); text messages |

A radio hears one protocol at a time: frequency, SF, bandwidth and sync word all have to match, so the preset you pick on
the Radio tab (grouped by plugin) decides which plugin decodes. A packet received with a config no plugin claims is
kept as raw bytes, labelled "no plugin". To hear two protocols, alternate presets (the *Protocol hopper* example
script) or use one dongle per protocol. The Meshtastic plugin was written from the protocol's documentation and tested
against packets it built itself; it hasn't decoded real traffic yet.

A new plugin implements `ProtocolPlugin` in `src/plugins/types.ts` and goes in the `PLUGINS` list in
`src/plugins/index.ts`.

## Sending messages

The Messages view has a compose bar: pick the channel, set your name, type, Enter. It sends through the plugin that
decodes the current radio config, so the preset you're on decides the protocol.

- **MeshCore** posts to the Public channel, flood-routed, as `name: text` (up to 160 bytes together, MeshCore's
  limit), exactly like a companion app.
- **Meshtastic** broadcasts text on the default channel of the modem preset you're on, with the default key, three hops.
  It sends as a `!node` id derived from your name, and sends no node info, so other radios show the id, not the name.

A message only goes out while TX is armed. Arming asks once and shows the frequency and power; while armed, messages send
without asking again, and the bar shows where and how loud. Your messages show on the right with how long they were on
air. When repeaters forward one, this radio hears the copies and the bubble says *heard back n×*, which is the
confirmation that the mesh carried it. `/say <text>` in the shell does the same, `radio.say(text, { channel, sender })`
from a script, and `POST /api/messages` on the console server (`--allow-tx`, sender from `--name`). Through mux every
client sends with the config the lock holder set, including its TX power.

## Scripts

Scripts are your own JavaScript. On the Scripts tab you write them, start them from examples, run and stop them, and
see their output, which also goes to the shell (`/scripts`, `/run <name>`, `/stop <name>|all`). They are kept in this
browser; tick *run when connected* to start one on every connect.

```js
on('node', (n) => n.isNew && print(`new ${n.protocol} node ${n.name || n.id} at ${n.rssi} dBm`))
every(10_000, async () => print('RSSI', (await radio.status())?.rssiInst))
await radio.setConfig('meshtastic-longfast-us')
```

The script body runs as an async function in its own Web Worker. It can't touch the page or the radio session
directly, only through `radio.state() info() config() setConfig(presetIdOrFields) rxStart() rxStop() ping() status()
packets(n) nodes() messages(n) plugins() tx(hexOrBytes)`, `on(event, fn)` for `packet`, `node`, `message`,
`link-error`, `log`, `connected` and `disconnected`, `every(ms, fn)`, `sleep(ms)`, `print()`, `warn()`, and
`storage.get/set` (JSON values, per script). An error in a handler or timer is printed and the script keeps going; an
error at the top level ends it.

`radio.tx()` works only for a script started with *may transmit* ticked, which asks first, and only while TX is armed
on the Radio tab; every send is logged. The console server runs scripts with `--script`, each in a worker thread
against the server's session, starting when it first connects; there `tx()` needs `--allow-tx`. A worker thread can use
Node's APIs, so only give the server scripts you trust. The server never accepts scripts over HTTP.
`examples/watchdog.js` is a soak watchdog (packets and RSSI each minute, warnings when the radio looks deaf):
`pnpm server --script examples/watchdog.js`.

`examples/meshcore-repeater.js` (also the *MeshCore repeater* example on the Scripts tab) makes the dongle a MeshCore
repeater, forwarding the way MeshCore's own `simple_repeater` does: it needs *may transmit* and armed TX, or
`pnpm server --allow-tx --script examples/meshcore-repeater.js`. A flood packet is forwarded once, with the node's hash
added to its path after a random delay (up to 5 × airtime × `TX_DELAY_FACTOR`), unless it is past `FLOOD_MAX` hops
(adverts: `FLOOD_MAX_ADVERT`), already passes through this node too often, is an advert with a bad signature, or is
region-scoped (`ALLOW_SCOPED`). A direct packet is forwarded only when the node's hash is next on its path, and a trace
gets this hop's SNR added. It stays under `DUTY_CYCLE_MAX` of airtime an hour. It makes a node ID once and keeps it
(`NODE_ID` takes the start of a real repeater's public key instead). It only forwards: no adverts of its own (they need
the Ed25519 key, which a script can't use), no replies to requests, no remote CLI, no region list.

Channel messages are counted once however many copies the mesh delivers: a plugin gives each message a key (MeshCore:
channel, timestamp and text; Meshtastic: sender and packet id), and repeats raise its *heard n×* count instead. Scripts
get one `message` event per message; the Packets tab still lists every copy.

## Safety

- **Nothing transmits unless you arm TX.** The Radio tab has an *Enable TX* toggle, off by default and on every new
  connection. With it off, the TX box, the send button and `/tx` all refuse. With it on, every send asks again and
  shows the frequency and power. The DongLoRa firmware enforces no regulatory limits; you are responsible for being
  allowed to transmit on the frequency you pick.
- **Heltec V4 front end.** The V4 has an external PA/LNA (GC1109 or KCT8103L). DongLoRa 1.5.2's board file
  (`firmware/src/board/heltec_v4.rs`) never drives its control pins (GPIO7 LDO, GPIO2 CSD, GPIO46 CPS / GPIO5 CTX), unlike
  MeshCore's `variants/heltec_v4/LoRaFEMControl.cpp`. On 1.5.2 the dBm value is the SX1262 setting into an unpowered
  module, not antenna output, and receive sensitivity may be lower than under MeshCore firmware. Firmware 1.6.0 powers
  the module, turns on its LNA for RX and maps `tx_power_dbm` to SX1262 drive through a measured gain curve, so with a
  powered FEM the value is approximate antenna output, and GET_INFO's TX range is the output range (2…28 dBm on the
  GC1109, 4…28 on the KCT8103L). Config validation uses whatever range GET_INFO reports. The Radio tab says which case
  applies.
- The console server refuses TX, on `/api/tx`, `/ws` and from scripts, unless it was started with `--allow-tx`.
- A script transmits only if you ticked *may transmit* for it (the console asks), and only while TX is armed.
- Messages sent from the Messages view or `/say` don't ask per message: arming TX is the consent, and the compose
  bar shows the frequency and power while armed. Raw TX (`/tx`, the Radio tab) still asks every time.
- The demo radio and the unit tests are the only things that have exercised TX.

## Errors are shown, not dropped

Every layer keeps what failed, with its raw bytes in hex and a specific reason:

- **Link** (*Link errors* tab): frames that fail COBS, length or CRC checks, runs with no delimiter, unknown frame
  types, async ERR events (EFRAME, ERADIO, EINTERNAL), replies whose tag nothing is waiting for, payloads that don't
  parse, and serial read errors the port recovered from. Each has the frame bytes and the failing offset.
- **Radio**: RX events with `crc_valid = 0` are always listed, highlighted red and labelled *CRC fail*. They are still
  decoded, marked untrusted. Nodes and channel posts only come from packets that passed the CRC.
- **MeshCore** (*Packets* tab): the decoder never throws. Each packet is *decoded*, *partial* (header and path fine,
  a later stage failed), *undecodable* (header or path failed) or *no key* (a channel this console has no key for, which
  isn't a failure). Failures name the stage (header, path, payload, advert, signature, channel, decrypt, MAC), the reason
  and the byte offset, and keep every field that did parse. The detail pane highlights the failing byte in the hex dump.

Firmware 1.5.2 limits what the radio layer can show. Its RX path always sends `crc_valid = 1` and
`freq_err = 0`, and drops packets whose CRC fails before they reach the host (`firmware/src/radio.rs`). So on 1.5.2
*CRC fail* never appears on real hardware and the frequency error column reads 0. Firmware 1.6.0 delivers CRC-failed
packets with `crc_valid = 0` and reports the SX126x frequency-error estimate in Hz. Packets that fail at the LoRa
header carry no bytes and are never delivered; RADIO_STATUS counts them, and Overview shows that count with the decode
failures.

The Packets filter (All / Decoded / Failed / No key / CRC fail) defaults to All. Overview counts each category, and in
the shell `/rx on` prints failures in red with their reasons. The demo radio produces every kind of failure at every
layer, so all of them can be seen without hardware.

## Protocol v1.1 (firmware 1.6.0)

DongLoRa 1.6.0 reports protocol 1.1 and adds one command, `RADIO_STATUS` (type 0x07, empty payload, valid in any
state). Devices that have it set capability bit 33; older firmware answers `ERR(EUNKNOWN_CMD)`, so the console only
sends it when the bit is set. The `OK` payload is 17 bytes, little-endian (longer payloads are accepted, extra bytes
ignored):

| Offset | Field | |
| --- | --- | --- |
| 0 | `rssi_inst` i16 | instantaneous RSSI, tenths of dBm in 0.5 dB steps; 0x8000 (shown as none) outside continuous RX |
| 2 | `rx_gain` u8 | 0 power saving (reg 0x08AC = 0x94), 1 boosted (0x96), 0xFF unknown |
| 3 | `fem_type` u8 | 0 none, 1 GC1109 (V4.2), 2 KCT8103L (V4.3), 0xFF unknown |
| 4 | `fem_flags` u8 | bit 0 FEM powered, bit 1 RX LNA active, bit 2 TX PA enabled (0 = bypass) |
| 5, 9, 13 | `rx_ok`, `rx_crc_err`, `rx_header_err` u32 | RX counters since device boot |

When GET_INFO has the bit, the client polls RADIO_STATUS once a second, separately from the PING keepalive (see
Session handling), and each reply feeds the noise floor, the front-end card and the device counters on Overview.
`client.radioStatus()` resolves `undefined` without sending when the bit is clear, and if the device answers
EUNKNOWN_CMD anyway it logs that and stops polling.

Firmware 1.6.1 answers PING and RADIO_STATUS in its USB task, from a snapshot the radio task keeps: it samples RSSI and
the RX gain register every 250 ms in continuous RX, so `rssi_inst` is at most that old, and absent when older than 1 s
or outside RX. On 1.6.0 every command reached the radio task and interrupted its receive loop, and a RADIO_STATUS
keepalive every 400 ms eventually left a RAK4631 deaf (every radio read zero, no RX); 1.6.1 fixes the underlying
SPI cancellation too. The console polls slowly either way.

## Noise floor

With RADIO_STATUS, every reply that has an `rssi_inst` is a *measured* sample: the SX1262's instantaneous RSSI, polled
once a second while the radio is in continuous RX. Overview and `/noise` then show the source as
*measured (RADIO_STATUS)* and the chart draws those samples as a line. When they stop (RX off, older firmware) the floor
falls back to packet estimates after 10 s.

Without it, the noise floor is estimated from packets. Each packet's RSSI averages signal and noise, and the firmware
rounds RSSI and SNR to whole dB, so the noise under a packet is `RSSI − 10·log10(1 + 10^(SNR/10))`. That holds at
negative SNR too, and is good to about ±1 dB. Packets with a failed CRC are left out. The Packets table keeps this
per-packet estimate either way. `src/radio/noiseFloor.ts` (no DOM) keeps two figures per source:

- MeshCore's floor (`RadioLibWrappers.cpp` `loop()`): starts unset, takes only samples below floor + 14 dB, sets the
  floor to the integer average of 64 of them, clamped at −120 dBm, then starts the next batch. Measured samples fill a
  batch in about 30 s; packet estimates need 64 packets.
- A rolling median of the last 15 estimates, which is useful much sooner.

Overview shows both figures for the source in use, with a chart of measured RSSI, packet RSSI and noise. `/noise`
prints the same in the shell, with the latest `rssi_inst` and recent per-packet estimates.

## Receiver front end

The Radio tab and `/agc` list RX gain mode, AGC reset, FEM type, FEM powered, RX LNA, TX PA, TCXO and DC-DC. With
RADIO_STATUS, RX gain and the four FEM rows are badged *device-reported* and follow each reply. The rest come from a
table keyed by firmware version and board (`src/radio/frontEnd.ts`), badged *firmware default (not reported by
device)*. For 1.5.2 on the Heltec V4: SX1262 RX gain in power-saving mode (0x94; boosted 0x96 would add about 3 dB for
about 2 mA), no AGC reset (MeshCore warm-sleeps the radio periodically), the front-end module and its LNA and PA not
driven, TCXO 1.8 V, DC-DC on. For 1.6.0: no AGC reset either, the FEM powered with LNA on in RX and PA in TX, and TCXO
and DC-DC assumed unchanged from 1.5.2; RX gain and FEM type read *unknown* until the first RADIO_STATUS reply. Other
versions show *unknown*.

## Device counters

On firmware with RADIO_STATUS, Overview has a *Radio counters* card with `rx_ok`, `rx_crc_err` and `rx_header_err`.
They count from when the dongle booted, not from when the console connected, so each also shows (+n) since this
connection's first reply or the last stats reset. CRC errors also arrive as RX events and appear in the console's own
counts. Header errors never reach the host; Decode results lists them as the first failing stage, *LoRa header (radio
count, no bytes)*. `/stats` prints the counters.

## Shell

Commands are local; DongLoRa has no CLI. `/help`, `/info` (GET_INFO), `/ping`, `/config` (requested and echoed),
`/preset <id>` (any plugin preset, or a unique suffix like `us`), `/plugins`, `/rx on|off` (print packets), `/rx start|stop` (RX_START / RX_STOP), `/frames on|all|off` (hex of
every frame, `all` includes the keepalive PINGs and RADIO_STATUS polls), `/stats`, `/noise`, `/agc`, `/errors`, `/nodes`,
`/scripts`, `/run <script>`, `/stop <script>|all`, `/clear` and `/tx <hex>` (needs TX armed, asks to confirm). Tab completes, arrows walk history, Ctrl-C stops waiting
for a command.

## Session handling

The dongle drops to UNCONFIGURED after 1000 ms without a frame from the host. The client owns the keepalive: a PING
whenever nothing else has been written for 400 ms, from a Worker timer, which background tabs don't throttle. Any frame
resets the device's timer, so a RADIO_STATUS poll (once a second, when the firmware has it) also counts. The keepalive
keeps its schedule even when earlier replies are missing, so one lost reply can't stall it. PING still succeeds after
a reset, so RX could stop without any error. To catch that, a write gap over 900 ms makes the
client probe with an RX command. That is a no-op on a live session, and on a reset one it fails with ENOTCONFIGURED.
On ENOTCONFIGURED the client re-sends the last config and restarts RX if it was on. A TX is never retried. Overview
shows keepalive round trips, the longest write gap and sessions lost and restored.

The connection lives outside React, so StrictMode and Fast Refresh can't open a second port. The session state is a
`RadioStore` (`src/radio/store.ts`) that doesn't know its transport; the console server runs the same class. The page
has one, with its WebSerial, demo and server connections (`src/ui/store.ts`), kept on `globalThis`. When Vite re-runs the module, the live instance keeps its client, port and
subscribers and takes the new code; Vite doesn't call `dispose` on intermediate modules, so a handover would get lost.
A crash in one view is caught by an error boundary instead of unmounting the app. The WebSerial transport serialises writes,
catches recoverable read errors inside its loop, waits for the read loop before closing the port, raises DTR explicitly
(the firmware's host-present signal), and closes the port when the stream dies so Connect works again.

## Layout

```
src/protocol/        DongLoRa Protocol, no UI dependencies
  cobs.ts crc.ts     COBS and CRC-16/CCITT-FALSE
  framing.ts         frames on the wire; decode faults keep their bytes
  messages.ts        typed payload builders and parsers (GET_INFO, SET_CONFIG, RX, TX_DONE, RADIO_STATUS, ERR)
  lora.ts            bandwidth/CR tables, validation against GET_INFO, airtime
  client.ts          tags, timeouts, write queue, keepalive, recovery, link errors
  ticker.ts          Worker-backed interval for the keepalive
  transports/        WebSerial, WebSocket (console server), and the simulated dongle for demo mode and tests
src/plugins/         protocol plugin interface, the registry (presets, which plugin decodes), MeshCore and Meshtastic
src/meshcore/        MeshCore over-the-air packets: decode (with failure stages), crypto, builders, presets
src/scripts/         script runtime: the sandbox that runs in a worker, the host that answers it, examples
src/radio/           the session store, its summary, noise floor (measured and estimated), receiver front end, TX power
src/console/         shell line editing and command catalog
src/ui/              React views, the page's radio and script stores, the xterm shell
server/              console server: mux and demo upstreams, JSON API and events, /ws relay, scripts, its tests
scripts/             Node tools (node-serialport transport, probe)
test/                Vitest; appendixC.ts holds the wire examples from PROTOCOL.md Appendix C
```

The protocol follows `protocol-rs/PROTOCOL.md`; MeshCore layouts follow `docs/packet_format.md`, `docs/payloads.md`,
`src/Mesh.cpp` and `src/Utils.cpp` in the MeshCore firmware.
