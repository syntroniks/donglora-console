// examples/meshcore-repeater.js end to end: the real script in the real sandbox, hearing exact packets from the
// simulated dongle and sending what it would put on the air. The rules are MeshCore's (src/Mesh.cpp,
// examples/simple_repeater/MyMesh.cpp).

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advertPayload, buildPacket, groupTextPayload } from '../src/meshcore/build.ts'
import { PayloadType } from '../src/meshcore/codes.ts'
import { PUBLIC_CHANNEL } from '../src/meshcore/crypto.ts'
import { MESHCORE_SYNC_WORD } from '../src/meshcore/presets.ts'
import { presetById } from '../src/plugins/index.ts'
import { airtimeUs } from '../src/protocol/lora.ts'
import { MOCK_INFO_1_6, MockDongLoRaTransport } from '../src/protocol/transports/mock.ts'
import { RadioStore } from '../src/radio/store.ts'
import { ScriptHost, type ScriptLine, type ScriptSpec } from '../src/scripts/host.ts'
import { spawnScriptWorker } from './scripts.ts'

const SOURCE = readFileSync(new URL('../examples/meshcore-repeater.js', import.meta.url), 'utf8')
const ID = 'a1b2c3d4e5f60708'
const SELF = 0xa1

/** The script with settings changed: `const NAME = value` for each one given. No delays unless asked. */
function variant(settings: Record<string, string> = {}): string {
  const all = { NODE_ID: `'${ID}'`, TX_DELAY_FACTOR: '0', DIRECT_TX_DELAY_FACTOR: '0', ...settings }
  let src = SOURCE
  for (const [name, value] of Object.entries(all)) {
    const re = new RegExp(`^const ${name} = [^/\\n]*?( *//|$)`, 'm')
    expect(src, `no setting ${name}`).toMatch(re)
    src = src.replace(re, (_m, tail: string) => `const ${name} = ${value}${tail}`)
  }
  return src
}

let mock: MockDongLoRaTransport
let store: RadioStore
let host: ScriptHost
let lines: ScriptLine[]
let canTx: boolean
let data: Map<string, unknown>

const spec = (source: string, allowTx = true): ScriptSpec => ({ id: 'repeater', name: 'repeater', source, allowTx })
const printed = () => lines.map((l) => `${l.level}: ${l.text}`)

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out; output so far:\n${printed().join('\n')}\ntransmitted ${mock.transmitted.length}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function start(source = variant()): Promise<void> {
  lines = [] // a restart prints its own "repeater up"; don't mistake the last run's
  host.start(spec(source))
  await until(() => printed().some((l) => l.includes('repeater up')))
}

/** Tell the script to send when it hears `control`: it only counts as heard once its own copy is on the air. */
const hear = (bytes: Uint8Array, crcValid = true) => expect(mock.injectRaw(bytes, crcValid)).toBe(true)
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A flood channel post. Distinct text gives a distinct payload, so packets don't count as repeats of each other. */
const post = (text: string, path: number[] = [], hashSize = 1) =>
  buildPacket({ payloadType: PayloadType.GroupText, hashSize, path: Uint8Array.from(path) }, groupTextPayload(PUBLIC_CHANNEL, 1_700_000_000, text))

/** After `bytes` are heard and a control packet is forwarded behind them, what went out for `bytes`. */
async function forwardedOf(bytes: Uint8Array): Promise<Uint8Array[]> {
  const before = mock.transmitted.length
  hear(bytes)
  const control = post(`control ${Math.random()}`)
  hear(control)
  const controlHex = hexOf(control.subarray(2)) // payload only: the path grew by our hash
  await until(() => mock.transmitted.slice(before).some((t) => hexOf(t).endsWith(controlHex)))
  return mock.transmitted.slice(before).filter((t) => !hexOf(t).endsWith(controlHex))
}

beforeEach(async () => {
  lines = []
  canTx = true
  data = new Map()
  mock = new MockDongLoRaTransport({ traffic: false, busyRate: 0, info: MOCK_INFO_1_6 })
  store = new RadioStore()
  await store.connectTransport(mock, true)
  host = new ScriptHost(store, {
    spawn: spawnScriptWorker,
    txRefusal: (s) => (!s.allowTx ? 'this script may not transmit' : !canTx ? 'TX is not armed' : undefined),
    armForTx: true,
    output: (_s, line) => lines.push(line),
    storage: { get: (id, k) => data.get(`${id}/${k}`), set: (id, k, v) => void data.set(`${id}/${k}`, v) },
  })
})

