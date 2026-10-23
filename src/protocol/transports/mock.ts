// A simulated DongLoRa dongle for demo mode and tests. It speaks the real wire protocol: COBS frames with
// CRCs, the UNCONFIGURED / CONFIGURED state machine with its 1000 ms inactivity timer, the same GET_INFO
// as a Heltec V4.2 on firmware 1.6.0 (protocol v1.1, or 1.5.2 with the info option), and the same errors.
// RADIO_STATUS answers with the band's RSSI while receiving, a powered GC1109 and climbing RX counters.
// While receiving on the MeshCore USA/Canada settings it hears a small mesh: signed adverts, Public
// channel posts that decrypt, acks and DMs, and (with failures on) one of every kind of broken packet,
// CRC failures included, and broken frame the console reports.

import { sha256 } from '@noble/hashes/sha2.js'
import { advertPayload, buildPacket, groupTextPacket, groupTextPayload, publicKeyOf } from '../../meshcore/build.ts'
import { PayloadType } from '../../meshcore/codes.ts'
import { makeChannel, PUBLIC_CHANNEL } from '../../meshcore/crypto.ts'
import { MESHCORE_SYNC_WORD } from '../../meshcore/presets.ts'
import { ByteWriter } from '../bytes.ts'
import type { Transport, TransportSink } from '../client.ts'
import { cobsEncode } from '../cobs.ts'
import { Capability, ErrCode, FemFlag, FemType, INACTIVITY_TIMEOUT_MS, Modulation, MsgType, RxGain, TxResult } from '../codes.ts'
import { encodeFrame, frameBody, FrameDecoder, type Frame } from '../framing.ts'
import { airtimeUs, validateConfig } from '../lora.ts'
import {
  encodeInfo,
  encodeRadioStatus,
  encodeRx,
  hasCapability,
  LORA_PARAMS_LEN,
  parseLoRaParams,
  type DeviceInfo,
  type LoRaConfig,
  type RadioStatus,
  type RxPacket,
} from '../messages.ts'

/** What a Heltec V4 on DongLoRa 1.5.2 reports (the UID is made up). */
export const MOCK_INFO: DeviceInfo = {
  protocol: { major: 1, minor: 0 },
  firmware: { major: 1, minor: 5, patch: 2 },
  radioChipId: 0x0002,
  capabilities: 0x10001n,
  sfBitmap: 0x1fe0,
  bwBitmap: 0x03ff,
  maxPayloadBytes: 255,
  rxQueueCapacity: 32,
  txQueueCapacity: 1,
  freqMinHz: 150_000_000,
  freqMaxHz: 960_000_000,
  txPowerMinDbm: -9,
  txPowerMaxDbm: 22,
  mcuUid: 'd0e0d0e0aa55',
  radioUid: '',
}

/** A Heltec V4.2 on DongLoRa 1.6.0: protocol v1.1, RADIO_STATUS, and the GC1109's output range at the antenna. */
export const MOCK_INFO_1_6: DeviceInfo = {
  ...MOCK_INFO,
  protocol: { major: 1, minor: 1 },
  firmware: { major: 1, minor: 6, patch: 0 },
  capabilities: MOCK_INFO.capabilities | (1n << BigInt(Capability.RadioStatus)),
  txPowerMinDbm: 2,
  txPowerMaxDbm: 28,
}

export const GOOD_KINDS = ['advert', 'group-text', 'text', 'ack', 'path'] as const
export const FAILURE_KINDS = [
  'crc-fail',
  'truncated',
  'reserved-hash',
  'long-path',
  'bad-version',
  'unknown-type',
  'advert-truncated',
  'bad-signature',
  'no-key',
  'bad-mac',
  'bad-decrypt',
] as const
export type PacketKind = (typeof GOOD_KINDS)[number] | (typeof FAILURE_KINDS)[number]

export const LINK_FAULT_KINDS = ['crc', 'cobs', 'short', 'overflow', 'unknown-type', 'async-err', 'unmatched', 'bad-payload'] as const
export type LinkFaultKind = (typeof LINK_FAULT_KINDS)[number]

