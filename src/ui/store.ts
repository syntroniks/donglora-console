// Connection state for the whole app, held outside React so that StrictMode double effects and Fast
// Refresh remounts can't open a second port or orphan the first. Components read it with useRadio().
// There is one store per page, kept on globalThis: a hot update of this module (or of anything it
// imports) keeps the instance, with its client, port and subscribers, and gives it the new code.

import { DongLoRaClient, type KeepaliveHealth, type LinkError, type LinkErrorKind, type Transport } from '../protocol/client.ts'
import type { Frame } from '../protocol/framing.ts'
import { Capability } from '../protocol/codes.ts'
import { hasCapability, type DeviceInfo, type LoRaConfig, type RadioStatus, type RxPacket, type SetConfigReply, type TxDone } from '../protocol/messages.ts'
import { MockDongLoRaTransport } from '../protocol/transports/mock.ts'
import { WebSerialTransport } from '../protocol/transports/webserial.ts'
import { validateConfig } from '../protocol/lora.ts'
import { PUBLIC_CHANNEL } from '../meshcore/crypto.ts'
import { decodeMeshCore, type DecodeStage, type DecodeStatus, type MeshDecode } from '../meshcore/decode.ts'
import { DEFAULT_PRESET } from '../meshcore/presets.ts'
import { NoiseFloorTracker, type NoiseFloorState } from '../radio/noiseFloor.ts'

export type Status = 'disconnected' | 'connecting' | 'connected'

export interface PacketEntry {
  id: number
  at: number // Date.now() when it arrived
  rx: RxPacket
  mesh: MeshDecode
  /** noise under this packet, dBm (estimate); undefined when the CRC failed */
  noise?: number
}

/** one point per RX event, for the noise chart */
export interface NoisePoint {
  at: number
  rssi: number
  crcValid: boolean
  noise?: number
  floor?: number
  median?: number
}

/** one point per RADIO_STATUS reply with an RSSI, for the noise chart */
export interface MeasuredPoint {
  at: number
  dbm: number
  floor?: number
  median?: number
}

export interface LinkEntry extends LinkError {
  id: number
}

export interface HeardNode {
  publicKey: string
  name: string
  type: number
  typeName: string
  firstHeard: number
  lastHeard: number
  advertTimestamp: number
  rssi: number
  snr: number
  hops: number
  lat?: number
  lon?: number
  adverts: number
}

export interface ChannelPost {
  id: number
  at: number
  channel: string
  sender: string
  body: string
  timestamp: number
  hops: number
  rssi: number
  snr: number
}

export interface SessionEvent {
  at: number
  text: string
  level: 'info' | 'warn' | 'err'
}

export interface Stats {
  rx: number
  crcFail: number
  dropped: number
  /** RSSI/SNR over packets with a good CRC */
  good: number
  rssiSum: number
  snrSum: number
  rssiMin?: number
  rssiMax?: number
  snrMin?: number
  snrMax?: number
  last?: { rssi: number; snr: number; at: number }
  status: Record<DecodeStatus, number>
  /** failures by the stage they stopped at (no-key counted under channel) */
  stages: Partial<Record<DecodeStage, number>>
  link: Partial<Record<LinkErrorKind, number>>
  linkTotal: number
}

export interface RadioState {
  status: Status
  label?: string
  demo: boolean
  error?: string
  info?: DeviceInfo
  /** the config the console asks for; applied with SET_CONFIG on connect and on Apply */
  requested: LoRaConfig
  /** what the device echoed back */
  applied?: SetConfigReply
  rxOn: boolean
  connectedAt?: number
  packets: PacketEntry[]
  linkErrors: LinkEntry[]
  stats: Stats
  health?: KeepaliveHealth
  nodes: Record<string, HeardNode>
  posts: ChannelPost[]
  log: SessionEvent[]
  txArmed: boolean
  noise: NoiseFloorState
  noiseHistory: NoisePoint[]
  measuredHistory: MeasuredPoint[]
  /** the last RADIO_STATUS reply of this connection (firmware 1.6.0, protocol v1.1) */
  radioStatus?: RadioStatus
  radioStatusAt?: number
  /** device counters when this connection's first RADIO_STATUS arrived (or stats were reset), for deltas */
  countersBase?: RadioStatus
  /** GET_INFO advertised RADIO_STATUS but the device answered EUNKNOWN_CMD */
  radioStatusRefused: boolean
}

