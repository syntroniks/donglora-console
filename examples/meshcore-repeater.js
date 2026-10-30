// MeshCore repeater, the way a firmware repeater (MeshCore examples/simple_repeater) forwards traffic.
// Needs "may transmit" ticked for the script and TX armed on the Radio tab, or the console server started
// with `pnpm server --allow-tx --script examples/meshcore-repeater.js`.
//
// Flood packets (channel posts, adverts, requests...) are heard once, get this node's hash added to their path
// and go out again after a random delay. Not forwarded: repeats, ones past the hop limit, ones that already pass
// through this node too often, forged adverts and region-scoped packets. Direct packets, which carry their route,
// are forwarded only when this node's hash is next on the path, with it taken off. Traces get their SNR added.
// A node ID is made once and kept; a flood repeater needs no key, but give it the start of a real repeater's
// public key (NODE_ID) to forward the direct routes that repeater is on.
// It never talks for itself: no adverts (they need the Ed25519 key), no replies, no CLI.

const NODE_ID = '' // hex, 2 to 8 bytes: the start of this node's public key. Empty: made once and remembered
const PRESET = 'meshcore-us' // the radio is put on this when it isn't on a MeshCore config
const FLOOD_MAX = 64 // longest path to forward (flood.max)
const FLOOD_MAX_ADVERT = 8 // longest path to forward an advert on (flood.max.advert)
const TX_DELAY_FACTOR = 0.5 // flood retransmit delay: random up to 5 x airtime x this (txdelay)
const DIRECT_TX_DELAY_FACTOR = 0.3 // the same for direct packets (direct.txdelay)
const ALLOW_SCOPED = false // forward region-scoped (transport) floods; the repeater firmware drops them without a region
const DUTY_CYCLE_MAX = 0.1 // most of any hour spent transmitting; 0 for no limit
const QUEUE_MAX = 16 // packets waiting for their turn; more are dropped
const BUSY_TRIES = 3 // sends tried for a packet that keeps finding the channel busy
const SEEN_MAX = 160 // payloads remembered for telling repeats (the firmware's 128 + 32)
const VERBOSE = true // one line per forwarded packet

const BW_KHZ = [7.81, 10.42, 15.63, 20.83, 31.25, 41.67, 62.5, 125, 250, 500]
const TYPE = { ack: 3, advert: 4, grpTxt: 5, grpData: 6, anonReq: 7, path: 8, trace: 9, multipart: 10, control: 11 }
const NAME = ['request', 'response', 'text', 'ack', 'advert', 'group-text', 'group-data', 'anon-request', 'path', 'trace', 'multipart', 'control']
// payload bytes a flood packet of each type needs before the firmware looks at it
const MIN_PAYLOAD = { 0: 5, 1: 5, 2: 5, 8: 5, 3: 4, 4: 100, 5: 4, 6: 4, 7: 36 }
const LOOP_MAX = [0, 4, 2, 1] // how often a flood may already pass through this node, by path hash size (loop.detect minimal)

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const startsWith = (bytes, at, prefix, n) => n <= prefix.length && bytes.length >= at + n && prefix.slice(0, n).every((x, i) => bytes[at + i] === x)

// ---- who we are ----
let id = NODE_ID.replace(/\s+/g, '').toLowerCase() || (await storage.get('nodeId')) || ''
if (!id) {
  const b = crypto.getRandomValues(new Uint8Array(8))
  while (b[0] === 0x00 || b[0] === 0xff) crypto.getRandomValues(b) // first bytes 00 and FF are reserved
  id = hex(b)
  await storage.set('nodeId', id)
}
if (!/^([0-9a-f]{2}){2,8}$/.test(id)) throw new Error(`NODE_ID must be 2 to 8 bytes of hex, got "${id}"`)
const self = Uint8Array.from(id.match(/../g), (x) => parseInt(x, 16))
if (self[0] === 0x00 || self[0] === 0xff) throw new Error('NODE_ID can\'t start with 00 or ff: those hashes are reserved')

// ---- the radio ----
const meshcore = async () => (await radio.plugins()).find((p) => p.id === 'meshcore')
if (!(await meshcore())?.decoding) {
  print(`the radio isn't on a MeshCore config; switching to ${PRESET}`)
  await radio.setConfig(PRESET)
  await radio.rxStart()
}

