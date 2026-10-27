import { describe, expect, it } from 'vitest'
import type { LoRaConfig, RxPacket } from '../src/protocol/messages.ts'
import {
  aesCtr,
  BROADCAST,
  channelHash,
  decodeMeshtastic,
  DEFAULT_CHANNELS,
  DEFAULT_PSK,
  djb2,
  encodeData,
  encodeMeshtasticPacket,
  encodePosition,
  encodeRouteDiscovery,
  encodeRoutingError,
  encodeTelemetry,
  encodeText,
  encodeUser,
  expandPsk,
  makeChannel,
  meshtasticConfig,
  meshtasticFrequencyHz,
  meshtasticNonce,
  meshtasticPlugin,
  MODEM_PRESETS,
  MESHTASTIC_PRESETS as PRESETS,
  PortNum,
  ProtoError,
  ProtoReader,
  ProtoWriter,
  REGIONS,
  type MeshtasticDecode,
  type PacketInit,
} from '../src/plugins/meshtastic/index.ts'

// test/ compiles with the browser tsconfig, so Node's AES (the independent check on @noble) is typed by hand
type NodeCrypto = { createDecipheriv(alg: string, key: Uint8Array, iv: Uint8Array): { update(b: Uint8Array): Uint8Array } }
const nodeProcess = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process
const { createDecipheriv } = nodeProcess.getBuiltinModule('node:crypto') as NodeCrypto

const rx = (data: Uint8Array, crcValid = true): RxPacket => ({ rssi: -90, snr: 6, freqErr: 0, timestampUs: 0, crcValid, packetsDropped: 0, origin: 0, data })
const LONGFAST = makeChannel('LongFast')
const ALICE = 0xa1b2c3d4
const BOB = 0x0badf00d

const packet = (p: Partial<PacketInit> & Pick<PacketInit, 'portnum' | 'payload'>) =>
  encodeMeshtasticPacket({ to: BROADCAST, from: ALICE, id: 0x12345678, hopLimit: 1, hopStart: 3, channel: LONGFAST.hash, key: LONGFAST.key, ...p })

const decode = (raw: Uint8Array) => meshtasticPlugin.decode(raw, rx(raw))
const dataOf = (raw: Uint8Array) => decode(raw).data as MeshtasticDecode
const field = (raw: Uint8Array, label: string) => decode(raw).fields.find((f) => f.label === label)?.value

describe('channels and keys', () => {
  it('hashes LongFast with the default key to 0x08', () => {
    expect(channelHash('LongFast', DEFAULT_PSK)).toBe(0x08)
    expect(LONGFAST).toMatchObject({ name: 'LongFast', hash: 0x08 })
    expect(LONGFAST.key).toEqual(DEFAULT_PSK)
    expect(DEFAULT_CHANNELS.find((c) => c.hash === 0x08)?.name).toBe('LongFast')
  })

  it('expands PSKs the way the firmware does', () => {
    expect(expandPsk(Uint8Array.of(0))).toHaveLength(0)
    expect(expandPsk(Uint8Array.of(1))).toEqual(DEFAULT_PSK)
    expect(expandPsk(Uint8Array.of(2))[15]).toBe(0x02)
    expect(expandPsk(Uint8Array.of(9, 9, 9))).toEqual(Uint8Array.of(9, 9, 9, ...new Uint8Array(13)))
    expect(expandPsk(new Uint8Array(20).fill(1))).toHaveLength(32)
    expect(makeChannel('x', 'AQ==').key).toEqual(DEFAULT_PSK)
    expect(() => expandPsk(new Uint8Array(33))).toThrow(RangeError)
  })

  it('builds the counter block from the packet id and the sender', () => {
    expect(Array.from(meshtasticNonce(0x12345678, 0xa1b2c3d4))).toEqual([0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0, 0xd4, 0xc3, 0xb2, 0xa1, 0, 0, 0, 0])
  })

  it('matches Node’s AES-CTR, over several blocks, for 128- and 256-bit keys', () => {
    const plain = encodeData({ portnum: PortNum.Text, payload: encodeText('a message long enough to need three AES blocks') })
    expect(plain.length).toBeGreaterThan(32)
    const raw = packet({ portnum: PortNum.Text, payload: encodeText('a message long enough to need three AES blocks') })
    const node = createDecipheriv('aes-128-ctr', DEFAULT_PSK, meshtasticNonce(0x12345678, ALICE))
    expect(new Uint8Array(node.update(raw.subarray(16)))).toEqual(plain)

    const key256 = Uint8Array.from({ length: 32 }, (_, i) => i * 7)
    const ct = aesCtr(key256, 99, BOB, plain)
    const node256 = createDecipheriv('aes-256-ctr', key256, meshtasticNonce(99, BOB))
    expect(new Uint8Array(node256.update(ct))).toEqual(plain)
  })
})