/** GET_INFO advertises RADIO_STATUS (capability bit 33) and the device hasn't refused it. */
export const radioStatusAvailable = (s: RadioState): boolean => !!s.info && hasCapability(s.info, Capability.RadioStatus) && !s.radioStatusRefused

export interface StoreEvents {
  packet: (p: PacketEntry) => void
  linkError: (e: LinkEntry) => void
  frameIn: (f: Frame) => void
  frameOut: (f: Frame) => void
  log: (e: SessionEvent) => void
  txDone: (tag: number, done: TxDone) => void
}

const PACKETS_MAX = 2000
const LINK_ERRORS_MAX = 500
const POSTS_MAX = 500
const LOG_MAX = 200
const NOISE_HISTORY_MAX = 600
/** about 10 minutes of keepalive samples */
const MEASURED_HISTORY_MAX = 1200

const emptyStats = (): Stats => ({
  rx: 0,
  crcFail: 0,
  dropped: 0,
  good: 0,
  rssiSum: 0,
  snrSum: 0,
  status: { decoded: 0, partial: 0, undecodable: 0, 'no-key': 0 },
  stages: {},
  link: {},
  linkTotal: 0,
})

const initialState = (requested: LoRaConfig = DEFAULT_PRESET.config): RadioState => ({
  status: 'disconnected',
  demo: false,
  requested,
  rxOn: false,
  packets: [],
  linkErrors: [],
  stats: emptyStats(),
  nodes: {},
  posts: [],
  log: [],
  txArmed: false,
  noise: new NoiseFloorTracker().snapshot(),
  noiseHistory: [],
  measuredHistory: [],
  radioStatusRefused: false,
})

