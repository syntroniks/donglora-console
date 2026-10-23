# DongLoRa Console

A browser console for a [DongLoRa](https://github.com/donglora) USB LoRa dongle: device info and the config the radio
actually applied, live RX with MeshCore decoding, the nodes heard from their adverts, a read-only feed of the MeshCore
Public channel, link and decode errors with their bytes, and a shell.

It talks DongLoRa Protocol v1.0 over WebSerial, so it needs Chrome or Edge on desktop. It was built against a Heltec V4
(ESP32-S3 + SX1262) on DongLoRa firmware 1.5.2, and defaults to the MeshCore USA/Canada settings.

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:5174, hot reload (5173 is meshcore-console's)
```

Click **Connect USB** and pick the dongle (the picker only lists USB 1209:5741 and the USB-UART bridges some boards
use), or **Demo radio** for a simulated dongle in the page. On connect the console reads GET_INFO, sends SET_CONFIG with
the requested config (MeshCore USA/Canada unless changed) and starts RX.

| Command | What it does |
| --- | --- |
| `pnpm dev` | dev server with hot reload |
| `pnpm build` | type-check and build into `dist/` |
| `pnpm test` | unit tests (Vitest, about a second) |
| `pnpm typecheck` / `pnpm lint` | TypeScript 7 / oxlint |
| `pnpm probe [port] [--seconds 60]` | receive-only check against a real dongle from Node |

`pnpm probe` finds the dongle by USB VID:PID and refuses to open a port that isn't one. It runs GET_INFO, SET_CONFIG
with the USA/Canada preset and RX_START, prints every RX event for the given time (failed ones with their stage,
reason and bytes), then RX_STOP and a summary. It never transmits. Disconnect the browser first, and don't connect
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
  MeshCore's `variants/heltec_v4/LoRaFEMControl.cpp`. The dBm value is the SX1262 setting, not antenna output, and
  receive sensitivity may be lower than under MeshCore firmware.
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
`freq_err = 0`, and drops packets whose CRC fails before they reach the host (`firmware/src/radio.rs`). So *CRC fail*
only appears with other firmware or the demo radio, and the frequency error column reads 0 on real hardware.

The Packets filter (All / Decoded / Failed / No key / CRC fail) defaults to All. Overview counts each category, and in
the shell `/rx on` prints failures in red with their reasons. The demo radio produces every kind of failure at every
layer, so all of them can be seen without hardware.

## Noise floor

DongLoRa v1.0 has no instantaneous-RSSI command, so the noise floor is estimated from packets. Each packet's RSSI
averages signal and noise, and firmware 1.5.2 rounds RSSI and SNR to whole dB, so the noise under a packet is
`RSSI − 10·log10(1 + 10^(SNR/10))`. That holds at negative SNR too, and is good to about ±1 dB. Packets with a failed
CRC are left out. `src/radio/noiseFloor.ts` (no DOM) keeps two figures:

- MeshCore's floor (`RadioLibWrappers.cpp` `loop()`): starts unset, takes only samples below floor + 14 dB, sets the
  floor to the integer average of 64 of them, clamped at −120 dBm, then starts the next batch. With packet
  estimates this needs 64 packets.
- A rolling median of the last 15 estimates, which is useful much sooner.

Samples carry a source, `packet-estimate` or `measured`. If a future firmware command reports measured RSSI between
packets, those samples take over while they keep arriving, and the badge on the Overview card changes. Overview shows
both figures with a chart of packet RSSI and noise. The Packets table has a per-packet noise column, and `/noise`
prints the same in the shell.

## Receiver front end

The Radio tab and `/agc` list RX gain mode, AGC reset, FEM/LNA, TCXO and DC-DC. No firmware reports these yet, so the
values come from a table keyed by firmware version and board (`src/radio/frontEnd.ts`), each badged *firmware default
(not reported by device)*. For 1.5.2 on the Heltec V4: SX1262 RX gain in power-saving mode (0x94; boosted 0x96 would
add about 3 dB for about 2 mA), no AGC reset (MeshCore warm-sleeps the radio periodically), the front-end module and its
LNA not driven, TCXO 1.8 V, DC-DC on. Other versions show *unknown*. Device-reported values from a future diagnostics
command can be merged with `deviceReported()`.

## Shell

Commands are local; DongLoRa has no CLI. `/help`, `/info` (GET_INFO), `/ping`, `/config` (requested and echoed),
`/preset us|eu|au|nz`, `/rx on|off` (print packets), `/rx start|stop` (RX_START / RX_STOP), `/frames on|all|off` (hex of
every frame, `all` includes keepalive PINGs), `/stats`, `/noise`, `/agc`, `/errors`, `/nodes`, `/clear` and `/tx <hex>`
(needs TX armed, asks to confirm). Tab completes, arrows walk history, Ctrl-C stops waiting for a command.

## Session handling

The dongle drops to UNCONFIGURED after 1000 ms without a frame from the host. The client owns the keepalive: it PINGs
whenever nothing else has been written for 400 ms, from a Worker timer, which background tabs don't throttle. A PING
still succeeds after a reset, so RX could stop without any error. To catch that, a write gap over 900 ms makes the
client probe with an RX command. That is a no-op on a live session, and on a reset one it fails with ENOTCONFIGURED.
On ENOTCONFIGURED the client re-sends the last config and restarts RX if it was on. A TX is never retried. Overview
shows PING round trips, the longest write gap and sessions lost and restored.

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
  messages.ts        typed payload builders and parsers (GET_INFO, SET_CONFIG, RX, TX_DONE, ERR)
  lora.ts            bandwidth/CR tables, validation against GET_INFO, airtime
  client.ts          tags, timeouts, write queue, keepalive, recovery, link errors
  ticker.ts          Worker-backed interval for the keepalive
  transports/        WebSerial, and the simulated dongle for demo mode and tests
src/meshcore/        MeshCore over-the-air packets: decode (with failure stages), crypto, builders, presets
src/radio/           noise floor estimation, receiver front-end table
src/console/         shell line editing and command catalog
src/ui/              React views, the connection store, the xterm shell
scripts/             Node tools (node-serialport transport, probe)
test/                Vitest; appendixC.ts holds the wire examples from PROTOCOL.md Appendix C
```

The protocol follows `protocol-rs/PROTOCOL.md`; MeshCore layouts follow `docs/packet_format.md`, `docs/payloads.md`,
`src/Mesh.cpp` and `src/Utils.cpp` in the MeshCore firmware.
