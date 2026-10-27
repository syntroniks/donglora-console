// Connection state for one dongle session: the client, received packets decoded by the protocol plugins,
// the nodes and messages they learned, stats and the noise floor. Nothing here knows how the bytes travel,
// so the page (src/ui/store.ts), the console server (server/) and scripts see the same session.

import { DongLoRaClient, type KeepaliveHealth, type LinkError, type LinkErrorKind, type Transport } from '../protocol/client.ts'
import type { Frame } from '../protocol/framing.ts'
import { Capability, SET_CONFIG_RESULT_NAMES, TX_RESULT_NAMES, TxResult } from '../protocol/codes.ts'
import { hasCapability, type DeviceInfo, type LoRaConfig, type RadioStatus, type RxPacket, type SetConfigReply, type TxDone } from '../protocol/messages.ts'
import { validateConfig } from '../protocol/lora.ts'
import { decodePacket, DEFAULT_PRESET, pluginById, pluginsFor, type DecodeStatus, type MessageSighting, type NodeSighting, type PacketDecode } from '../plugins/index.ts'
import { NoiseFloorTracker, type NoiseFloorState } from '../radio/noiseFloor.ts'

export type Status = 'disconnected' | 'connecting' | 'connected'

export interface PacketEntry {
  id: number
  at: number // Date.now() when it arrived
  rx: RxPacket
  decode: PacketDecode
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

/** A node some plugin learned about, merged across its sightings. Keyed `${protocol}:${id}` in RadioState.nodes. */
export interface HeardNode {
  protocol: string
  id: string
  name: string
  shortName?: string
  kind?: string
  firstHeard: number
  lastHeard: number
  rssi: number
  snr: number
  hops?: number
  lat?: number
  lon?: number
  /** packets that told us something about it */
  sightings: number
  details: Record<string, string>
}

export interface Message {
  id: number
  at: number
  protocol: string
  channel: string
  sender: string
  text: string
  /** sender's clock, unix seconds, when the protocol carries one */
  sentAt?: number
  /** of the first copy heard */
  hops?: number
  /** of the first copy heard; not set for a message this console sent */
  rssi?: number
  snr?: number
  /** copies heard: a flooded message arrives once per path. For a sent one, the copies heard back. */
  copies: number
  key?: string
  /** this console sent it; `tx` says how that went */
  outgoing?: boolean
  tx?: { result: number; airtimeUs: number }
  /** heard as another client's transmission on this dongle (through mux), not over the air */
  local?: boolean
}

/** A message that can't be sent as given: no plugin for the config, a bad channel or sender, too long. */
export class SendError extends Error {}

export interface SendInput {
  /** plugin id; default: the first plugin that claims the radio config and can send */
  protocol?: string
  /** default: the plugin's best channel for the radio config */
  channel?: string
  text: string
  sender: string
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
  /** failures by plugin and the stage they stopped at, keyed `${protocol}/${stage}` (no-key included) */
  stages: Partial<Record<string, number>>
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
  messages: Message[]
  log: SessionEvent[]
  txArmed: boolean
  /** why TX can't be armed on this connection, eg. a console server started without --allow-tx */
  txBlocked?: string
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
  /** a node was heard; `isNew` the first time this session */
  node: (n: HeardNode, isNew: boolean) => void
  message: (m: Message) => void
  linkError: (e: LinkEntry) => void
  frameIn: (f: Frame) => void
  frameOut: (f: Frame) => void
  log: (e: SessionEvent) => void
  txDone: (tag: number, done: TxDone) => void
}

const PACKETS_MAX = 2000
const LINK_ERRORS_MAX = 500
const MESSAGES_MAX = 500
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
  status: { decoded: 0, partial: 0, undecodable: 0, 'no-key': 0, unknown: 0 },
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
  messages: [],
  log: [],
  txArmed: false,
  noise: new NoiseFloorTracker().snapshot(),
  noiseHistory: [],
  measuredHistory: [],
  radioStatusRefused: false,
})