describe('presets and frequencies', () => {
  it('puts LongFast on 906.875 MHz in the US and 869.525 MHz in EU_868', () => {
    expect(meshtasticFrequencyHz(REGIONS.US, 250, 'LongFast')).toBe(906_875_000)
    expect(meshtasticFrequencyHz(REGIONS.EU_868, 250, 'LongFast')).toBe(869_525_000)
    expect(djb2('LongFast') % 104).toBe(19)
  })

  it('puts the other default channels on their slots', () => {
    expect(meshtasticFrequencyHz(REGIONS.US, 250, 'MediumFast')).toBe(913_125_000)
    expect(meshtasticFrequencyHz(REGIONS.US, 250, 'ShortFast')).toBe(918_875_000)
    expect(meshtasticFrequencyHz(REGIONS.EU_868, 250, 'MediumFast')).toBe(869_525_000) // one slot
    expect(() => meshtasticFrequencyHz(REGIONS.EU_868, 500, 'LongFast')).toThrow(RangeError)
  })

  it('ships LongFast and MediumFast in US and EU_868, and ShortFast US', () => {
    expect(meshtasticPlugin.presets.map((p) => p.id)).toEqual([
      'meshtastic-longfast-us',
      'meshtastic-mediumfast-us',
      'meshtastic-shortfast-us',
      'meshtastic-longfast-eu868',
      'meshtastic-mediumfast-eu868',
    ])
    expect(PRESETS[0].name).toBe('Meshtastic LongFast (US)')
    expect(PRESETS[0].config).toEqual({
      freqHz: 906_875_000, sf: 11, bw: 8, cr: 0, preambleLen: 16, syncWord: 0x24b4, txPowerDbm: 10, implicitHeader: false, payloadCrc: true, iqInvert: false,
    })
    expect(meshtasticConfig(MODEM_PRESETS.LongSlow, REGIONS.US)).toMatchObject({ sf: 12, bw: 7, cr: 3 })
  })

  it('claims packets heard with the Meshtastic sync word only', () => {
    expect(meshtasticPlugin.claims(PRESETS[0].config)).toBe(true)
    const meshcore: LoRaConfig = { ...PRESETS[0].config, syncWord: 0x1424 }
    expect(meshtasticPlugin.claims(meshcore)).toBe(false)
  })
})

