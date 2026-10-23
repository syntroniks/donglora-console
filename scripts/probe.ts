// Receive-only check against a real dongle over USB:
//   pnpm probe [port] [--seconds 60]
// GET_INFO, SET_CONFIG with the MeshCore USA/Canada preset, RX_START, then every RX event for N seconds
// (failed ones with their reasons and bytes), then RX_STOP and a summary. It never transmits.
// The port must be a DongLoRa by USB VID:PID (1209:5741, or a known USB-UART bridge).

import { toHex } from '../src/protocol/bytes.ts'
import { DongLoRaClient, LINK_ERROR_NAMES, type LinkErrorKind } from '../src/protocol/client.ts'
import { CAPABILITY_NAMES, RADIO_CHIP_NAMES } from '../src/protocol/codes.ts'
import { describeConfig, mhz, syncWordHex } from '../src/protocol/lora.ts'
import { intervalTicker } from '../src/protocol/ticker.ts'
import { decodeMeshCore, type DecodeStage, type DecodeStatus } from '../src/meshcore/decode.ts'
import { DEFAULT_PRESET } from '../src/meshcore/presets.ts'
import { MEDIAN_WINDOW, NoiseFloorTracker, NUM_NOISE_FLOOR_SAMPLES } from '../src/radio/noiseFloor.ts'
import { findDongles, NodeSerialTransport } from './node-serial.ts'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const seconds = Number(flag('--seconds') ?? 60)
const pathArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--seconds')

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
const status: Record<DecodeStatus, number> = { decoded: 0, partial: 0, undecodable: 0, 'no-key': 0 }
const stages: Partial<Record<DecodeStage, number>> = {}
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