const initialListeners = (): { [K in keyof StoreEvents]: Set<StoreEvents[K]> } => ({
  packet: new Set(),
  node: new Set(),
  message: new Set(),
  linkError: new Set(),
  frameIn: new Set(),
  frameOut: new Set(),
  log: new Set(),
  txDone: new Set(),
})

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function mergeNode(prev: HeardNode | undefined, s: NodeSighting, protocol: string, rx: RxPacket, at: number): HeardNode {
  return {
    protocol,
    id: s.id,
    name: s.name ?? prev?.name ?? '',
    shortName: s.shortName ?? prev?.shortName,
    kind: s.kind ?? prev?.kind,
    firstHeard: prev?.firstHeard ?? at,
    lastHeard: at,
    rssi: rx.rssi,
    snr: rx.snr,
    hops: s.hops ?? prev?.hops,
    lat: s.lat ?? prev?.lat,
    lon: s.lon ?? prev?.lon,
    sightings: (prev?.sightings ?? 0) + 1,
    details: { ...prev?.details, ...s.details },
  }
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length

const messageOf = (m: MessageSighting, p: PacketEntry, protocol: string, id: number): Message => ({
  id,
  at: p.at,
  protocol,
  channel: m.channel,
  sender: m.sender,
  text: m.text,
  sentAt: m.sentAt,
  hops: m.hops,
  rssi: p.rx.rssi,
  snr: p.rx.snr,
  copies: 1,
  key: m.key,
  local: p.rx.origin === 1 || undefined,
})

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

  protected patch(p: Partial<RadioState> | ((s: RadioState) => Partial<RadioState>)): void {
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

  /** Open the transport, read GET_INFO, apply the requested config and start RX. A no-op while connected. */
  async connectTransport(transport: Transport | Promise<Transport>, demo = false): Promise<void> {
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
    const shared = reply.owner === 2 ? ' (another client set it first; through mux that config stays)' : ''
    this.log(`config applied: ${SET_CONFIG_RESULT_NAMES[reply.result] ?? `result ${reply.result}`}${shared}`)
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
    if (armed && this.state.txBlocked) throw new Error(this.state.txBlocked)
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

  /**
   * Post a channel message through the plugin that decodes this radio config. Needs TX armed, like
   * transmit(): arming is the consent, so this doesn't ask again per message. The sent message joins the
   * list, and the mesh's copies of it count as heard back.
   */
  async sendMessage(input: SendInput): Promise<{ done: TxDone; message: Message }> {
    const config = this.state.applied?.lora ?? this.state.requested
    const plugin = input.protocol ? pluginById(input.protocol) : pluginsFor(config).find((p) => p.compose)
    if (!plugin?.compose) throw new SendError(input.protocol ? `${input.protocol} can't send messages` : 'no plugin that can send claims this radio config: pick a MeshCore or Meshtastic preset')
    if (!plugin.claims(config)) throw new SendError(`the radio isn't set up for ${plugin.name}: pick a ${plugin.name} preset first`)
    const compose = plugin.compose
    const channel = input.channel ?? compose.channels(config)[0]
    if (!compose.channels(config).includes(channel)) throw new SendError(`${plugin.name} can't post to '${channel}'`)
    const text = input.text.trim()
    const sender = input.sender.trim()
    if (!text) throw new SendError('nothing to send')
    const problem = compose.senderProblem?.(sender)
    if (problem) throw new SendError(problem)
    const max = compose.maxTextBytes(sender)
    if (utf8Length(text) > max) throw new SendError(`message is ${utf8Length(text)} bytes; ${plugin.name} fits ${max} in one packet`)
    const composed = compose.build({ channel, text, sender, now: Math.floor(Date.now() / 1000) })
    const done = await this.transmit(composed.bytes)
    const m = composed.message
    const sent = done.result === TxResult.Transmitted
    const message: Message = {
      id: this.nextId++,
      at: Date.now(),
      protocol: plugin.id,
      channel: m.channel,
      sender: m.sender,
      text: m.text,
      sentAt: m.sentAt,
      hops: 0,
      copies: 0,
      // only a message that went out can be heard back
      key: sent ? m.key : undefined,
      outgoing: true,
      tx: { result: done.result, airtimeUs: done.airtimeUs },
    }
    this.patch((s) => ({ messages: [...s.messages, message].slice(-MESSAGES_MAX) }))
    this.log(sent ? `sent to ${plugin.name} ${m.channel}: ${text}` : `not sent (${TX_RESULT_NAMES[done.result] ?? done.result}): ${text}`, sent ? 'info' : 'warn')
    return { done, message }
  }

  // ---- incoming ----

  private onRx(rx: RxPacket): void {
    const at = Date.now()
    const decode = decodePacket(rx.data, rx, this.state.applied?.lora ?? this.state.requested)
    const noiseDbm = this.noise.addPacket(rx.rssi, rx.snr, rx.crcValid, at)
    const noise = this.noise.snapshot(at)
    const entry: PacketEntry = { id: this.nextId++, at, rx, decode, noise: noiseDbm }
    const point: NoisePoint = { at, rssi: rx.rssi, crcValid: rx.crcValid, noise: noiseDbm, floor: noise.floor, median: noise.median }
    // only learn from packets that passed the radio's CRC; the plugin decides what else it trusts
    const learned = rx.crcValid ? (pluginById(decode.protocol)?.learn?.(decode, rx) ?? {}) : {}
    const heard: { node: HeardNode; isNew: boolean }[] = []
    const said: Message[] = []
    this.patch((s) => {
      const st = { ...s.stats, status: { ...s.stats.status }, stages: { ...s.stats.stages } }
      st.rx++
      st.dropped += rx.packetsDropped
      st.status[decode.status]++
      if (decode.failure) {
        const key = `${decode.protocol}/${decode.failure.stage}`
        st.stages[key] = (st.stages[key] ?? 0) + 1
      }
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
      if (learned.nodes?.length) {
        const nodes = { ...s.nodes }
        for (const sighting of learned.nodes) {
          const key = `${decode.protocol}:${sighting.id}`
          const node = mergeNode(nodes[key], sighting, decode.protocol, rx, at)
          heard.push({ node, isNew: !nodes[key] })
          nodes[key] = node
        }
        next.nodes = nodes
      }
      if (learned.messages?.length) {
        let messages = s.messages
        for (const m of learned.messages) {
          const i = m.key ? messages.findLastIndex((x) => x.protocol === decode.protocol && x.key === m.key) : -1
          if (i >= 0) {
            // another copy of a message already heard: count it, don't repeat it
            messages = messages.with(i, { ...messages[i], copies: messages[i].copies + 1 })
          } else {
            const msg = messageOf(m, entry, decode.protocol, this.nextId++)
            said.push(msg)
            messages = [...messages, msg]
          }
        }
        next.messages = messages.slice(-MESSAGES_MAX)
      }
      return next
    })
    if (rx.packetsDropped) this.log(`device dropped ${rx.packetsDropped} packet${rx.packetsDropped === 1 ? '' : 's'} (RX queue full)`, 'warn')
    this.emit('packet', entry)
    for (const h of heard) this.emit('node', h.node, h.isNew)
    for (const m of said) this.emit('message', m)
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