describe('round trips', () => {
  it('decodes a text broadcast and its header', () => {
    const raw = packet({ portnum: PortNum.Text, payload: encodeText('hello mesh ✓'), wantAck: false, nextHop: 0, relayNode: 0x42 })
    const d = decode(raw)
    expect(d).toMatchObject({ protocol: 'meshtastic', status: 'decoded', failure: undefined })
    expect(d.summary).toBe('text !a1b2c3d4 → all: "hello mesh ✓" · LongFast, 2 hops')
    const m = d.data as MeshtasticDecode
    expect(m.header).toMatchObject({ to: BROADCAST, from: ALICE, id: 0x12345678, hopLimit: 1, hopStart: 3, wantAck: false, viaMqtt: false, channel: 0x08, relayNode: 0x42 })
    expect(m).toMatchObject({ hops: 2, channel: 'LongFast', portName: 'TEXT_MESSAGE_APP', app: { kind: 'text', text: 'hello mesh ✓' } })
    expect(field(raw, 'From')).toBe('!a1b2c3d4')
    expect(field(raw, 'Channel')).toBe('LongFast')
    expect(field(raw, 'Text')).toBe('hello mesh ✓')
    expect(d.regions.map((r) => [r.from, r.to, r.kind])).toEqual([
      [0, 4, 'address'], [4, 8, 'address'], [8, 12, 'meta'], [12, 13, 'meta'], [13, 14, 'meta'], [14, 15, 'meta'], [15, 16, 'meta'], [16, raw.length, 'payload'],
    ])
  })

  it('reads the flag bits', () => {
    const raw = packet({ to: BOB, portnum: PortNum.Text, payload: encodeText('hi'), hopLimit: 7, hopStart: 7, wantAck: true, viaMqtt: true })
    expect(raw[12]).toBe(0b111_1_1_111)
    expect(dataOf(raw).header).toMatchObject({ hopLimit: 7, hopStart: 7, wantAck: true, viaMqtt: true })
    expect(decode(raw).summary).toBe('text !a1b2c3d4 → !0badf00d: "hi" · LongFast, direct, via MQTT')
    const old = packet({ portnum: PortNum.Text, payload: encodeText('hi'), hopStart: 0, hopLimit: 3 })
    expect(dataOf(old).hops).toBeUndefined()
    expect(decode(old).summary).toMatch(/· LongFast, hop limit 3$/)
  })

  it('decodes a position, with negative coordinates and altitude', () => {
    const raw = packet({ portnum: PortNum.Position, payload: encodePosition({ lat: 45.4215296, lon: -75.6971931, altitude: -12, time: 1_760_000_000 }) })
    const d = decode(raw)
    expect(d.status).toBe('decoded')
    const a = dataOf(raw).app
    expect(a).toMatchObject({ kind: 'position', altitude: -12, time: 1_760_000_000 })
    if (a?.kind !== 'position') throw new Error('not a position')
    expect(a.lat).toBeCloseTo(45.4215296, 7)
    expect(a.lon).toBeCloseTo(-75.6971931, 7)
    expect(d.summary).toBe('position !a1b2c3d4 → all: 45.42153, -75.69719, -12 m · LongFast, 2 hops')
  })

  it('decodes node info', () => {
    const payload = encodeUser({ id: '!a1b2c3d4', longName: 'Alice Base', shortName: 'ALB', hwModel: 43, role: 2, publicKey: new Uint8Array(32).fill(0xab) })
    const raw = packet({ portnum: PortNum.NodeInfo, payload })
    expect(dataOf(raw).app).toMatchObject({ kind: 'nodeinfo', id: '!a1b2c3d4', longName: 'Alice Base', shortName: 'ALB', hwModel: 43, hwModelName: 'HELTEC_V3', role: 2, roleName: 'ROUTER' })
    expect(decode(raw).summary).toBe('nodeinfo !a1b2c3d4 → all: "Alice Base" (ALB) HELTEC_V3 ROUTER · LongFast, 2 hops')
    expect(field(raw, 'Public key')).toBe('ab'.repeat(32))
    // proto3 leaves zero enums out: CLIENT, UNSET; an unknown model shows as its number
    expect(dataOf(packet({ portnum: PortNum.NodeInfo, payload: encodeUser({ id: '!1', longName: 'x', shortName: 'x', hwModel: 250 }) })).app).toMatchObject({ roleName: 'CLIENT', hwModelName: '250' })
  })

  it('decodes device and environment telemetry', () => {
    const dev = packet({ portnum: PortNum.Telemetry, payload: encodeTelemetry({ time: 1_760_000_000, device: { batteryLevel: 87, voltage: 4.1, channelUtilization: 5.25, airUtilTx: 1.5, uptimeSeconds: 93_784 } }) })
    const a = dataOf(dev).app
    if (a?.kind !== 'telemetry') throw new Error('not telemetry')
    expect(a).toMatchObject({ time: 1_760_000_000, variant: 2, device: { batteryLevel: 87, uptimeSeconds: 93_784 } })
    expect(a.device!.voltage).toBeCloseTo(4.1, 5)
    expect(decode(dev).summary).toBe('telemetry !a1b2c3d4 → all: battery 87%, 4.10 V, ch util 5.3% · LongFast, 2 hops')
    expect(field(dev, 'Uptime')).toBe('1d 2h 3m (93784 s)')

    const env = packet({ portnum: PortNum.Telemetry, payload: encodeTelemetry({ environment: { temperature: 21.5, relativeHumidity: 45, barometricPressure: 1013.2 } }) })
    expect(decode(env).summary).toBe('telemetry !a1b2c3d4 → all: 21.5 °C, 45% RH, 1013.2 hPa · LongFast, 2 hops')
    const power = packet({ portnum: PortNum.Telemetry, payload: new ProtoWriter().bytes(5, Uint8Array.of(0x0d, 0, 0, 0x80, 0x3f)).toBytes() })
    expect(decode(power).summary).toMatch(/: power metrics ·/)
  })

  it('decodes routing, traceroute, neighbor info and names other portnums', () => {
    const ack = packet({ to: BOB, portnum: PortNum.Routing, payload: encodeRoutingError(0), requestId: 0xcafe0001 })
    expect(decode(ack).summary).toBe('routing !a1b2c3d4 → !0badf00d: ack for 0xcafe0001 · LongFast, 2 hops')
    expect(decode(packet({ portnum: PortNum.Routing, payload: encodeRoutingError(1) })).summary).toMatch(/: NO_ROUTE ·/)

    const tr = packet({ to: BOB, portnum: PortNum.Traceroute, payload: encodeRouteDiscovery({ route: [0x11111111, 0x22222222] }) })
    expect(dataOf(tr).app).toMatchObject({ kind: 'traceroute', route: [0x11111111, 0x22222222] })
    expect(decode(tr).summary).toMatch(/: via !11111111, !22222222 ·/)

    const neighbor = (id: number) => new ProtoWriter().varint(1, id).float(2, 7.5).toBytes()
    const ni = new ProtoWriter().varint(1, ALICE).bytes(4, neighbor(1)).bytes(4, neighbor(2)).bytes(4, neighbor(3)).toBytes()
    expect(decode(packet({ portnum: PortNum.NeighborInfo, payload: ni })).summary).toMatch(/^neighborinfo .*: 3 neighbors ·/)

    const wp = decode(packet({ portnum: 8, payload: new Uint8Array(23) }))
    expect(wp.status).toBe('decoded')
    expect(wp.summary).toBe('waypoint !a1b2c3d4 → all: portnum 8, 23 bytes · LongFast, 2 hops')
    expect(decode(packet({ portnum: 300, payload: Uint8Array.of(1) })).summary).toMatch(/^app !a1b2c3d4 → all: portnum 300, 1 byte ·/)
  })

  it('decodes an unencrypted channel and an AES-256 channel when given their keys', () => {
    const open = makeChannel('Open', Uint8Array.of(0))
    const aes256 = makeChannel('Big', Uint8Array.from({ length: 32 }, (_, i) => i))
    for (const c of [open, aes256]) {
      const raw = packet({ channel: c.hash, key: c.key, portnum: PortNum.Text, payload: encodeText(`on ${c.name}`) })
      expect(decodeMeshtastic(raw, { channels: [c] })).toMatchObject({ status: 'decoded', data: { channel: c.name, app: { text: `on ${c.name}` } } })
    }
    const plain = packet({ channel: open.hash, key: open.key, portnum: PortNum.Text, payload: encodeText('x') })
    expect(plain.subarray(16)).toEqual(encodeData({ portnum: PortNum.Text, payload: encodeText('x') }))
    // with no key to blame, a Data message that doesn't parse is a 'data' failure
    const junk = Uint8Array.from([...plain.subarray(0, 16), 0xff])
    expect(decodeMeshtastic(junk, { channels: [open] }).failure).toMatchObject({ stage: 'data', offset: 17 })
  })
})