afterEach(async () => {
  host.stopAll()
  await store.disconnect()
})

describe('flood packets', () => {
  it('forwards a channel post with this node’s hash on the end of its path, payload untouched', async () => {
    await start()
    const heard = post('Bob: hello', [0x11, 0x22])
    hear(heard)
    await until(() => mock.transmitted.length === 1)
    const sent = mock.transmitted[0]
    expect(hexOf(sent)).toBe(hexOf(Uint8Array.from([heard[0], 3, 0x11, 0x22, SELF, ...heard.subarray(4)])))
  })

  it('uses as much of its ID as the packet’s path hashes are long', async () => {
    await start()
    const heard = post('Bob: two byte hashes', [0x11, 0x12], 2)
    hear(heard)
    await until(() => mock.transmitted.length === 1)
    // path length byte: 2-byte hashes (0b01) and 2 hops
    expect(hexOf(mock.transmitted[0].subarray(0, 8))).toBe(hexOf(Uint8Array.from([heard[0], 0x42, 0x11, 0x12, 0xa1, 0xb2, ...heard.subarray(4, 6)])))
  })

  it('forwards a packet once, however many copies it hears', async () => {
    await start()
    const heard = post('Bob: echo echo')
    hear(heard)
    hear(post('Bob: echo echo', [0x33])) // the same payload, one hop further along, by another repeater
    hear(post('Bob: echo echo', [0x44, 0x55]))
    // one copy of the echoed post went out, then the unrelated one
    expect(await forwardedOf(post('Bob: unrelated'))).toHaveLength(2)
    expect(mock.transmitted.filter((t) => hexOf(t).endsWith(hexOf(heard.subarray(2))))).toHaveLength(1)
  })

  it('stops at the hop limit', async () => {
    await start(variant({ FLOOD_MAX: '2' }))
    expect(await forwardedOf(post('Bob: too far', [1, 2]))).toHaveLength(0)
    expect(await forwardedOf(post('Bob: just in time', [1]))).toHaveLength(1)
  })

  it('lets an advert go only 8 hops, and only when its signature is good', async () => {
    await start()
    const secretKey = new Uint8Array(32).fill(7)
    let when = 1_700_000_000
    const advert = (path: number[], tamper = false) => {
      // a new timestamp each, or the later ones are repeats of the first
      const payload = advertPayload({ secretKey, timestamp: when++, type: 2, name: 'R' })
      if (tamper) payload[40] ^= 0xff // inside the signature
      return buildPacket({ payloadType: PayloadType.Advert, path: Uint8Array.from(path) }, payload)
    }
    expect(await forwardedOf(advert([1, 2, 3, 4, 5, 6, 7, 8]))).toHaveLength(0)
    expect(await forwardedOf(advert([1, 2], true))).toHaveLength(0)
    expect(await forwardedOf(advert([1, 2, 3, 4, 5, 6, 7]))).toHaveLength(1)
  })

  it('does not take part in a loop: its own hash 4 times in a 1-byte path is the limit', async () => {
    await start()
    expect(await forwardedOf(post('Bob: looping', [SELF, 2, SELF, 3, SELF, 4, SELF]))).toHaveLength(0)
    expect(await forwardedOf(post('Bob: nearly', [SELF, 2, SELF, 3, SELF]))).toHaveLength(1)
  })

  it('drops region-scoped floods unless told to forward them', async () => {
    const scoped = buildPacket({ routeType: 0, transportCodes: [0x1234, 0x5678], payloadType: PayloadType.GroupText }, groupTextPayload(PUBLIC_CHANNEL, 1_700_000_001, 'Bob: scoped'))
    await start()
    expect(await forwardedOf(scoped)).toHaveLength(0)
    host.stop('repeater')
    await start(variant({ ALLOW_SCOPED: 'true' }))
    mock.transmitted.length = 0
    const sent = await forwardedOf(scoped)
    expect(sent).toHaveLength(1)
    expect(hexOf(sent[0].subarray(0, 6))).toBe(hexOf(scoped.subarray(0, 5)) + '01') // header, both codes, one hop
  })

  it('ignores packets with a bad CRC, other versions, and types a repeater doesn’t flood', async () => {
    await start()
    hear(post('Bob: damaged'), false)
    const v2 = post('Bob: from the future')
    v2[0] |= 0x40
    const raw = buildPacket({ payloadType: PayloadType.RawCustom }, new Uint8Array(20).fill(9))
    const ctl = buildPacket({ payloadType: PayloadType.Control }, new Uint8Array(20).fill(0x80))
    const sent = [...(await forwardedOf(v2)), ...(await forwardedOf(raw)), ...(await forwardedOf(ctl))]
    expect(sent).toHaveLength(0)
    expect(mock.transmitted.some((t) => hexOf(t).includes(hexOf(post('Bob: damaged').subarray(3))))).toBe(false)
  })
})