export interface MockOptions {
  /** hear packets every few seconds while receiving */
  traffic?: boolean
  /** mix broken packets of every kind into the traffic */
  failures?: boolean
  /** now and then, send a frame that fails at the link layer */
  linkFaults?: boolean
  /** gap between packets, ms (default 1500-4500) */
  intervalMs?: [number, number]
  /** share of TXs that find the channel busy (default 0.1) */
  busyRate?: number
  /** what GET_INFO reports (default MOCK_INFO_1_6); without capability bit 33, RADIO_STATUS is EUNKNOWN_CMD */
  info?: DeviceInfo
}

interface Node {
  name: string
  type: number
  secretKey: Uint8Array
  lat?: number
  lon?: number
}

const seed = (s: string) => sha256(new TextEncoder().encode(s))

const NODES: Node[] = [
  { name: 'Hilltop Rptr', type: 2, secretKey: seed('hilltop'), lat: 30.2849, lon: -97.7341 },
  { name: 'Downtown Room', type: 3, secretKey: seed('downtown'), lat: 30.2672, lon: -97.7431 },
  { name: 'Alex 📡', type: 1, secretKey: seed('alex') },
  { name: 'Maya T-Deck', type: 1, secretKey: seed('maya'), lat: 30.3005, lon: -97.7522 },
  { name: 'Ridge Rptr 2', type: 2, secretKey: seed('ridge'), lat: 30.3712, lon: -97.8013 },
  { name: 'Soil sensor 4', type: 4, secretKey: seed('soil'), lat: 30.2215, lon: -97.6904 },
]
const POSTERS = ['KJ5GFX Bill', 'Driftwood', 'Maya', 'Tom 🚲', 'Alex']
const CHATTER = ['anyone on 910.525 tonight?', 'testing from the hilltop', 'good copy, thanks', 'repeater looks healthy', 'heading out on the trail, will check in later', 'hearing you 2 hops out']
/** a hashtag channel this console has no key for */
const OTHER_CHANNEL = makeChannel('#austin', 'd1c4a3b2f0e9d8c7b6a5948372615041')

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]
const randBytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256))
const randPath = (maxHops: number) => randBytes(Math.floor(Math.random() * (maxHops + 1)))

export class MockDongLoRaTransport implements Transport {
  readonly label = 'demo dongle'
  private sink: TransportSink | null = null
  private readonly options: MockOptions
  private readonly decoder: FrameDecoder
  private readonly bootAt = Date.now()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private inactivity: ReturnType<typeof setTimeout> | null = null
  private txQueue: { tag: number; len: number }[] = []
  private txBusy = false
  readonly info: DeviceInfo

  config: LoRaConfig | null = null
  receiving = false
  /** frames the host sent, for tests */
  readonly received: Frame[] = []
  /** how many times the inactivity timer fired */
  timeouts = 0
  /** the band's noise floor, wandering slowly between -114 and -110 dBm */
  noiseFloorDbm = -113 + Math.random() * 2
  /** RX counters since "boot": the dongle was up before the host connected */
  rxOk = 20 + Math.floor(Math.random() * 40)
  rxCrcErr = 1 + Math.floor(Math.random() * 5)
  rxHeaderErr = 3 + Math.floor(Math.random() * 10)

  constructor(options: MockOptions = {}) {
    this.options = options
    this.info = options.info ?? MOCK_INFO_1_6
    this.decoder = new FrameDecoder(() => {
      this.touch() // a bad frame still proves the host is there (§3.4)
      this.send(MsgType.Err, 0, new ByteWriter().u16(ErrCode.Frame).toBytes())
    })
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink
    if (this.options.traffic) {
      const [lo, hi] = this.options.intervalMs ?? [1500, 4500]
      this.every(lo, hi, () => this.hear())
    }
    if (this.options.linkFaults) this.every(12000, 25000, () => this.linkFault(pick(LINK_FAULT_KINDS)))
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    if (this.inactivity) clearTimeout(this.inactivity)
    this.sink = null
    this.reset()
  }

  async write(data: Uint8Array): Promise<void> {
    for (const f of this.decoder.push(data)) {
      this.touch()
      this.received.push(f)
      this.later(2, () => this.handle(f)) // reply asynchronously, like USB would
    }
  }