describe('failures', () => {
  const good = packet({ portnum: PortNum.Text, payload: encodeText('hello') })

  it('fails the header below 16 bytes, at every length', () => {
    for (let n = 0; n < 16; n++) {
      const d = decode(good.subarray(0, n))
      expect(d.status).toBe('undecodable')
      expect(d.failure).toMatchObject({ stage: 'header', offset: n })
      expect(d.failure!.reason).toBe(`truncated: ${n} bytes, the header alone is 16`)
    }
  })

  it('reports a wrong key as a decrypt failure', () => {
    const raw = packet({ key: Uint8Array.from({ length: 16 }, (_, i) => i + 1), portnum: PortNum.Text, payload: encodeText('secret') })
    const d = decode(raw)
    expect(d.status).toBe('partial')
    expect(d.failure).toMatchObject({ stage: 'decrypt', offset: 16 })
    expect(d.failure!.reason).toMatch(/^the LongFast key for hash 0x08 gives no valid Data message/)
    expect(d.summary).toMatch(/^packet !a1b2c3d4 → all: the LongFast key/)
    expect(meshtasticPlugin.learn!(d, rx(raw))).toEqual({})
  })

  it('reports an unknown channel hash as no-key', () => {
    const secret = makeChannel('Secret', Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i))
    expect(DEFAULT_CHANNELS.some((c) => c.hash === secret.hash)).toBe(false)
    const raw = packet({ channel: secret.hash, key: secret.key, portnum: PortNum.Text, payload: encodeText('psst') })
    const d = decode(raw)
    expect(d.status).toBe('no-key')
    expect(d.failure).toMatchObject({ stage: 'channel', offset: 13, reason: `no key for channel hash 0x${secret.hash.toString(16).padStart(2, '0')}` })
    expect(d.summary).toBe(`packet !a1b2c3d4 → all: ${raw.length - 16} B encrypted, no key · channel 0x${secret.hash.toString(16)}, 2 hops`)
    const pki = decode(packet({ to: BOB, channel: 0, portnum: PortNum.Text, payload: encodeText('x') }))
    expect(pki.failure!.reason).toMatch(/PKI-encrypted/)
  })

  it('never throws on truncated or corrupted ciphertext', () => {
    const raws = [
      good,
      packet({ portnum: PortNum.Position, payload: encodePosition({ lat: 1, lon: 2, altitude: 3, time: 4 }) }),
      packet({ portnum: PortNum.NodeInfo, payload: encodeUser({ id: '!a', longName: 'long', shortName: 'L', hwModel: 9, role: 1 }) }),
      packet({ portnum: PortNum.Telemetry, payload: encodeTelemetry({ device: { batteryLevel: 50, voltage: 3.9 } }) }),
    ]
    for (const raw of raws) {
      for (let n = 16; n <= raw.length; n++) {
        const d = decode(raw.subarray(0, n))
        expect(['decoded', 'partial']).toContain(d.status)
        if (d.failure) expect(d.failure.offset).toBeLessThanOrEqual(n)
      }
      for (let i = 16; i < raw.length; i++) {
        const bad = raw.slice()
        bad[i] ^= 0xff
        expect(() => decode(bad)).not.toThrow()
      }
    }
    expect(decode(good.subarray(0, 16)).failure).toMatchObject({ stage: 'decrypt', reason: expect.stringMatching(/no portnum/) })
  })

  it('points app failures at the byte in the packet', () => {
    // a well-formed Data whose Position payload stops inside latitude_i
    const payload = Uint8Array.of(0x0d, 0x01, 0x02)
    const raw = packet({ portnum: PortNum.Position, payload })
    const d = decode(raw)
    expect(d.status).toBe('partial')
    expect(d.failure).toMatchObject({ stage: 'app', offset: 16 + 4 + 1 })
    expect(d.failure!.reason).toMatch(/^POSITION_APP: truncated: sfixed32 needs 4 bytes/)
    expect(decode(packet({ portnum: PortNum.Text, payload: Uint8Array.of(0xff, 0xfe) })).failure).toMatchObject({ stage: 'app', reason: 'TEXT_MESSAGE_APP: text is not valid UTF-8' })
    // a wire-type mismatch on a known field fails like nanopb
    expect(decode(packet({ portnum: PortNum.Position, payload: new ProtoWriter().varint(1, 5).toBytes() })).failure?.reason).toMatch(/field 1 has wire type 0, expected 5/)
  })
})

