// DongLoRa host client (PROTOCOL.md §11, §14).
//
// Every command carries a u16 tag the device echoes in its OK / ERR, so several commands can be in flight
// and replies are matched by tag. TX finishes in two steps: OK when queued, TX_DONE (same tag) when it
// has gone out. RX events and async errors carry tag 0.
//
// The device drops to UNCONFIGURED after 1000 ms without a frame, so the client owns a keepalive: a PING
// whenever nothing else has been written for KEEPALIVE_MS. When GET_INFO advertises RADIO_STATUS (v1.1,
// capability bit 33) the client also polls it on its own, slower schedule (statusPollMs), for RSSI, the
// front end and the RX counters. Keeping the two apart matters on firmware 1.6.0, where every command the
// radio task takes interrupts RX; 1.6.1 answers both without the radio task. PING still succeeds after a
// timeout, so the client also notices gaps in its own writes and probes the session, and on ENOTCONFIGURED
// it re-sends the last config and restarts RX (§14.2).
//
// Nothing that arrives is dropped quietly: frames that fail to decode, unknown types, async errors and
// replies nobody is waiting for are all reported as 'linkError'.

import { toHex } from './bytes.ts'
import { Capability, ERR_CODE_NAMES, ERR_CODE_TEXT, ErrCode, INACTIVITY_TIMEOUT_MS, MSG_TYPE_NAMES, MsgType } from './codes.ts'
import { encodeFrame, frameBody, FrameDecoder, type Frame, type FrameFault, type FrameFaultKind } from './framing.ts'
import { airtimeUs } from './lora.ts'
import {
  hasCapability,
  parseErr,
  parseInfo,
  parseRadioStatus,
  parseRx,
  parseSetConfigReply,
  parseTxDone,
  setConfigPayload,
  txPayload,
  type DeviceInfo,
  type LoRaConfig,
  type RadioStatus,
  type RxPacket,
  type SetConfigReply,
  type TxDone,
} from './messages.ts'
import { defaultTicker, type Ticker, type TickerFactory } from './ticker.ts'

export interface TransportSink {
  onData(chunk: Uint8Array): void
  /** a problem the transport recovered from, eg. a serial overrun that lost bytes */
  onError?(error: Error): void
  onClose(error?: Error): void
}