describe('direct packets', () => {
  const direct = (path: number[], payloadType: number = PayloadType.Text) => buildPacket({ routeType: 2, payloadType, path: Uint8Array.from(path) }, new Uint8Array(24).fill(0x5a))

  it('forwards when this node is next on the path, with its hash taken off', async () => {
    await start()
    const heard = direct([SELF, 0x77, 0x88])
    const sent = await forwardedOf(heard)
    expect(sent).toHaveLength(1)
    expect(hexOf(sent[0].subarray(0, 4))).toBe(hexOf(Uint8Array.from([heard[0], 2, 0x77, 0x88])))
    expect(hexOf(sent[0].subarray(4))).toBe(hexOf(heard.subarray(5)))
  })

  it('leaves alone what is for another hop, and zero-hop packets', async () => {
    await start()
    expect(await forwardedOf(direct([0x77, SELF]))).toHaveLength(0)
    expect(await forwardedOf(direct([]))).toHaveLength(0)
    expect(await forwardedOf(direct([SELF], PayloadType.Advert))).toHaveLength(1) // routed adverts are routed like the rest
  })

  it('forwards a direct packet once', async () => {
    await start()
    const heard = direct([SELF, 0x66])
    hear(heard)
    hear(heard)
    expect(await forwardedOf(direct([0x01]))).toHaveLength(1)
  })

  it('keeps the transport codes of a scoped direct packet', async () => {
    await start()
    const heard = buildPacket({ routeType: 3, transportCodes: [0xaaaa, 0xbbbb], payloadType: PayloadType.Request, path: Uint8Array.from([SELF, 9]) }, new Uint8Array(24).fill(1))
    const sent = await forwardedOf(heard)
    expect(hexOf(sent[0].subarray(0, 7))).toBe(hexOf(Uint8Array.from([heard[0], 0xaa, 0xaa, 0xbb, 0xbb, 1, 9])))
  })

  it('adds its SNR to a trace that has reached it', async () => {
    await start()
    // tag, auth, flags (1-byte hashes), then the hashes to walk: this node is the second
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0x99, SELF, 0xbb])
    const heard = buildPacket({ routeType: 2, payloadType: PayloadType.Trace, path: Uint8Array.from([0x14]) }, payload) // one SNR collected so far
    const sent = await forwardedOf(heard)
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toBe(2)
    expect(sent[0][2]).toBe(0x14)
    const snr = (sent[0][3] << 24) >> 24
    expect(snr).toBeGreaterThanOrEqual(-60) // the simulated radio hears 4 x between -13 and +30 dB
    expect(snr).toBeLessThanOrEqual(120)
    expect(hexOf(sent[0].subarray(4))).toBe(hexOf(payload))
    // and one that isn't at this node yet, or has finished its path, is left alone
    const early = buildPacket({ routeType: 2, payloadType: PayloadType.Trace, path: new Uint8Array(0) }, payload)
    const done = buildPacket({ routeType: 2, payloadType: PayloadType.Trace, path: Uint8Array.from([1, 2, 3]) }, payload)
    expect(await forwardedOf(early)).toHaveLength(0)
    expect(await forwardedOf(done)).toHaveLength(0)
  })
})