/** Time on air in ms for a packet of this many bytes (Semtech AN1200.13), on the radio's current config. */
async function airtimeMs(bytes) {
  const { requested, applied } = await radio.config()
  const c = applied?.lora ?? requested
  const tsym = 2 ** c.sf / (BW_KHZ[c.bw] ?? 125)
  const de = tsym > 16 ? 1 : 0
  const ih = c.implicitHeader ? 1 : 0
  const num = 8 * bytes - 4 * c.sf + 28 + 16 * (c.payloadCrc ? 1 : 0) - 20 * ih
  const symbols = 8 + Math.max(Math.ceil(num / (4 * (c.sf - 2 * de))) * (c.cr + 5), 0)
  return (c.preambleLen + (c.sf <= 6 ? 6.25 : 4.25) + symbols) * tsym
}

// ---- reading a packet (docs/packet_format.md) ----
function parse(b) {
  if (b.length < 3) return undefined
  const route = b[0] & 3
  const transport = route === 0 || route === 3
  let at = transport ? 5 : 1
  if (b.length < at + 1 || b[0] >> 6 !== 0) return undefined // only payload version 1 exists
  const pathLen = b[at++]
  const hashSize = (pathLen >> 6) + 1
  const count = pathLen & 63
  if (hashSize === 4 || count * hashSize > 64 || b.length < at + count * hashSize) return undefined
  const payload = b.slice(at + count * hashSize)
  if (!payload.length || payload.length > 184) return undefined
  return { header: b[0], route, direct: route >= 2, type: (b[0] >> 2) & 15, codes: transport ? b.slice(1, 5) : undefined, pathLen, hashSize, count, path: b.slice(at, at + count * hashSize), payload }
}

function build(pkt, pathLen, path, payload = pkt.payload) {
  return Uint8Array.from([pkt.header, ...(pkt.codes ?? []), pathLen, ...path, ...payload])
}

// ---- repeats ----
const seen = new Set()
const seenKey = (pkt) => `${pkt.type}:${hex(pkt.payload)}${pkt.type === TYPE.trace ? `:${pkt.pathLen}` : ''}`
function firstTime(pkt) {
  const key = seenKey(pkt)
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
  return true
}

const stats = { heard: 0, flood: 0, direct: 0, trace: 0, repeat: 0, limit: 0, loop: 0, forged: 0, scoped: 0, queueFull: 0, duty: 0, busy: 0, failed: 0 }

// ---- what to forward ----
/** A flood packet: our hash on the end of its path, unless the firmware wouldn't forward it. */
function flood(pkt, p) {
  const need = MIN_PAYLOAD[pkt.type]
  if (!need || pkt.payload.length < need) return undefined // types a repeater doesn't flood, and truncated ones
  if (pkt.type === TYPE.advert && p.decode.data?.advert?.signatureValid !== true) {
    stats.forged++
    return undefined
  }
  if (!firstTime(pkt)) return void stats.repeat++
  if (pkt.route === 0 && !ALLOW_SCOPED) return void stats.scoped++
  if (pkt.count >= FLOOD_MAX || (pkt.type === TYPE.advert && pkt.count >= FLOOD_MAX_ADVERT) || (pkt.count + 1) * pkt.hashSize > 64) return void stats.limit++
  let passes = 0
  for (let i = 0; i < pkt.count; i++) if (startsWith(pkt.path, i * pkt.hashSize, self, pkt.hashSize)) passes++
  if (passes >= LOOP_MAX[pkt.hashSize]) return void stats.loop++
  if (self.length < pkt.hashSize) return undefined
  const path = Uint8Array.from([...pkt.path, ...self.slice(0, pkt.hashSize)])
  return { bytes: build(pkt, pkt.pathLen + 1, path), pri: pkt.count + 1, factor: TX_DELAY_FACTOR, pathBytes: path.length, kind: 'flood', pkt }
}

/** A direct packet: forwarded when we are next on its path, with our hash taken off it. */
function direct(pkt, p) {
  if (pkt.type === TYPE.trace) return trace(pkt, p)
  if (pkt.type === TYPE.control && pkt.payload[0] & 0x80) return undefined // zero-hop control data
  if (!pkt.count || pkt.type === TYPE.multipart || !startsWith(pkt.path, 0, self, pkt.hashSize)) return undefined
  if (!firstTime(pkt)) return void stats.repeat++
  const path = pkt.path.slice(pkt.hashSize)
  return { bytes: build(pkt, pkt.pathLen - 1, path), pri: 0, factor: DIRECT_TX_DELAY_FACTOR, pathBytes: pkt.path.length, kind: 'direct', pkt }
}