describe('protobuf reader', () => {
  it('reads 64-bit varints, sign-extended int32 and zigzag', () => {
    const w = new ProtoWriter().varint(1, -1).varint(2, 2n ** 63n).sint32(3, -3).sint32(4, 2147483647).varint(5, 300)
    const b = w.toBytes()
    expect(b.subarray(0, 11)).toEqual(Uint8Array.of(0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01))
    const r = new ProtoReader(b)
    r.tag()
    expect(r.int32()).toBe(-1)
    r.tag()
    expect(r.varint()).toBe(2n ** 63n)
    r.tag()
    expect(r.sint32()).toBe(-3)
    r.tag()
    expect(r.sint32()).toBe(2147483647)
    r.tag()
    expect(r.uint32()).toBe(300)
    expect(r.tag()).toBeNull()
    expect(new ProtoReader(Uint8Array.of(0x03)).sint64()).toBe(-2n)
  })

  it('accepts packed and unpacked repeated fields and skips unknown ones', () => {
    const fixed = (n: number) => Uint8Array.of(n, 0, 0, 0)
    const unpacked = new ProtoWriter().fixed32(1, 7).fixed32(1, 8).toBytes()
    const packed = new ProtoWriter().packedFixed32(1, [7, 8]).toBytes()
    const withUnknown = Uint8Array.from([...new ProtoWriter().varint(99, 1n << 60n).bytes(98, fixed(1)).toBytes(), 0x79, ...new Uint8Array(8), ...packed])
    for (const b of [unpacked, packed, withUnknown]) {
      const raw = packet({ portnum: PortNum.Traceroute, payload: b })
      expect(dataOf(raw).app).toMatchObject({ route: [7, 8] })
    }
  })

  it('rejects truncation, overlong varints and groups', () => {
    const err = (b: number[], read: (r: ProtoReader) => unknown) => {
      try {
        read(new ProtoReader(Uint8Array.from(b), 100))
      } catch (e) {
        expect(e).toBeInstanceOf(ProtoError)
        return e as ProtoError
      }
      throw new Error('did not throw')
    }
    expect(err([0x80], (r) => r.varint()).message).toMatch(/runs past the end/)
    expect(err(Array.from({ length: 11 }, () => 0x80), (r) => r.varint())).toMatchObject({ offset: 100, message: expect.stringMatching(/longer than 10 bytes/) })
    expect(err([0x05, 1, 2], (r) => r.bytes())).toMatchObject({ offset: 101, message: expect.stringMatching(/says 5 bytes, 2 left/) })
    expect(err([1, 2], (r) => r.fixed32()).message).toMatch(/fixed32 needs 4 bytes at byte 100/)
    expect(err([0x0b], (r) => r.tag()).message).toMatch(/wire type 3/)
    expect(err([0x00], (r) => r.tag()).message).toMatch(/invalid field number 0/)
  })
})

