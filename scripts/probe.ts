// Receive-only check against a real dongle over USB:
//   pnpm probe [port] [--seconds 60] [--preset meshcore-us]
// GET_INFO, SET_CONFIG with a plugin preset (MeshCore USA/Canada unless --preset), RX_START, then every RX
// event for N seconds decoded by the plugins (failed ones with their reasons and bytes), then RX_STOP and a
// summary. It never transmits.
// When GET_INFO sets capability bit 33 (firmware 1.6.0, protocol v1.1) the keepalive is RADIO_STATUS, and
// once a second the probe prints its instantaneous RSSI, the measured noise floor, the device's RX
// counters and the front-end state.
// The port must be a DongLoRa by USB VID:PID (1209:5741, or a known USB-UART bridge).

import { toHex } from '../src/protocol/bytes.ts'
import { DongLoRaClient, LINK_ERROR_NAMES, type LinkErrorKind } from '../src/protocol/client.ts'
import { Capability, CAPABILITY_NAMES, FEM_TYPE_NAMES, FemFlag, RADIO_CHIP_NAMES, RX_GAIN_NAMES } from '../src/protocol/codes.ts'
import { describeConfig, mhz, syncWordHex } from '../src/protocol/lora.ts'
import { hasCapability, type RadioStatus } from '../src/protocol/messages.ts'
import { intervalTicker } from '../src/protocol/ticker.ts'
import { decodePacket, DEFAULT_PRESET, pluginById, presetById, PRESETS, type DecodeStatus } from '../src/plugins/index.ts'
import { MEDIAN_WINDOW, NoiseFloorTracker, NUM_NOISE_FLOOR_SAMPLES } from '../src/radio/noiseFloor.ts'
import { findDongles, NodeSerialTransport } from './node-serial.ts'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const seconds = Number(flag('--seconds') ?? 60)
const pathArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--seconds' && args[i - 1] !== '--preset')
const found = flag('--preset') ? presetById(flag('--preset')!) : DEFAULT_PRESET
if (!found) {
  console.error(`unknown --preset ${flag('--preset')}; one of ${PRESETS.map((p) => p.id).join(', ')}`)
  process.exit(1)
}
const preset = found

const dongles = await findDongles()
const path = pathArg ?? dongles[0]?.path
if (!path) {
  console.error('no DongLoRa found (USB 1209:5741); pass the serial port path')
  process.exit(1)
}
const match = dongles.find((d) => d.path === path)
if (!match) {
  console.error(`${path} is not a DongLoRa by USB VID:PID (found: ${dongles.map((d) => `${d.path} ${d.usbId}`).join(', ') || 'none'}); refusing to open it`)
  process.exit(1)
}

const client = new DongLoRaClient(new NodeSerialTransport(path), { ticker: intervalTicker })
// belt and braces: this script must never transmit
client.transmit = () => Promise.reject(new Error('probe never transmits'))