/** A trace: the path to walk is in the payload and the path field collects each hop's SNR, 4 x dB as a signed byte. */
function trace(pkt, p) {
  const pl = pkt.payload
  if (pl.length < 9 || pkt.pathLen >= 64) return undefined
  const size = 1 << (pl[8] & 3)
  const at = 9 + (pkt.pathLen << (pl[8] & 3))
  if (at >= pl.length || !startsWith(pl, at, self, size) || !firstTime(pkt)) return undefined
  const snr = Math.max(-128, Math.min(127, Math.trunc(p.rx.snr * 4)))
  return { bytes: build(pkt, pkt.pathLen + 1, Uint8Array.from([...pkt.path, snr & 0xff])), pri: 5, factor: DIRECT_TX_DELAY_FACTOR, pathBytes: pkt.path.length, kind: 'trace', pkt }
}

// ---- sending, one at a time, in priority order once each one's delay is up ----
const queue = []
const sent = [] // { at, ms } of recent transmissions, for the duty cycle
let pumping = false
let refused = 0

async function enqueue(out) {
  if (queue.length >= QUEUE_MAX) return void stats.queueFull++
  const t = Math.floor((await airtimeMs(out.pathBytes + out.pkt.payload.length + 2)) * out.factor)
  out.delay = Math.floor(Math.random() * (5 * t + 1))
  out.at = Date.now() + out.delay
  out.tries = 0
  queue.push(out)
  void pump()
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.length) {
      const now = Date.now()
      const due = queue.filter((e) => e.at <= now).sort((a, b) => a.pri - b.pri || a.at - b.at)
      if (!due.length) {
        await sleep(Math.max(5, Math.min(25, Math.min(...queue.map((e) => e.at)) - now))) // short, so a packet queued meanwhile isn't kept waiting
        continue
      }
      queue.splice(queue.indexOf(due[0]), 1)
      await send(due[0])
    }
  } finally {
    pumping = false
  }
}

async function send(out) {
  const hour = Date.now() - 3_600_000
  while (sent.length && sent[0].at < hour) sent.shift()
  const used = sent.reduce((n, s) => n + s.ms, 0)
  if (DUTY_CYCLE_MAX > 0 && used + (await airtimeMs(out.bytes.length)) > DUTY_CYCLE_MAX * 3_600_000) return void stats.duty++
  let done
  try {
    done = await radio.tx(out.bytes)
  } catch (err) {
    stats.failed++
    // not allowed to transmit is the same for every packet: say it once a minute, not for each
    if (Date.now() - refused > 60_000) warn(`can't transmit: ${err.message}`)
    refused = Date.now()
    return
  }
  if (done.result === 1 && ++out.tries < BUSY_TRIES) {
    stats.busy++
    out.at = Date.now() + (1 + Math.floor(Math.random() * 3)) * 120 // the firmware's retry after a busy channel
    queue.push(out)
    return
  }
  if (done.result !== 0) return void stats.failed++
  sent.push({ at: Date.now(), ms: done.airtimeUs / 1000 })
  stats[out.kind]++
  if (VERBOSE) print(`${out.kind} ${NAME[out.pkt.type] ?? `type ${out.pkt.type}`}, ${out.pkt.count} -> ${out.kind === 'direct' ? out.pkt.count - 1 : out.pkt.count + 1} hops, ${out.bytes.length} B, delayed ${out.delay} ms`)
}

on('packet', async (p) => {
  stats.heard++
  if (!p.rx.crcValid || p.rx.origin !== 0) return // our own sends come back as another client's TX through mux
  const pkt = parse(p.rx.data)
  if (!pkt) return
  const out = pkt.direct ? direct(pkt, p) : flood(pkt, p)
  if (out) await enqueue(out)
})

every(300_000, () => {
  const s = stats
  print(`5 min: heard ${s.heard}; forwarded ${s.flood} flood, ${s.direct} direct, ${s.trace} trace; skipped ${s.repeat} repeats, ${s.limit} over the hop limit, ${s.loop} loops, ${s.forged} forged adverts, ${s.scoped} scoped; dropped ${s.queueFull} queue, ${s.duty} duty cycle, ${s.failed} failed, ${s.busy} busy retries`)
  for (const k of Object.keys(s)) s[k] = 0
})

print(`repeater up: node ${id.slice(0, 6)}${id.length > 6 ? '...' : ''} (path hash ${id.slice(0, 2)}), forwarding up to ${FLOOD_MAX} hops, ${DUTY_CYCLE_MAX ? `${DUTY_CYCLE_MAX * 100}% duty cycle` : 'no duty cycle limit'}`)