describe('learn', () => {
  const learn = (raw: Uint8Array, crcValid = true) => meshtasticPlugin.learn!(decode(raw), rx(raw, crcValid))

  it('learns names, role and hardware from node info', () => {
    const raw = packet({ portnum: PortNum.NodeInfo, payload: encodeUser({ id: '!a1b2c3d4', longName: 'Alice Base', shortName: 'ALB', hwModel: 9, role: 11 }) })
    expect(learn(raw)).toEqual({ nodes: [{ id: '!a1b2c3d4', hops: 2, name: 'Alice Base', shortName: 'ALB', kind: 'router late', details: { hardware: 'RAK4631' } }] })
    expect(learn(raw, false)).toEqual({})
  })

  it('learns a position, but not 0,0', () => {
    expect(learn(packet({ portnum: PortNum.Position, payload: encodePosition({ lat: 45.5, lon: -73.5 }) })).nodes).toEqual([{ id: '!a1b2c3d4', hops: 2, lat: 45.5, lon: -73.5 }])
    expect(learn(packet({ portnum: PortNum.Position, payload: encodePosition({ lat: 0, lon: 0 }) })).nodes).toEqual([{ id: '!a1b2c3d4', hops: 2 }])
  })

  it('learns battery and voltage from device telemetry', () => {
    const raw = packet({ portnum: PortNum.Telemetry, payload: encodeTelemetry({ device: { batteryLevel: 101, voltage: 4.987 } }) })
    expect(learn(raw).nodes![0].details).toEqual({ battery: 'external power', voltage: '4.99 V' })
  })

  it('learns text posts as messages, keeping direct messages apart', () => {
    expect(learn(packet({ portnum: PortNum.Text, payload: encodeText('hello') }))).toEqual({
      nodes: [{ id: '!a1b2c3d4', hops: 2 }],
      messages: [{ channel: 'LongFast', sender: '!a1b2c3d4', text: 'hello', hops: 2 }],
    })
    expect(learn(packet({ to: BOB, portnum: PortNum.Text, payload: encodeText('hi bob') })).messages).toEqual([{ channel: 'LongFast → !0badf00d', sender: '!a1b2c3d4', text: 'hi bob', hops: 2 }])
  })

  it('learns nothing from packets it could not decrypt', () => {
    const raw = packet({ channel: 0x55, portnum: PortNum.Text, payload: encodeText('x') })
    expect(learn(raw)).toEqual({})
  })
})