/** A byte pipe to the device: WebSerial in the browser, node-serialport in scripts, or the mock. */
export interface Transport {
  readonly label: string
  open(sink: TransportSink): Promise<void>
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export class DongLoRaError extends Error {
  readonly code: number
  readonly command: string

  constructor(code: number, command: string) {
    super(`${command}: ${ERR_CODE_NAMES[code] ?? `error 0x${code.toString(16)}`} (${ERR_CODE_TEXT[code] ?? 'unknown error code'})`)
    this.name = 'DongLoRaError'
    this.code = code
    this.command = command
  }
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`no reply to ${what} within ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

export type LinkErrorKind = FrameFaultKind | 'unknown-type' | 'async-err' | 'unmatched' | 'bad-payload' | 'transport'

/** Something on the link that didn't decode or didn't fit, with the bytes it arrived as. */
export interface LinkError {
  at: number // Date.now()
  kind: LinkErrorKind
  reason: string
  bytes: Uint8Array // pre-COBS frame when it decoded that far, else the wire bytes
  offset?: number // into bytes, where it went wrong
  code?: number // for async-err
}

export const LINK_ERROR_NAMES: Record<LinkErrorKind, string> = {
  cobs: 'COBS',
  short: 'too short',
  crc: 'frame CRC',
  overflow: 'overflow',
  'unknown-type': 'unknown type',
  'async-err': 'device error',
  unmatched: 'unmatched tag',
  'bad-payload': 'bad payload',
  transport: 'serial error',
}

export interface KeepaliveHealth {
  /** what the keepalive sends; RADIO_STATUS is polled separately */
  command: 'PING'
  pings: number // keepalive PINGs answered
  failures: number // keepalive PINGs that timed out or failed
  lastRttMs?: number
  avgRttMs?: number
  lastOkAt?: number
  /** longest time between two writes since connecting; over 1000 ms means the device may have reset */
  maxGapMs: number
  lostSessions: number
  recoveries: number
}

export interface ClientEvents {
  frameIn: (frame: Frame) => void
  frameOut: (frame: Frame) => void
  rx: (packet: RxPacket) => void
  txDone: (tag: number, done: TxDone) => void
  config: (reply: SetConfigReply) => void
  linkError: (error: LinkError) => void
  /** the device reported or implied it was no longer configured; recovery follows if there's a config */
  sessionLost: (reason: string) => void
  recovered: (reply: SetConfigReply) => void
  keepalive: (health: KeepaliveHealth) => void
  /** every RADIO_STATUS reply, from the keepalive or a direct call */
  radioStatus: (status: RadioStatus) => void
  /** GET_INFO advertised RADIO_STATUS but the device answered EUNKNOWN_CMD; the keepalive is back on PING */
  radioStatusUnsupported: (reason: string) => void
  close: (error?: Error) => void
}

export interface ClientOptions {
  /** per-command timeout (§14.2 suggests 2000 ms) */
  timeoutMs?: number
  /** write a keepalive when nothing has been written for this long (§14.2: 500 ms or better) */
  keepaliveMs?: number
  /** poll RADIO_STATUS this often when the device has it; 0 to never poll */
  statusPollMs?: number
  ticker?: TickerFactory
}

interface Pending {
  type: number
  what: string
  resolve: (payload: Uint8Array) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** TX only: whether the OK has arrived (TX_DONE is next), and how long to wait for TX_DONE */
  tx?: { accepted: boolean; doneTimeoutMs: number }
}

const TICK_MS = 100
const MAX_KEEPALIVES_IN_FLIGHT = 4
/** a write gap this long means the device may have hit its 1000 ms timeout */
const GAP_SUSPECT_MS = INACTIVITY_TIMEOUT_MS - 100
/** time allowed for CAD before a TX starts, on top of airtime */
const CAD_ALLOWANCE_MS = 300

export class DongLoRaClient {
  private readonly transport: Transport
  private readonly decoder: FrameDecoder
  private readonly timeoutMs: number
  private readonly keepaliveMs: number
  private readonly statusPollMs: number
  private readonly tickerFactory: TickerFactory
  private readonly listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    frameIn: new Set(),
    frameOut: new Set(),
    rx: new Set(),
    txDone: new Set(),
    config: new Set(),
    linkError: new Set(),
    sessionLost: new Set(),
    recovered: new Set(),
    keepalive: new Set(),
    radioStatus: new Set(),
    radioStatusUnsupported: new Set(),
    close: new Set(),
  }
  private readonly pending = new Map<number, Pending>()
  private nextTag = 1
  private writeChain: Promise<void> = Promise.resolve()
  private open = false
  private ticker: Ticker | null = null
  private lastWriteAt = 0
  private keepalivesInFlight = 0
  private lastKeepaliveAt = 0
  private lastStatusPollAt = 0
  private statusPolling = false
  private radioStatusRefused = false
  private probing = false
  private recovering: Promise<void> | null = null
  private rttSum = 0
  private rttCount = 0

  info?: DeviceInfo
  /** what the device echoed for the last SET_CONFIG */
  applied?: SetConfigReply
  /** the config to restore after a lost session */
  wanted?: LoRaConfig
  rxWanted = false
  readonly health: KeepaliveHealth = { command: 'PING', pings: 0, failures: 0, maxGapMs: 0, lostSessions: 0, recoveries: 0 }

  constructor(transport: Transport, options: ClientOptions = {}) {
    this.transport = transport
    this.timeoutMs = options.timeoutMs ?? 2000
    this.keepaliveMs = options.keepaliveMs ?? 400
    this.statusPollMs = options.statusPollMs ?? 1000
    this.tickerFactory = options.ticker ?? defaultTicker
    this.decoder = new FrameDecoder((f) => this.onFrameFault(f))
  }

  get label(): string {
    return this.transport.label
  }

  get isOpen(): boolean {
    return this.open
  }

  /** GET_INFO sets capability bit 33 (firmware 1.6.0, protocol v1.1), and the device hasn't refused it */
  get radioStatusSupported(): boolean {
    return !!this.info && hasCapability(this.info, Capability.RadioStatus) && !this.radioStatusRefused
  }

  on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const l of this.listeners[event]) (l as (...a: Parameters<ClientEvents[K]>) => void)(...args)
  }

  // ---- connection --------------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.transport.open({
      onData: (chunk) => this.onData(chunk),
      onError: (err) => this.linkError('transport', err.message, new Uint8Array(0)),
      onClose: (err) => void this.onTransportClose(err),
    })
    this.open = true
    this.lastWriteAt = Date.now()
    this.ticker = this.tickerFactory(TICK_MS, () => this.tick())
  }

  async disconnect(): Promise<void> {
    if (!this.open) return
    this.shutdown(new Error('disconnected'))
    await this.transport.close()
    this.emit('close')
  }

  private async onTransportClose(err?: Error): Promise<void> {
    if (!this.open) return
    this.shutdown(err ?? new Error('connection closed'))
    // the stream may be gone but the port itself is still open; close it so a reconnect can open it
    await this.transport.close().catch(() => {})
    this.emit('close', err)
  }

  private shutdown(err: Error): void {
    this.open = false
    this.ticker?.stop()
    this.ticker = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  // ---- inbound -----------------------------------------------------------------------------------

  private onData(chunk: Uint8Array): void {
    for (const frame of this.decoder.push(chunk)) {
      this.emit('frameIn', frame)
      this.dispatch(frame)
    }
  }

  private onFrameFault(f: FrameFault): void {
    this.linkError(f.kind, f.reason, f.body ?? f.wire, f.offset)
  }

  private linkError(kind: LinkErrorKind, reason: string, bytes: Uint8Array, offset?: number, code?: number): void {
    this.emit('linkError', { at: Date.now(), kind, reason, bytes, offset, code })
  }

  private dispatch(f: Frame): void {
    const body = () => frameBody(f.type, f.tag, f.payload)
    const name = MSG_TYPE_NAMES[f.type] ?? `0x${f.type.toString(16)}`
    switch (f.type) {
      case MsgType.Ok:
      case MsgType.Err:
      case MsgType.TxDone: {
        if (f.type === MsgType.Err && f.tag === 0) {
          const code = parseErr(f.payload)
          const reason = `async ${ERR_CODE_NAMES[code] ?? `error 0x${code.toString(16)}`}: ${ERR_CODE_TEXT[code] ?? 'unknown error code'}`
          this.linkError('async-err', reason, body(), 3, code)
          return
        }
        const p = this.pending.get(f.tag)
        if (!p) {
          this.linkError('unmatched', `${name} for tag 0x${f.tag.toString(16).padStart(4, '0')}, which has no command waiting (a reply after its timeout?)`, body(), 1)
          return
        }
        if (f.type === MsgType.Err) {
          const code = parseErr(f.payload)
          this.settle(f.tag, p)
          p.reject(new DongLoRaError(code, p.what))
          return
        }
        if (f.type === MsgType.TxDone) {
          if (!p.tx) {
            this.linkError('unmatched', `TX_DONE for tag 0x${f.tag.toString(16)}, which is a ${MSG_TYPE_NAMES[p.type]}, not a TX`, body(), 0)
            return
          }
          if (f.payload.length < 5) {
            this.linkError('bad-payload', `TX_DONE payload is ${f.payload.length} bytes, expected 5`, body(), 3)
            return
          }
          this.settle(f.tag, p)
          p.resolve(f.payload)
          this.emit('txDone', f.tag, parseTxDone(f.payload))
          return
        }
        if (p.tx && !p.tx.accepted) {
          // TX queued; the same tag stays open until TX_DONE
          p.tx.accepted = true
          clearTimeout(p.timer)
          p.timer = setTimeout(() => this.timeout(f.tag, `${p.what} (TX_DONE)`, p.tx!.doneTimeoutMs), p.tx.doneTimeoutMs)
          return
        }
        this.settle(f.tag, p)
        p.resolve(f.payload)
        return
      }
      case MsgType.Rx: {
        if (f.payload.length < 20) {
          this.linkError('bad-payload', `RX payload is ${f.payload.length} bytes, the metadata alone is 20`, body(), 3 + f.payload.length)
          return
        }
        this.emit('rx', parseRx(f.payload))
        return
      }
      default:
        this.linkError('unknown-type', `unknown frame type 0x${f.type.toString(16).padStart(2, '0')}${f.type < 0x80 ? ' (a host command type, from the device?)' : ''}`, body(), 0)
    }
  }

  private settle(tag: number, p: Pending): void {
    clearTimeout(p.timer)
    this.pending.delete(tag)
  }

  private timeout(tag: number, what: string, ms: number): void {
    const p = this.pending.get(tag)
    if (!p) return
    this.pending.delete(tag)
    p.reject(new TimeoutError(what, ms))
  }

  // ---- outbound ----------------------------------------------------------------------------------

  private allocTag(): number {
    for (let i = 0; i < 0xffff; i++) {
      const tag = this.nextTag
      this.nextTag = tag === 0xffff ? 1 : tag + 1
      if (!this.pending.has(tag)) return tag
    }
    throw new Error('all 65535 tags are outstanding')
  }

  /** Writes go one at a time, in order, whoever sends them (keepalive, UI, recovery). */
  private write(frame: Frame): Promise<void> {
    this.emit('frameOut', frame)
    const wire = encodeFrame(frame.type, frame.tag, frame.payload)
    const done = this.writeChain.then(async () => {
      await this.transport.write(wire)
      const now = Date.now()
      this.health.maxGapMs = Math.max(this.health.maxGapMs, now - this.lastWriteAt)
      this.lastWriteAt = now
    })
    this.writeChain = done.catch(() => {})
    return done
  }

  private command(type: number, payload: Uint8Array = new Uint8Array(0), what = MSG_TYPE_NAMES[type], tx?: Pending['tx']): Promise<Uint8Array> {
    if (!this.open) return Promise.reject(new Error('not connected'))
    const tag = this.allocTag()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.timeout(tag, what, this.timeoutMs), this.timeoutMs)
      this.pending.set(tag, { type, what, resolve, reject, timer, tx })
      this.write({ type, tag, payload }).catch((err: Error) => {
        const p = this.pending.get(tag)
        if (!p) return
        this.settle(tag, p)
        reject(err)
      })
    })
  }

  // ---- commands ----------------------------------------------------------------------------------

  /** Round-trip time in ms. */
  async ping(): Promise<number> {
    const t0 = performance.now()
    await this.command(MsgType.Ping)
    return performance.now() - t0
  }

  async getInfo(): Promise<DeviceInfo> {
    this.info = this.parse('GET_INFO', await this.command(MsgType.GetInfo), parseInfo)
    return this.info
  }

  /**
   * Instantaneous RSSI, RX gain, front-end state and RX counters (v1.1). Resolves undefined without sending
   * anything when GET_INFO doesn't advertise it, and when the device answers EUNKNOWN_CMD anyway; after
   * that the client stops polling it.
   */
  async radioStatus(): Promise<RadioStatus | undefined> {
    if (!this.radioStatusSupported) return undefined
    let payload: Uint8Array
    try {
      payload = await this.command(MsgType.RadioStatus)
    } catch (err) {
      if (!(err instanceof DongLoRaError && err.code === ErrCode.UnknownCmd)) throw err
      this.radioStatusRefused = true
      this.emit('radioStatusUnsupported', 'GET_INFO advertises RADIO_STATUS, but the device answered EUNKNOWN_CMD; no longer polling it')
      return undefined
    }
    const status = this.parse('RADIO_STATUS', payload, parseRadioStatus)
    this.emit('radioStatus', status)
    return status
  }

  /** Configure the radio. The reply echoes what the radio is actually running. */
  async setConfig(config: LoRaConfig): Promise<SetConfigReply> {
    this.wanted = config
    const reply = await this.sendConfig(config)
    // SET_CONFIG stops continuous RX (§6.5)
    this.rxWanted = false
    return reply
  }

  private async sendConfig(config: LoRaConfig): Promise<SetConfigReply> {
    const reply = this.parse('SET_CONFIG', await this.command(MsgType.SetConfig, setConfigPayload(config)), parseSetConfigReply)
    this.applied = reply
    this.emit('config', reply)
    return reply
  }

  async rxStart(): Promise<void> {
    this.rxWanted = true
    await this.withRecovery(() => this.command(MsgType.RxStart))
  }

  async rxStop(): Promise<void> {
    this.rxWanted = false
    await this.withRecovery(() => this.command(MsgType.RxStop))
  }

  /**
   * Transmit one packet; resolves with TX_DONE. Only the caller decides whether transmitting is allowed:
   * the firmware enforces no regulatory limits. Not retried after a lost session (§14.2).
   */
  async transmit(data: Uint8Array, { skipCad = false } = {}): Promise<TxDone> {
    const airMs = this.applied?.lora ? airtimeUs(this.applied.lora, data.length) / 1000 : 2000
    const doneTimeoutMs = Math.ceil(this.timeoutMs + airMs + CAD_ALLOWANCE_MS)
    try {
      const done = await this.command(MsgType.Tx, txPayload(data, skipCad), 'TX', { accepted: false, doneTimeoutMs })
      return this.parse('TX_DONE', done, parseTxDone)
    } catch (err) {
      if (err instanceof DongLoRaError && err.code === ErrCode.NotConfigured) void this.recover('TX answered ENOTCONFIGURED').catch(() => {})
      throw err
    }
  }

  /** A reply payload that doesn't parse is a link error as well as a failed command. */
  private parse<T>(what: string, payload: Uint8Array, fn: (p: Uint8Array) => T): T {
    try {
      return fn(payload)
    } catch (err) {
      this.linkError('bad-payload', `${what} reply: ${err instanceof Error ? err.message : err}`, payload)
      throw err
    }
  }

  /** Runs an RX command; if the device says it's unconfigured, restores the session (which redoes RX). */
  private async withRecovery(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof DongLoRaError && err.code === ErrCode.NotConfigured) || !this.wanted) throw err
      await this.recover('device answered ENOTCONFIGURED')
    }
  }

  /** Re-send the last config and restart RX if it was on. Concurrent callers share one attempt. */
  recover(reason: string): Promise<void> {
    if (this.recovering) return this.recovering
    this.health.lostSessions++
    this.emit('sessionLost', reason)
    const wanted = this.wanted
    if (!wanted) return Promise.resolve()
    this.recovering = (async () => {
      try {
        const reply = await this.sendConfig(wanted)
        if (this.rxWanted) await this.command(MsgType.RxStart)
        this.health.recoveries++
        this.emit('recovered', reply)
      } finally {
        this.recovering = null
      }
    })()
    return this.recovering
  }

  // ---- keepalive ---------------------------------------------------------------------------------

  private tick(): void {
    if (!this.open) return
    const idle = Date.now() - this.lastWriteAt
    if (idle >= GAP_SUSPECT_MS && this.wanted && !this.probing && !this.recovering) {
      // we were silent long enough for the device to have reset; PING can't tell (it works
      // unconfigured), but an RX command fails with ENOTCONFIGURED, and is a no-op otherwise (§6.5, §6.6)
      void this.probe(idle)
      return
    }
    // keep writing on schedule even if earlier keepalives haven't been answered: the device only needs frames
    // to arrive, and one lost reply must not hold the next keepalive for a whole command timeout
    if (idle >= this.keepaliveMs && this.keepalivesInFlight < MAX_KEEPALIVES_IN_FLIGHT && Date.now() - this.lastKeepaliveAt >= this.keepaliveMs) {
      void this.keepalive()
    }
    if (this.statusPollMs > 0 && this.radioStatusSupported && !this.statusPolling && Date.now() - this.lastStatusPollAt >= this.statusPollMs) {
      void this.pollStatus()
    }
  }

  private async pollStatus(): Promise<void> {
    this.statusPolling = true
    this.lastStatusPollAt = Date.now()
    try {
      await this.radioStatus()
    } catch {
      // a lost reply; the next poll tries again
    } finally {
      this.statusPolling = false
    }
  }

  private async probe(idleMs: number): Promise<void> {
    this.probing = true
    try {
      await this.command(this.rxWanted ? MsgType.RxStart : MsgType.RxStop, undefined, `session probe after ${Math.round(idleMs)} ms quiet`)
    } catch (err) {
      if (err instanceof DongLoRaError && err.code === ErrCode.NotConfigured) {
        await this.recover(`no frame sent for ${Math.round(idleMs)} ms; the device had reset its session`).catch(() => {})
      }
    } finally {
      this.probing = false
    }
  }

  private async keepalive(): Promise<void> {
    this.keepalivesInFlight++
    this.lastKeepaliveAt = Date.now()
    try {
      const t0 = performance.now()
      await this.command(MsgType.Ping)
      const rtt = performance.now() - t0
      this.health.pings++
      this.health.lastRttMs = rtt
      this.health.lastOkAt = Date.now()
      this.rttSum += rtt
      this.rttCount++
      this.health.avgRttMs = this.rttSum / this.rttCount
    } catch {
      if (this.open) this.health.failures++
    } finally {
      this.keepalivesInFlight--
      this.emit('keepalive', this.health)
    }
  }
}

export const hexFrame = (f: Frame): string => toHex(frameBody(f.type, f.tag, f.payload), ' ')