describe('sending', () => {
  it('says once that it can’t transmit, and keeps listening', async () => {
    canTx = false
    await start()
    hear(post('Bob: one'))
    hear(post('Bob: two'))
    await until(() => printed().some((l) => l.startsWith("warn: can't transmit: tx(): TX is not armed")))
    await new Promise((r) => setTimeout(r, 150))
    expect(printed().filter((l) => l.includes("can't transmit"))).toHaveLength(1)
    expect(mock.transmitted).toHaveLength(0)
    expect(host.isRunning('repeater')).toBe(true)
  })

  it('waits a random delay of up to 5 x the airtime x the factor before it sends', async () => {
    const factor = 2
    await start(variant({ TX_DELAY_FACTOR: String(factor) }))
    const posts = Array.from({ length: 6 }, (_, i) => post(`Bob: delayed ${i}`))
    for (const p of posts) hear(p)
    const delayed = () => lines.map((l) => /delayed (\d+) ms/.exec(l.text)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]))
    await until(() => delayed().length === 6, 10_000)
    // the firmware's formula: airtime of path + payload + 2 bytes, times the factor, then random up to 5 times that
    const air = airtimeUs(presetById('meshcore-us')!.config, 1 + (posts[0].length - 2) + 2) / 1000
    const delays = delayed()
    expect(Math.max(...delays)).toBeLessThanOrEqual(5 * Math.floor(air * factor))
    expect(new Set(delays).size).toBeGreaterThan(1) // they are random, not one fixed wait
  })

  it('stays under its duty cycle', async () => {
    await start(variant({ DUTY_CYCLE_MAX: '0.00005' })) // 0.18 s of air an hour: one post at most
    hear(post('Bob: first'))
    await until(() => mock.transmitted.length === 1)
    hear(post('Bob: second'))
    await new Promise((r) => setTimeout(r, 300))
    expect(mock.transmitted).toHaveLength(1)
  })

  it('drops what doesn’t fit in its queue', async () => {
    await start(variant({ TX_DELAY_FACTOR: '40', QUEUE_MAX: '2' }))
    for (let i = 0; i < 10; i++) hear(post(`Bob: crowd ${i}`))
    await new Promise((r) => setTimeout(r, 300))
    host.stop('repeater') // the summary prints on a 5 minute timer, so look at the queue another way: at most 2 were kept
    expect(mock.transmitted.length).toBeLessThanOrEqual(2)
  })
})

describe('setting up', () => {
  it('makes a node ID once and keeps it', async () => {
    await start(variant({ NODE_ID: "''" }))
    const first = /node ([0-9a-f]{6})/.exec(printed().find((l) => l.includes('repeater up'))!)![1]
    expect(first.slice(0, 2)).not.toMatch(/^(00|ff)$/)
    host.stop('repeater')
    lines = []
    await start(variant({ NODE_ID: "''" }))
    expect(printed().find((l) => l.includes('repeater up'))).toContain(`node ${first}`)
    // the packets it forwards carry that hash
    const heard = post('Bob: whose hash')
    hear(heard)
    await until(() => mock.transmitted.length === 1)
    expect(mock.transmitted[0][2]).toBe(parseInt(first.slice(0, 2), 16))
  })

  it('refuses an ID that can’t be a path hash', async () => {
    host.start(spec(variant({ NODE_ID: "'ff0102'" })))
    await until(() => printed().some((l) => l.startsWith('err: failed:')))
    expect(printed().join('\n')).toMatch(/reserved/)
    host.start(spec(variant({ NODE_ID: "'zz'" })))
    await until(() => printed().filter((l) => l.startsWith('err: failed:')).length === 2)
    expect(printed().join('\n')).toMatch(/NODE_ID must be/)
  })

  it('puts a radio that isn’t on a MeshCore config on one', async () => {
    await store.applyConfig(presetById('meshtastic-longfast-us')!.config)
    expect(store.getState().requested.syncWord).not.toBe(MESHCORE_SYNC_WORD)
    await start()
    expect(printed().some((l) => l.includes("isn't on a MeshCore config; switching to meshcore-us"))).toBe(true)
    expect(store.getState().requested.syncWord).toBe(MESHCORE_SYNC_WORD)
    hear(post('Bob: now it hears'))
    await until(() => mock.transmitted.length === 1)
  })
})