const t0 = Date.now()
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`
const status: Record<DecodeStatus, number> = { decoded: 0, partial: 0, undecodable: 0, 'no-key': 0, unknown: 0 }
const stages: Partial<Record<string, number>> = {}
const link: Partial<Record<LinkErrorKind, number>> = {}
let rx = 0
let crcFail = 0
let dropped = 0
const rssi: number[] = []
const snr: number[] = []
const nodes = new Map<string, string>()
const posts: string[] = []
const noise = new NoiseFloorTracker()
const noiseEstimates: number[] = []

// RADIO_STATUS, from the keepalive (about twice a second) once RX has started
let statusSupported = false
let statusTimer: ReturnType<typeof setInterval> | undefined
let listening = false
let lastStatus: RadioStatus | undefined
let firstStatus: RadioStatus | undefined
let statusReplies = 0
const rssiInst: number[] = []
const femText = (s: RadioStatus) => {
  if (s.femType === 0) return 'no FEM'
  const on = (bit: number) => (s.femFlags & bit) !== 0
  return `${FEM_TYPE_NAMES[s.femType] ?? `type 0x${s.femType.toString(16)}`} ${on(FemFlag.Powered) ? 'powered' : 'UNPOWERED'}, LNA ${on(FemFlag.Lna) ? 'on' : 'off'}, ${on(FemFlag.Pa) ? 'PA' : 'PA bypass'}`
}
const counters = (s: RadioStatus) => {
  const b = firstStatus ?? s
  return `rx_ok ${s.rxOk} (+${s.rxOk - b.rxOk}) crc_err ${s.rxCrcErr} (+${s.rxCrcErr - b.rxCrcErr}) header_err ${s.rxHeaderErr} (+${s.rxHeaderErr - b.rxHeaderErr})`
}
client.on('radioStatus', (s) => {
  if (!listening) return
  statusReplies++
  firstStatus ??= s
  lastStatus = s
  if (s.rssiInst !== null) {
    rssiInst.push(s.rssiInst)
    noise.add({ at: Date.now(), dbm: s.rssiInst, source: 'measured' })
  }
})
client.on('radioStatusUnsupported', (r) => console.log(`${stamp()} ${r}`))
function printStatus(): void {
  const s = lastStatus
  if (!s) return void console.log(`${stamp()} STATUS   no RADIO_STATUS reply yet`)
  const m = noise.snapshot(Date.now(), 'measured')
  const floor = m.floor !== undefined ? `${m.floor} dBm` : `pending ${m.pending}/${NUM_NOISE_FLOOR_SAMPLES}`
  console.log(`${stamp()} STATUS   rssi_inst ${s.rssiInst !== null ? `${s.rssiInst} dBm` : 'none (not in continuous RX)'}  floor ${floor}, median ${m.median ?? '-'} dBm  ${counters(s)}  gain ${RX_GAIN_NAMES[s.rxGain] ?? s.rxGain}  ${femText(s)}`)
}

client.on('rx', (p) => {
  rx++
  dropped += p.packetsDropped
  const d = decodePacket(p.data, p, client.applied?.lora ?? preset.config)
  status[d.status]++
  if (d.failure) stages[`${d.protocol}/${d.failure.stage}`] = (stages[`${d.protocol}/${d.failure.stage}`] ?? 0) + 1
  if (p.crcValid) {
    rssi.push(p.rssi)
    snr.push(p.snr)
  } else crcFail++
  const n = noise.addPacket(p.rssi, p.snr, p.crcValid)
  if (n !== undefined) noiseEstimates.push(n)
  const meta = `${p.rssi} dBm ${p.snr} dB noise ${n !== undefined ? Math.round(n) : '-'} ferr ${p.freqErr} Hz ${p.data.length}B${p.packetsDropped ? ` (${p.packetsDropped} dropped before)` : ''}`
  const crc = p.crcValid ? 'crc ok  ' : 'CRC FAIL'
  if (d.status === 'decoded' || d.status === 'no-key' || d.status === 'unknown') {
    console.log(`${stamp()} ${crc} ${meta}  ${d.status}: ${d.summary}`)
  } else {
    console.log(`${stamp()} ${crc} ${meta}  ${d.status.toUpperCase()} at ${d.failure!.stage} stage, byte ${d.failure!.offset}: ${d.failure!.reason}`)
    console.log(`           ${toHex(p.data, ' ')}`)
  }
  if (!p.crcValid && d.status === 'decoded') console.log('           (decoded, but the radio CRC failed: untrusted)')
  if (p.crcValid) {
    const learned = pluginById(d.protocol)?.learn?.(d, p) ?? {}
    for (const n of learned.nodes ?? []) nodes.set(`${d.protocol}:${n.id}`, `${n.name || '(no name)'} [${d.protocol}${n.kind ? ` ${n.kind}` : ''}] ${p.rssi} dBm ${p.snr} dB${n.hops !== undefined ? `, ${n.hops} hops` : ''}`)
    for (const m of learned.messages ?? []) posts.push(`${m.channel} · ${m.sender}: ${m.text}`)
  }
})
client.on('linkError', (e) => {
  link[e.kind] = (link[e.kind] ?? 0) + 1
  console.log(`${stamp()} LINK ${LINK_ERROR_NAMES[e.kind]}: ${e.reason}  ${toHex(e.bytes.subarray(0, 40), ' ')}`)
})
client.on('sessionLost', (r) => console.log(`${stamp()} session lost: ${r}`))
client.on('recovered', () => console.log(`${stamp()} session restored`))

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  listening = false
  clearInterval(statusTimer)
  try {
    await client.rxStop()
    console.log(`${stamp()} RX_STOP ok`)
  } catch (err) {
    console.log(`${stamp()} RX_STOP failed: ${err instanceof Error ? err.message : err}`)
  }
  await client.disconnect()
  const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)} … ${Math.max(...xs)} (avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)})` : '-')
  console.log('\nsummary')
  console.log(`  listened      ${((Date.now() - t0) / 1000).toFixed(0)} s on ${describeConfig(preset.config)}`)
  console.log(`  RX events     ${rx}: CRC ok ${rx - crcFail}, CRC fail ${crcFail}; dropped by device ${dropped}`)
  console.log(`  decode        ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  failed stage  ${Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  console.log(`  link errors   ${Object.entries(link).map(([k, v]) => `${LINK_ERROR_NAMES[k as LinkErrorKind]} ${v}`).join(', ') || 'none'}`)
  console.log(`  RSSI dBm      ${range(rssi)}   (CRC-ok packets)`)
  console.log(`  SNR dB        ${range(snr)}`)
  const nf = noise.snapshot(Date.now(), 'packet-estimate')
  console.log(`  noise (est.)  per packet ${noiseEstimates.length ? noiseEstimates.map((v) => Math.round(v)).join(' ') : '-'} dBm`)
  console.log(`  noise floor   from packets: MeshCore method ${nf.floor !== undefined ? `${nf.floor} dBm` : `pending (${nf.pending}/${NUM_NOISE_FLOOR_SAMPLES} samples)`}, median of last ${MEDIAN_WINDOW} ${nf.median ?? '-'} dBm`)
  if (statusSupported) {
    const m = noise.snapshot(Date.now(), 'measured')
    console.log(`  RADIO_STATUS  ${statusReplies} replies while listening, ${statusReplies - rssiInst.length} without RSSI; rssi_inst dBm ${range(rssiInst)}`)
    console.log(`  noise floor   measured: MeshCore method ${m.floor !== undefined ? `${m.floor} dBm` : `pending (${m.pending}/${NUM_NOISE_FLOOR_SAMPLES} samples)`}, median of last ${MEDIAN_WINDOW} ${m.median ?? '-'} dBm, ${m.accepted} used, ${m.rejected} over floor + 14 dB`)
    if (lastStatus) {
      console.log(`  counters      since boot (+while listening): ${counters(lastStatus)}`)
      console.log(`                the probe saw ${rx - crcFail} CRC ok and ${crcFail} CRC fail RX events; header errors never reach the host`)
      console.log(`  front end     RX gain ${RX_GAIN_NAMES[lastStatus.rxGain] ?? lastStatus.rxGain}; ${femText(lastStatus)}`)
    }
  } else console.log('  RADIO_STATUS  not supported by this firmware (no capability bit 33)')
  console.log(`  nodes         ${nodes.size ? '' : 'none'}`)
  for (const n of nodes.values()) console.log(`    ${n}`)
  console.log(`  messages      ${posts.length ? '' : 'none'}`)
  for (const p of posts) console.log(`    ${p}`)
  const h = client.health
  console.log(`  keepalive     ${h.pings} ${h.command} ok, ${h.failures} failed, avg rtt ${h.avgRttMs?.toFixed(1) ?? '-'} ms, longest gap ${h.maxGapMs} ms, sessions lost ${h.lostSessions}`)
  process.exit(0)
}
process.on('SIGINT', () => void stop())

console.log(`opening ${path} (${match.usbId}${match.serialNumber ? `, serial ${match.serialNumber}` : ''})`)
console.log("don't connect a browser tab to the dongle while this runs: Chrome can open the port alongside it")
await client.connect()
const info = await client.getInfo()
const caps = Object.entries(CAPABILITY_NAMES).filter(([b]) => ((info.capabilities >> BigInt(b)) & 1n) === 1n).map(([, n]) => n)
statusSupported = hasCapability(info, Capability.RadioStatus)
console.log(`GET_INFO: DongLoRa ${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}, protocol ${info.protocol.major}.${info.protocol.minor}, ${RADIO_CHIP_NAMES[info.radioChipId]}`)
console.log(`  ${mhz(info.freqMinHz)}–${mhz(info.freqMaxHz)} MHz, ${info.txPowerMinDbm}…${info.txPowerMaxDbm} dBm, SF bitmap 0x${info.sfBitmap.toString(16)}, BW bitmap 0x${info.bwBitmap.toString(16)}`)
console.log(`  caps ${caps.join(', ')} (0x${info.capabilities.toString(16)}), max payload ${info.maxPayloadBytes}, RX queue ${info.rxQueueCapacity}, TX queue ${info.txQueueCapacity}, MCU UID ${info.mcuUid}`)
const reply = await client.setConfig(preset.config)
const e = reply.lora
console.log(`SET_CONFIG ${preset.name}: result ${reply.result}, owner ${reply.owner}`)
console.log(e ? `  echo: ${describeConfig(e)}, preamble ${e.preambleLen}, sync ${syncWordHex(e.syncWord)}, ${e.txPowerDbm} dBm, ${e.implicitHeader ? 'implicit' : 'explicit'} header, CRC ${e.payloadCrc ? 'on' : 'off'}, IQ ${e.iqInvert ? 'inverted' : 'normal'}` : `  echo: modulation ${reply.modulation}, ${toHex(reply.params)}`)
const same = e && JSON.stringify(e) === JSON.stringify(preset.config)
console.log(`  ${same ? 'matches the request' : 'DIFFERS from the request'}`)
await client.rxStart()
listening = true
console.log(`RX_START ok, listening ${seconds} s (Ctrl-C to stop early)${statusSupported ? '; RADIO_STATUS is the keepalive, printed once a second' : ''}\n`)
if (statusSupported) statusTimer = setInterval(printStatus, 1000)
setTimeout(() => void stop(), seconds * 1000)