  // ---- plumbing ----

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.sink) fn()
    }, ms)
    this.timers.add(t)
  }

  private every(minMs: number, maxMs: number, fn: () => void): void {
    this.later(minMs + Math.random() * (maxMs - minMs), () => {
      fn()
      this.every(minMs, maxMs, fn)
    })
  }

  /** the inactivity timer is inert until the first frame, then restarts on every frame (§3.4) */
  private touch(): void {
    if (this.inactivity) clearTimeout(this.inactivity)
    this.inactivity = setTimeout(() => {
      this.inactivity = null
      this.timeouts++
      this.reset()
    }, INACTIVITY_TIMEOUT_MS)
  }

  private reset(): void {
    this.config = null
    this.receiving = false
    this.txQueue = [] // queued TXs vanish without TX_DONE
  }

  private send(type: number, tag: number, payload?: Uint8Array): void {
    this.sink?.onData(encodeFrame(type, tag, payload))
  }

  private ok(tag: number, payload?: Uint8Array): void {
    this.send(MsgType.Ok, tag, payload)
  }

  private err(tag: number, code: number): void {
    this.send(MsgType.Err, tag, new ByteWriter().u16(code).toBytes())
  }

  // ---- commands ----

  private handle(f: Frame): void {
    const { tag, payload: p } = f
    if (tag === 0) {
      // tag 0 from the host is a framing error (§2.2)
      return this.err(0, ErrCode.Frame)
    }
    switch (f.type) {
      case MsgType.Ping:
        return this.ok(tag)
      case MsgType.GetInfo:
        return this.ok(tag, encodeInfo(this.info))
      case MsgType.SetConfig: {
        if (p.length < 1) return this.err(tag, ErrCode.Length)
        if (p[0] !== Modulation.LoRa) return this.err(tag, ErrCode.Modulation)
        if (p.length !== 1 + LORA_PARAMS_LEN) return this.err(tag, ErrCode.Length)
        const cfg = parseLoRaParams(p.subarray(1))
        if (validateConfig(cfg, this.info).length || p[13] > 1 || p[14] > 1 || p[15] > 1) return this.err(tag, ErrCode.Param)
        // queued TXs are cancelled; RX stops until the host restarts it (§6.5)
        for (const q of this.txQueue) this.send(MsgType.TxDone, q.tag, new ByteWriter().u8(TxResult.Cancelled).u32(0).toBytes())
        this.txQueue = []
        this.config = cfg
        this.receiving = false
        return this.ok(tag, new ByteWriter().u8(0).u8(1).u8(Modulation.LoRa).bytes(p.subarray(1)).toBytes())
      }
      case MsgType.Tx: {
        if (!this.config) return this.err(tag, ErrCode.NotConfigured)
        if (p.length < 1) return this.err(tag, ErrCode.Length)
        if (p[0] & 0xfe) return this.err(tag, ErrCode.Param)
        const len = p.length - 1
        if (len < 1 || len > this.info.maxPayloadBytes) return this.err(tag, ErrCode.Length)
        if (this.txQueue.length >= this.info.txQueueCapacity) return this.err(tag, ErrCode.Busy)
        this.txQueue.push({ tag, len })
        this.ok(tag)
        return this.pumpTx()
      }
      case MsgType.RxStart:
        if (!this.config) return this.err(tag, ErrCode.NotConfigured)
        this.receiving = true
        return this.ok(tag)
      case MsgType.RxStop:
        if (!this.config) return this.err(tag, ErrCode.NotConfigured)
        this.receiving = false
        return this.ok(tag)
      case MsgType.RadioStatus:
        // older firmware doesn't know the command at all
        if (!hasCapability(this.info, Capability.RadioStatus)) return this.err(tag, ErrCode.UnknownCmd)
        if (p.length) return this.err(tag, ErrCode.Length)
        return this.ok(tag, encodeRadioStatus(this.radioStatus()))
      default:
        return this.err(tag, ErrCode.UnknownCmd)
    }
  }

  private pumpTx(): void {
    if (this.txBusy || !this.txQueue.length || !this.config) return
    const job = this.txQueue[0]
    this.txBusy = true
    const busy = Math.random() < (this.options.busyRate ?? 0.1)
    const air = busy ? 0 : airtimeUs(this.config, job.len)
    this.later(5 + air / 1000, () => {
      this.txBusy = false
      if (this.txQueue[0] !== job) return // cancelled or timed out meanwhile
      this.txQueue.shift()
      this.send(MsgType.TxDone, job.tag, new ByteWriter().u8(busy ? TxResult.ChannelBusy : TxResult.Transmitted).u32(air).toBytes())
      this.pumpTx()
    })
  }

  /** What RADIO_STATUS reads now. RSSI only in continuous RX, now and then in the middle of a packet. */
  radioStatus(): RadioStatus {
    let rssiInst: number | null = null
    if (this.receiving) {
      this.drift(0.2)
      const onAir = Math.random() < 0.06
      const dbm = this.noiseFloorDbm + (onAir ? 15 + Math.random() * 30 : (Math.random() - 0.5) * 3)
      rssiInst = Math.round(dbm * 2) / 2 // the SX126x reads RSSI in 0.5 dB steps
    }
    return {
      rssiInst,
      rxGain: RxGain.PowerSaving,
      femType: FemType.Gc1109,
      femFlags: FemFlag.Powered | FemFlag.Lna | FemFlag.Pa,
      rxOk: this.rxOk,
      rxCrcErr: this.rxCrcErr,
      rxHeaderErr: this.rxHeaderErr,
    }
  }

  // ---- the air ----

  private drift(step: number): void {
    this.noiseFloorDbm = Math.min(-110, Math.max(-114, this.noiseFloorDbm + (Math.random() - 0.5) * step))
  }

  /** whether the radio is tuned to the simulated mesh */
  private onMesh(): boolean {
    const c = this.config
    return !!c && c.freqHz === 910_525_000 && c.sf === 7 && c.bw === 6 && c.syncWord === MESHCORE_SYNC_WORD && !c.iqInvert && !c.implicitHeader
  }

  private hear(): void {
    if (!this.receiving) return
    if (!this.onMesh()) {
      // off the mesh's settings: only the odd burst of noise
      if (Math.random() < 0.15) this.inject('crc-fail')
      else if (Math.random() < 0.2) this.rxHeaderErr++
      return
    }
    // a preamble whose LoRa header didn't decode: counted, never delivered
    if (this.options.failures && Math.random() < 0.1) this.rxHeaderErr++
    const failing = this.options.failures && Math.random() < 0.3
    this.inject(failing ? (Math.random() < 0.15 ? 'crc-fail' : pick(FAILURE_KINDS)) : pick(GOOD_KINDS))
  }

  /** Emit one RX event of the given kind now. False when the radio isn't receiving. */
  inject(kind: PacketKind): boolean {
    if (!this.receiving) return false
    this.drift(0.8)
    const n = this.noiseFloorDbm
    // most packets 5-30 dB over the floor, some under it (LoRa decodes down to about -7.5 dB at SF7)
    const snr = kind === 'crc-fail' ? -13 + Math.random() * 6 : Math.random() < 0.12 ? -7 + Math.random() * 6 : 5 + Math.random() * 25
    // RSSI over the packet is signal plus noise; the firmware rounds both to whole dB
    const rssi = 10 * Math.log10(10 ** ((n + snr) / 10) + 10 ** (n / 10))
    const rx: RxPacket = {
      rssi: Math.round(rssi),
      snr: Math.round(snr),
      freqErr: Math.round((Math.random() - 0.5) * 3000),
      timestampUs: (Date.now() - this.bootAt) * 1000,
      crcValid: kind !== 'crc-fail',
      packetsDropped: Math.random() < 0.04 ? 1 + Math.floor(Math.random() * 3) : 0,
      origin: 0,
      data: this.packet(kind),
    }
    if (rx.crcValid) this.rxOk++
    else this.rxCrcErr++
    this.send(MsgType.Rx, 0, encodeRx(rx))
    return true
  }

  private packet(kind: PacketKind): Uint8Array {
    const now = Math.floor(Date.now() / 1000)
    const node = pick(NODES)
    const advert = () =>
      buildPacket({ payloadType: PayloadType.Advert, path: randPath(3) }, advertPayload({ ...node, timestamp: now - Math.floor(Math.random() * 30) }))
    const post = () => `${pick(POSTERS)}: ${pick(CHATTER)}`
    const addressed = (type: number) => {
      const [a, b] = [pick(NODES), pick(NODES)]
      const payload = new ByteWriter().u8(publicKeyOf(a.secretKey)[0]).u8(publicKeyOf(b.secretKey)[0]).bytes(randBytes(2)).bytes(randBytes(16 * (1 + Math.floor(Math.random() * 3)))).toBytes()
      return buildPacket({ payloadType: type, routeType: 2, path: randPath(2) }, payload)
    }
    switch (kind) {
      case 'advert':
        return advert()
      case 'group-text':
        return groupTextPacket(PUBLIC_CHANNEL, now, post(), randPath(3))
      case 'text':
        return addressed(PayloadType.Text)
      case 'path':
        return addressed(PayloadType.Path)
      case 'ack':
        return buildPacket({ payloadType: PayloadType.Ack, path: randPath(3) }, randBytes(4))
      case 'crc-fail': {
        // a real packet with a few bytes hit by interference
        const p = Math.random() < 0.5 ? advert() : groupTextPacket(PUBLIC_CHANNEL, now, post())
        for (let i = 0; i < 3; i++) p[Math.floor(Math.random() * p.length)] ^= 1 << Math.floor(Math.random() * 8)
        return p
      }
      case 'truncated': {
        // flood group text, path length says 5 hops, the packet ends after 2
        return Uint8Array.of((PayloadType.GroupText << 2) | 1, 0x05, 0x3a, 0x91)
      }
      case 'reserved-hash':
        return Uint8Array.of((PayloadType.GroupText << 2) | 1, 0xc2, 1, 2, 3, 4, 5, 6, 7, 8, ...randBytes(20))
      case 'long-path': {
        // 40 hops of 2-byte hashes = 80 bytes of path
        return Uint8Array.of((PayloadType.Advert << 2) | 1, (1 << 6) | 40, ...randBytes(80), ...randBytes(30))
      }
      case 'bad-version':
        return buildPacket({ payloadType: PayloadType.GroupText, version: 1 }, groupTextPayload(PUBLIC_CHANNEL, now, post()))
      case 'unknown-type':
        return buildPacket({ payloadType: 0x0d, path: randPath(2) }, randBytes(24))
      case 'advert-truncated':
        return advert().slice(0, 2 + 60)
      case 'bad-signature': {
        // the timestamp was changed after signing
        const p = advertPayload({ ...node, timestamp: now })
        p[32] ^= 0x01
        return buildPacket({ payloadType: PayloadType.Advert, path: randPath(3) }, p)
      }
      case 'no-key':
        return groupTextPacket(OTHER_CHANNEL, now, post(), randPath(2))
      case 'bad-mac': {
        const p = groupTextPacket(PUBLIC_CHANNEL, now, post(), randPath(2))
        p[p.length - 5] ^= 0x20
        return p
      }
      case 'bad-decrypt': {
        // right channel hash, but the ciphertext isn't whole AES blocks
        const p = groupTextPayload(PUBLIC_CHANNEL, now, post())
        return buildPacket({ payloadType: PayloadType.GroupText }, p.slice(0, p.length - 7))
      }
    }
  }

  /** Send one frame that fails at the link layer. */
  linkFault(kind: LinkFaultKind): void {
    const delimited = (b: Uint8Array) => Uint8Array.from([...b, 0])
    const rxBody = () =>
      frameBody(MsgType.Rx, 0, encodeRx({ rssi: -90, snr: 4, freqErr: 0, timestampUs: (Date.now() - this.bootAt) * 1000, crcValid: true, packetsDropped: 0, origin: 0, data: this.packet('ack') }))
    switch (kind) {
      case 'crc': {
        const body = rxBody()
        body[body.length - 1] ^= 0x5a
        return this.sink?.onData(delimited(cobsEncode(body)))
      }
      case 'cobs':
        // the code byte says 9 bytes follow, but the frame ends after 4
        return this.sink?.onData(Uint8Array.of(0x09, MsgType.Rx, 0x01, 0x01, 0x7f, 0x00))
      case 'short':
        return this.sink?.onData(delimited(cobsEncode(Uint8Array.of(MsgType.Ok, 0x07))))
      case 'overflow':
        // 600 bytes with no delimiter, more than any frame can be
        return this.sink?.onData(delimited(Uint8Array.from({ length: 600 }, (_, i) => 1 + (i % 250))))
      case 'unknown-type':
        return this.send(0xc5, 0, Uint8Array.of(1, 2, 3))
      case 'async-err':
        return this.err(0, pick([ErrCode.Frame, ErrCode.Radio, ErrCode.Internal]))
      case 'unmatched':
        return this.ok(0xbeef)
      case 'bad-payload':
        return this.send(MsgType.Rx, 0, randBytes(9))
    }
  }
}