const initialListeners = (): { [K in keyof StoreEvents]: Set<StoreEvents[K]> } => ({
  packet: new Set(),
  linkError: new Set(),
  frameIn: new Set(),
  frameOut: new Set(),
  log: new Set(),
  txDone: new Set(),
})

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class RadioStore {
  private state: RadioState
  private client: DongLoRaClient | null = null
  private offClient: (() => void)[] = []
  private readonly subscribers = new Set<() => void>()
  private readonly listeners = initialListeners()
  private nextId = 1
  private noise = new NoiseFloorTracker()

  constructor() {
    this.state = initialState()
  }

  /** After a hot update swapped in new code: give an older instance the fields the new code expects. */
  upgrade(): void {
    this.state = { ...initialState(), ...this.state }
    if (!(this.noise instanceof NoiseFloorTracker)) this.noise = new NoiseFloorTracker()
    for (const k of Object.keys(initialListeners()) as (keyof StoreEvents)[]) this.listeners[k] ??= new Set() as never
    for (const fn of this.subscribers) fn()
  }

  // ---- React glue ----

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  getState = (): RadioState => this.state

  private patch(p: Partial<RadioState> | ((s: RadioState) => Partial<RadioState>)): void {
    this.state = { ...this.state, ...(typeof p === 'function' ? p(this.state) : p) }
    for (const fn of this.subscribers) fn()
  }

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  private emit<K extends keyof StoreEvents>(event: K, ...args: Parameters<StoreEvents[K]>): void {
    for (const l of this.listeners[event]) (l as (...a: Parameters<StoreEvents[K]>) => void)(...args)
  }

  get radio(): DongLoRaClient | null {
    return this.client
  }

  // ---- connection ----

  private log(text: string, level: SessionEvent['level'] = 'info'): void {
    const e = { at: Date.now(), text, level }
    this.patch((s) => ({ log: [e, ...s.log].slice(0, LOG_MAX) }))
    this.emit('log', e)
  }

  /** Must run synchronously inside the click handler: WebSerial's port picker needs the user gesture. */
  connectSerial(): Promise<void> {
    return this.connect(WebSerialTransport.request(), false)
  }

  connectDemo(): Promise<void> {
    return this.connect(Promise.resolve(new MockDongLoRaTransport({ traffic: true, failures: true, linkFaults: true })), true)
  }

  private async connect(transport: Promise<Transport>, demo: boolean): Promise<void> {
    if (this.client) return
    this.patch({ status: 'connecting', error: undefined, demo, radioStatus: undefined, radioStatusAt: undefined, countersBase: undefined, radioStatusRefused: false })
    let c: DongLoRaClient | null = null
    try {
      c = new DongLoRaClient(await transport)
      this.client = c
      this.attach(c)
      await c.connect()
      this.patch({ label: c.label, connectedAt: Date.now() })
      this.log(`connected to ${c.label}`)
      const info = await c.getInfo()
      this.patch({ status: 'connected', info, rxOn: false })
    } catch (err) {
      // the port may be open even though setup failed: close it so Connect works again
      await this.dropClient()
      this.patch({ status: 'disconnected', error: `connect failed: ${message(err)}` })
      return
    }
    // a fresh session is always UNCONFIGURED: configure, then listen
    try {
      await this.applyConfig(this.state.requested)
      await this.startRx()
    } catch (err) {
      this.patch({ error: message(err) })
    }
  }

  private attach(c: DongLoRaClient): void {
    this.client = c
    this.offClient = [
      c.on('rx', (rx) => this.onRx(rx)),
      c.on('linkError', (e) => this.onLinkError(e)),
      c.on('frameIn', (f) => this.emit('frameIn', f)),
      c.on('frameOut', (f) => this.emit('frameOut', f)),
      c.on('config', (applied) => this.patch({ applied })),
      c.on('keepalive', (h) => this.patch({ health: { ...h } })),
      c.on('radioStatus', (status) => this.onRadioStatus(status)),
      c.on('radioStatusUnsupported', (reason) => {
        this.log(reason, 'warn')
        this.patch({ radioStatusRefused: true })
      }),
      c.on('sessionLost', (reason) => this.log(`session lost: ${reason}`, 'warn')),
      c.on('recovered', () => {
        this.log('session restored: config re-sent' + (c.rxWanted ? ', RX restarted' : ''))
        this.patch({ rxOn: c.rxWanted })
      }),
      c.on('txDone', (tag, done) => this.emit('txDone', tag, done)),
      c.on('close', (err) => {
        this.offClient.forEach((off) => off())
        this.offClient = []
        this.client = null
        this.log(err ? `connection lost: ${err.message}` : 'disconnected', err ? 'err' : 'info')
        this.patch((s) => ({ status: 'disconnected', rxOn: false, txArmed: false, error: err ? `connection lost: ${err.message}` : s.error }))
      }),
    ]
  }

  private async dropClient(): Promise<void> {
    const c = this.client
    if (!c) return
    if (c.isOpen) await c.disconnect().catch(() => {})
    this.offClient.forEach((off) => off())
    this.offClient = []
    this.client = null
  }

  /** Also cancels a connect that is still in progress. */
  async disconnect(): Promise<void> {
    const c = this.client
    if (c?.isOpen) {
      // stop RX first so the dongle goes idle straight away, not after its 1 s timeout
      if (this.state.rxOn) await c.rxStop().catch(() => {})
      await c.disconnect()
    } else {
      await this.dropClient()
      this.patch({ status: 'disconnected' })
    }
  }

  private need(): DongLoRaClient {
    const c = this.client
    if (!c?.isOpen) throw new Error('not connected')
    return c
  }

  // ---- radio ----

  setRequested(config: LoRaConfig): void {
    this.patch({ requested: config })
  }

  /** SET_CONFIG, then RX_START again if RX was on (SET_CONFIG stops it). */
  async applyConfig(config: LoRaConfig): Promise<SetConfigReply> {
    const c = this.need()
    const problems = validateConfig(config, this.state.info)
    if (problems.length) throw new Error(problems.join('; '))
    const wasRx = this.state.rxOn
    this.patch({ requested: config })
    const reply = await c.setConfig(config)
    this.patch({ applied: reply, rxOn: false })
    this.log(`config applied: result ${reply.result === 0 ? 'APPLIED' : reply.result}`)
    if (wasRx) await this.startRx()
    return reply
  }

  async startRx(): Promise<void> {
    await this.need().rxStart()
    this.patch({ rxOn: true })
  }

  async stopRx(): Promise<void> {
    await this.need().rxStop()
    this.patch({ rxOn: false })
  }

  async ping(): Promise<number> {
    return this.need().ping()
  }

  async refreshInfo(): Promise<DeviceInfo> {
    const info = await this.need().getInfo()
    this.patch({ info })
    return info
  }

  // ---- TX (off unless armed) ----

  armTx(armed: boolean): void {
    if (armed && !this.client?.isOpen) throw new Error('not connected')
    this.patch({ txArmed: armed })
    this.log(armed ? 'TX armed' : 'TX disarmed', armed ? 'warn' : 'info')
  }

  /** The caller confirms with the user each time; this refuses unless TX is armed. */
  async transmit(data: Uint8Array): Promise<TxDone> {
    if (!this.state.txArmed) throw new Error('TX is not armed (Radio tab)')
    const c = this.need()
    if (!data.length) throw new Error('nothing to send')
    if (this.state.info && data.length > this.state.info.maxPayloadBytes) throw new Error(`packet is over ${this.state.info.maxPayloadBytes} bytes`)
    this.log(`TX ${data.length} B`, 'warn')
    return c.transmit(data)
  }

  // ---- incoming ----

  private onRx(rx: RxPacket): void {
    const mesh = decodeMeshCore(rx.data, { channels: [PUBLIC_CHANNEL], verifySignatures: true })
    const at = Date.now()
    const noiseDbm = this.noise.addPacket(rx.rssi, rx.snr, rx.crcValid, at)
    const noise = this.noise.snapshot(at)
    const entry: PacketEntry = { id: this.nextId++, at, rx, mesh, noise: noiseDbm }
    const point: NoisePoint = { at, rssi: rx.rssi, crcValid: rx.crcValid, noise: noiseDbm, floor: noise.floor, median: noise.median }
    this.patch((s) => {
      const st = { ...s.stats, status: { ...s.stats.status }, stages: { ...s.stats.stages } }
      st.rx++
      st.dropped += rx.packetsDropped
      st.status[mesh.status]++
      if (mesh.failure) st.stages[mesh.failure.stage] = (st.stages[mesh.failure.stage] ?? 0) + 1
      if (!rx.crcValid) st.crcFail++
      else {
        st.good++
        st.rssiSum += rx.rssi
        st.snrSum += rx.snr
        st.rssiMin = Math.min(st.rssiMin ?? rx.rssi, rx.rssi)
        st.rssiMax = Math.max(st.rssiMax ?? rx.rssi, rx.rssi)
        st.snrMin = Math.min(st.snrMin ?? rx.snr, rx.snr)
        st.snrMax = Math.max(st.snrMax ?? rx.snr, rx.snr)
      }
      st.last = { rssi: rx.rssi, snr: rx.snr, at: entry.at }
      const next: Partial<RadioState> = {
        stats: st,
        packets: [entry, ...s.packets].slice(0, PACKETS_MAX),
        noise,
        noiseHistory: [...s.noiseHistory, point].slice(-NOISE_HISTORY_MAX),
      }
      // only trust what passed both CRCs and decoded cleanly
      if (rx.crcValid && mesh.status === 'decoded') {
        const a = mesh.advert
        if (a?.publicKey && a.signatureValid) {
          const prev = s.nodes[a.publicKey]
          next.nodes = {
            ...s.nodes,
            [a.publicKey]: {
              publicKey: a.publicKey,
              name: a.name ?? prev?.name ?? '',
              type: a.type ?? 0,
              typeName: a.typeName ?? '',
              firstHeard: prev?.firstHeard ?? entry.at,
              lastHeard: entry.at,
              advertTimestamp: a.timestamp ?? 0,
              rssi: rx.rssi,
              snr: rx.snr,
              hops: mesh.hops ?? 0,
              lat: a.hasLocation ? a.lat : prev?.lat,
              lon: a.hasLocation ? a.lon : prev?.lon,
              adverts: (prev?.adverts ?? 0) + 1,
            },
          }
        }
        const g = mesh.group
        if (g?.text !== undefined) {
          const post: ChannelPost = {
            id: entry.id,
            at: entry.at,
            channel: g.channel ?? '',
            sender: g.sender ?? '',
            body: g.body ?? '',
            timestamp: g.timestamp ?? 0,
            hops: mesh.hops ?? 0,
            rssi: rx.rssi,
            snr: rx.snr,
          }
          next.posts = [...s.posts, post].slice(-POSTS_MAX)
        }
      }
      return next
    })
    if (rx.packetsDropped) this.log(`device dropped ${rx.packetsDropped} packet${rx.packetsDropped === 1 ? '' : 's'} (RX queue full)`, 'warn')
    this.emit('packet', entry)
  }

  /** Every keepalive on firmware 1.6.0: a measured noise sample (when receiving), front end and counters. */
  private onRadioStatus(status: RadioStatus): void {
    const at = Date.now()
    if (status.rssiInst !== null) this.noise.add({ at, dbm: status.rssiInst, source: 'measured' })
    // taken on every reply, so the source falls back to packet estimates once RSSI stops coming
    const noise = this.noise.snapshot(at)
    this.patch((s) => {
      const b = s.countersBase
      // a new connection, or the dongle rebooted and its counters started again
      const rebase = !b || status.rxOk < b.rxOk || status.rxCrcErr < b.rxCrcErr || status.rxHeaderErr < b.rxHeaderErr
      const next: Partial<RadioState> = { radioStatus: status, radioStatusAt: at, countersBase: rebase ? status : b, noise }
      if (status.rssiInst !== null) {
        const point: MeasuredPoint = { at, dbm: status.rssiInst, floor: noise.floor, median: noise.median }
        next.measuredHistory = [...s.measuredHistory, point].slice(-MEASURED_HISTORY_MAX)
      }
      return next
    })
  }

  private onLinkError(e: LinkError): void {
    const entry: LinkEntry = { ...e, id: this.nextId++ }
    this.patch((s) => ({
      linkErrors: [entry, ...s.linkErrors].slice(0, LINK_ERRORS_MAX),
      stats: { ...s.stats, linkTotal: s.stats.linkTotal + 1, link: { ...s.stats.link, [e.kind]: (s.stats.link[e.kind] ?? 0) + 1 } },
    }))
    this.emit('linkError', entry)
  }

  clearPackets(): void {
    this.patch({ packets: [] })
  }

  clearLinkErrors(): void {
    this.patch({ linkErrors: [] })
  }

  resetStats(): void {
    this.noise = new NoiseFloorTracker()
    this.patch((s) => ({ stats: emptyStats(), noise: this.noise.snapshot(), noiseHistory: [], measuredHistory: [], countersBase: s.radioStatus }))
  }

  clearError(): void {
    this.patch({ error: undefined })
  }

  setError(err: unknown): void {
    this.patch({ error: message(err) })
  }
}

const g = globalThis as typeof globalThis & { __dongloraStore?: RadioStore }

function singleton(): RadioStore {
  const prev = g.__dongloraStore
  if (!prev) return (g.__dongloraStore = new RadioStore())
  // Vite re-ran this module: keep the live instance, give it this version's methods. Listeners the client
  // holds call through `this`, so they reach the new methods too.
  Object.setPrototypeOf(prev, RadioStore.prototype)
  prev.upgrade()
  return prev
}

export const store = singleton()
