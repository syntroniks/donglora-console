# DongLoRa Console

A browser console for a [DongLoRa](https://github.com/donglora) USB LoRa dongle: device info and the config the radio
actually applied, live RX with MeshCore decoding, the nodes heard from their adverts, a read-only feed of the MeshCore
Public channel, link and decode errors with their bytes, and a shell.

It talks DongLoRa Protocol v1.0 over WebSerial, plus the v1.1 additions when the firmware has them, so it needs Chrome or
Edge on desktop. It was built against a Heltec V4 (ESP32-S3 + SX1262) on DongLoRa firmware 1.5.2 and 1.6.0, and defaults
to the MeshCore USA/Canada settings.

## Running it

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

`pnpm probe` finds the dongle by USB VID:PID and refuses to open a port that isn't one. It runs GET_INFO, SET_CONFIG
with the USA/Canada preset and RX_START, prints every RX event for the given time (failed ones with their stage,
reason and bytes), then RX_STOP and a summary. On firmware with RADIO_STATUS it also prints, once a second, the
instantaneous RSSI, the measured noise floor, the device's RX counters and the front-end state, and adds them to the
summary. It never transmits. Disconnect the browser first, and don't connect
it while the probe runs. The probe's lock doesn't stop Chrome from opening the same tty. When both have it open, replies
split between them, and Chrome's `PARMRK` setting makes the other reader see every 0xFF byte doubled, which shows up
as COBS link errors.

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

When GET_INFO has the bit, the keepalive sends RADIO_STATUS instead of PING (see Session handling), and each reply
feeds the noise floor, the front-end card and the device counters on Overview. `client.radioStatus()` resolves
`undefined` without sending when the bit is clear, and if the device answers EUNKNOWN_CMD anyway it logs that and
the keepalive goes back to PING.

## Noise floor

With RADIO_STATUS, every keepalive reply that has an `rssi_inst` is a *measured* sample: the SX1262's instantaneous
RSSI, read about twice a second while the radio is in continuous RX. Overview and `/noise` then show the source as
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
`/preset us|eu|au|nz`, `/rx on|off` (print packets), `/rx start|stop` (RX_START / RX_STOP), `/frames on|all|off` (hex of
every frame, `all` includes the keepalive PINGs or RADIO_STATUS), `/stats`, `/noise`, `/agc`, `/errors`, `/nodes`,
`/clear` and `/tx <hex>` (needs TX armed, asks to confirm). Tab completes, arrows walk history, Ctrl-C stops waiting
for a command.

## Session handling

The dongle drops to UNCONFIGURED after 1000 ms without a frame from the host. The client owns the keepalive: it writes
one whenever nothing else has been written for 400 ms, from a Worker timer, which background tabs don't throttle. The
keepalive is RADIO_STATUS when GET_INFO advertises it (any frame resets the timer) and PING otherwise. It keeps its
schedule even when earlier replies are missing, so one lost reply can't stall it. Both still succeed after a reset,
so RX could stop without any error. To catch that, a write gap over 900 ms makes the
client probe with an RX command. That is a no-op on a live session, and on a reset one it fails with ENOTCONFIGURED.
On ENOTCONFIGURED the client re-sends the last config and restarts RX if it was on. A TX is never retried. Overview
shows keepalive round trips, which command the keepalive uses, the longest write gap and sessions lost and restored.

The connection lives outside React (`src/ui/store.ts`), so StrictMode and Fast Refresh can't open a second port. There
is one store per page, kept on `globalThis`. When Vite re-runs the module, the live instance keeps its client, port and
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
  transports/        WebSerial, and the simulated dongle for demo mode and tests
src/meshcore/        MeshCore over-the-air packets: decode (with failure stages), crypto, builders, presets
src/radio/           noise floor (measured and estimated), receiver front end, what TX power means
src/console/         shell line editing and command catalog
src/ui/              React views, the connection store, the xterm shell
scripts/             Node tools (node-serialport transport, probe)
test/                Vitest; appendixC.ts holds the wire examples from PROTOCOL.md Appendix C
```

The protocol follows `protocol-rs/PROTOCOL.md`; MeshCore layouts follow `docs/packet_format.md`, `docs/payloads.md`,
`src/Mesh.cpp` and `src/Utils.cpp` in the MeshCore firmware.