client.on('rx', (p) => {
  rx++
  dropped += p.packetsDropped
  const d = decodeMeshCore(p.data)
  status[d.status]++
  if (d.failure) stages[d.failure.stage] = (stages[d.failure.stage] ?? 0) + 1
  if (p.crcValid) {
    rssi.push(p.rssi)
    snr.push(p.snr)
  } else crcFail++
  const n = noise.addPacket(p.rssi, p.snr, p.crcValid)
  if (n !== undefined) noiseEstimates.push(n)
  const meta = `${p.rssi} dBm ${p.snr} dB noise ${n !== undefined ? Math.round(n) : '-'} ferr ${p.freqErr} Hz ${p.data.length}B${p.packetsDropped ? ` (${p.packetsDropped} dropped before)` : ''}`
  const crc = p.crcValid ? 'crc ok  ' : 'CRC FAIL'
  if (d.status === 'decoded' || d.status === 'no-key') {
    console.log(`${stamp()} ${crc} ${meta}  ${d.status}: ${d.summary}`)
  } else {
    console.log(`${stamp()} ${crc} ${meta}  ${d.status.toUpperCase()} at ${d.failure!.stage} stage, byte ${d.failure!.offset}: ${d.failure!.reason}`)
    console.log(`           ${toHex(p.data, ' ')}`)
  }
  if (!p.crcValid && d.status === 'decoded') console.log('           (decoded, but the radio CRC failed: untrusted)')
  if (p.crcValid && d.status === 'decoded') {
    if (d.advert?.publicKey) nodes.set(d.advert.publicKey, `${d.advert.name || '(no name)'} [${d.advert.typeName}] ${p.rssi} dBm ${p.snr} dB, ${d.hops} hops`)
    if (d.group?.text !== undefined) posts.push(`${d.group.channel}: ${d.group.text}`)
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
  try {
    await client.rxStop()
    console.log(`${stamp()} RX_STOP ok`)
  } catch (err) {
    console.log(`${stamp()} RX_STOP failed: ${err instanceof Error ? err.message : err}`)
  }
  await client.disconnect()
  const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)} … ${Math.max(...xs)} (avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)})` : '-')
  console.log('\nsummary')
  console.log(`  listened      ${((Date.now() - t0) / 1000).toFixed(0)} s on ${describeConfig(DEFAULT_PRESET.config)}`)
  console.log(`  RX events     ${rx}: CRC ok ${rx - crcFail}, CRC fail ${crcFail}; dropped by device ${dropped}`)
  console.log(`  decode        ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`  failed stage  ${Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  console.log(`  link errors   ${Object.entries(link).map(([k, v]) => `${LINK_ERROR_NAMES[k as LinkErrorKind]} ${v}`).join(', ') || 'none'}`)
  console.log(`  RSSI dBm      ${range(rssi)}   (CRC-ok packets)`)
  console.log(`  SNR dB        ${range(snr)}`)
  const nf = noise.snapshot()
  console.log(`  noise (est.)  per packet ${noiseEstimates.length ? noiseEstimates.map((v) => Math.round(v)).join(' ') : '-'} dBm`)
  console.log(`  noise floor   MeshCore method ${nf.floor !== undefined ? `${nf.floor} dBm` : `pending (${nf.pending}/${NUM_NOISE_FLOOR_SAMPLES} samples)`}, median of last ${MEDIAN_WINDOW} ${nf.median ?? '-'} dBm`)
  console.log(`  nodes         ${nodes.size ? '' : 'none'}`)
  for (const n of nodes.values()) console.log(`    ${n}`)
  console.log(`  Public posts  ${posts.length ? '' : 'none'}`)
  for (const p of posts) console.log(`    ${p}`)
  const h = client.health
  console.log(`  keepalive     ${h.pings} PINGs, ${h.failures} failed, avg rtt ${h.avgRttMs?.toFixed(1) ?? '-'} ms, longest gap ${h.maxGapMs} ms, sessions lost ${h.lostSessions}`)
  process.exit(0)
}
process.on('SIGINT', () => void stop())

console.log(`opening ${path} (${match.usbId}${match.serialNumber ? `, serial ${match.serialNumber}` : ''})`)
console.log("don't connect a browser tab to the dongle while this runs: Chrome can open the port alongside it")
await client.connect()
const info = await client.getInfo()
const caps = Object.entries(CAPABILITY_NAMES).filter(([b]) => ((info.capabilities >> BigInt(b)) & 1n) === 1n).map(([, n]) => n)
console.log(`GET_INFO: DongLoRa ${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}, protocol ${info.protocol.major}.${info.protocol.minor}, ${RADIO_CHIP_NAMES[info.radioChipId]}`)
console.log(`  ${mhz(info.freqMinHz)}–${mhz(info.freqMaxHz)} MHz, ${info.txPowerMinDbm}…${info.txPowerMaxDbm} dBm, SF bitmap 0x${info.sfBitmap.toString(16)}, BW bitmap 0x${info.bwBitmap.toString(16)}`)
console.log(`  caps ${caps.join(', ')} (0x${info.capabilities.toString(16)}), max payload ${info.maxPayloadBytes}, RX queue ${info.rxQueueCapacity}, TX queue ${info.txQueueCapacity}, MCU UID ${info.mcuUid}`)
const reply = await client.setConfig(DEFAULT_PRESET.config)
const e = reply.lora
console.log(`SET_CONFIG ${DEFAULT_PRESET.name}: result ${reply.result}, owner ${reply.owner}`)
console.log(e ? `  echo: ${describeConfig(e)}, preamble ${e.preambleLen}, sync ${syncWordHex(e.syncWord)}, ${e.txPowerDbm} dBm, ${e.implicitHeader ? 'implicit' : 'explicit'} header, CRC ${e.payloadCrc ? 'on' : 'off'}, IQ ${e.iqInvert ? 'inverted' : 'normal'}` : `  echo: modulation ${reply.modulation}, ${toHex(reply.params)}`)
const same = e && JSON.stringify(e) === JSON.stringify(DEFAULT_PRESET.config)
console.log(`  ${same ? 'matches the request' : 'DIFFERS from the request'}`)
await client.rxStart()
console.log(`RX_START ok, listening ${seconds} s (Ctrl-C to stop early)\n`)
setTimeout(() => void stop(), seconds * 1000)
