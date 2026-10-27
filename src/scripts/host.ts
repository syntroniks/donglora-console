// The host side of scripts: starts each one in its own worker, answers its radio calls from the RadioStore,
// forwards only the events it subscribed to, and decides whether it may transmit. The page (src/ui/scripts.ts)
// and the console server (server/scripts.ts) supply the worker, the storage and the TX rule.

import { fromHex } from '../protocol/bytes.ts'
import { PLUGINS } from '../plugins/index.ts'
import type { RadioStore } from '../radio/store.ts'
import { configFromInput, summarize } from '../radio/summary.ts'
import type { HostToScript, ScriptEvent, ScriptMethod, ScriptToHost } from './messages.ts'

export interface ScriptSpec {
  id: string
  name: string
  source: string
  /** started with permission to transmit; the host's TX rule still applies */
  allowTx: boolean
}

export interface HostChannel {
  post(m: HostToScript): void
  onMessage(fn: (m: ScriptToHost) => void): void
  onError(fn: (message: string) => void): void
  terminate(): void
}

export interface ScriptLine {
  at: number
  level: 'info' | 'warn' | 'err'
  text: string
}

export interface ScriptHostOptions {
  spawn: () => HostChannel
  /** why this script may not transmit right now; undefined when it may */
  txRefusal(spec: ScriptSpec): string | undefined
  /** arm TX for a permitted script (the server, started with --allow-tx); the page leaves arming to the user */
  armForTx?: boolean
  output(spec: ScriptSpec, line: ScriptLine): void
  /** the sender name radio.say() uses when the script doesn't give one */
  defaultSender?(): string
  storage: {
    get(scriptId: string, key: string): unknown
    set(scriptId: string, key: string, value: unknown): void
  }
  /** a script ended: stopped, failed, or its worker died */
  exited?(spec: ScriptSpec, reason: string): void
}

interface Running {
  spec: ScriptSpec
  ch: HostChannel
  offs: (() => unknown)[]
  subscribed: Set<ScriptEvent>
}

const count = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback)

export class ScriptHost {
  private readonly store: RadioStore
  private readonly opts: ScriptHostOptions
  private readonly running = new Map<string, Running>()

  constructor(store: RadioStore, opts: ScriptHostOptions) {
    this.store = store
    this.opts = opts
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  /** Start a script, restarting it if it's already running. */
  start(spec: ScriptSpec): void {
    const old = this.running.get(spec.id)
    if (old) this.end(old, 'restarting', 'info')
    const ch = this.opts.spawn()
    const r: Running = { spec, ch, offs: [], subscribed: new Set() }
    this.running.set(spec.id, r)
    ch.onMessage((m) => void this.onMessage(r, m))
    ch.onError((message) => this.end(r, `worker error: ${message}`, 'err'))
    this.line(spec, 'info', `started${spec.allowTx ? ' (may transmit)' : ''}`)
    ch.post({ t: 'start', name: spec.name, source: spec.source })
  }

  stop(id: string): void {
    const r = this.running.get(id)
    if (r) this.end(r, 'stopped', 'info')
  }

  stopAll(): void {
    // end() deletes the entry being visited, which Map iteration allows
    for (const r of this.running.values()) this.end(r, 'stopped', 'info')
  }

  private live(r: Running): boolean {
    return this.running.get(r.spec.id) === r
  }

  private end(r: Running, reason: string, level: ScriptLine['level']): void {
    if (!this.live(r)) return
    this.running.delete(r.spec.id)
    r.offs.forEach((off) => off())
    r.ch.terminate()
    this.line(r.spec, level, reason)
    this.opts.exited?.(r.spec, reason)
  }

  private line(spec: ScriptSpec, level: ScriptLine['level'], text: string): void {
    this.opts.output(spec, { at: Date.now(), level, text })
  }

  private async onMessage(r: Running, m: ScriptToHost): Promise<void> {
    if (!this.live(r)) return
    switch (m.t) {
      case 'print':
        return this.line(r.spec, m.level, m.text)
      case 'ready':
        return
      case 'failed':
        return this.end(r, `failed: ${m.error}`, 'err')
      case 'subscribe':
        return this.subscribe(r, m.event)
      case 'call': {
        let reply: HostToScript
        try {
          reply = { t: 'reply', id: m.id, ok: true, value: await this.call(r, m.method, m.args) }
        } catch (err) {
          reply = { t: 'reply', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (this.live(r)) r.ch.post(reply)
      }
    }
  }

  private subscribe(r: Running, event: ScriptEvent): void {
    if (r.subscribed.has(event)) return
    r.subscribed.add(event)
    const send = (data: unknown) => this.live(r) && r.ch.post({ t: 'event', event, data })
    const s = this.store
    switch (event) {
      case 'packet':
        return void r.offs.push(s.on('packet', send))
      case 'node':
        return void r.offs.push(s.on('node', (n, isNew) => send({ ...n, isNew })))
      case 'message':
        return void r.offs.push(s.on('message', send))
      case 'link-error':
        return void r.offs.push(s.on('linkError', send))
      case 'log':
        return void r.offs.push(s.on('log', send))
      case 'connected':
      case 'disconnected': {
        let was = s.getState().status
        r.offs.push(
          s.subscribe(() => {
            const st = s.getState()
            if (st.status === was) return
            const before = was
            was = st.status
            if (event === 'connected' && st.status === 'connected') send(summarize(st))
            if (event === 'disconnected' && st.status === 'disconnected' && before !== 'disconnected') send({ error: st.error })
          }),
        )
      }
    }
  }

  private async call(r: Running, method: ScriptMethod, args: unknown[]): Promise<unknown> {
    const s = this.store
    const st = s.getState()
    switch (method) {
      case 'state':
        return summarize(st)
      case 'info':
        return st.info
      case 'config':
        return { requested: st.requested, applied: st.applied }
      case 'setConfig':
        return s.applyConfig(configFromInput(args[0], st.requested))
      case 'rxStart':
        return s.startRx()
      case 'rxStop':
        return s.stopRx()
      case 'ping':
        return s.ping()
      case 'status':
        // undefined on firmware without RADIO_STATUS
        return s.radio?.radioStatus()
      case 'tx': {
        const why = this.opts.txRefusal(r.spec)
        if (why) throw new Error(`tx(): ${why}`)
        const hex = String(args[0] ?? '').replace(/\s+/g, '')
        if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('tx(): give bytes or an even number of hex digits')
        if (this.opts.armForTx && !st.txArmed) s.armTx(true)
        this.line(r.spec, 'warn', `TX ${hex.length / 2} B`)
        return s.transmit(fromHex(hex))
      }
      case 'say': {
        const why = this.opts.txRefusal(r.spec)
        if (why) throw new Error(`say(): ${why}`)
        const opts = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as { channel?: unknown; sender?: unknown; protocol?: unknown }
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
        const sender = str(opts.sender) ?? this.opts.defaultSender?.() ?? ''
        if (this.opts.armForTx && !st.txArmed) s.armTx(true)
        this.line(r.spec, 'warn', `say: ${String(args[0] ?? '')}`)
        return s.sendMessage({ text: String(args[0] ?? ''), sender, channel: str(opts.channel), protocol: str(opts.protocol) })
      }
      case 'packets':
        return st.packets.slice(0, count(args[0], 1, 2000, 20))
      case 'nodes':
        return Object.values(st.nodes).sort((a, b) => b.lastHeard - a.lastHeard)
      case 'messages':
        return st.messages.slice(-count(args[0], 1, 500, 50)).reverse()
      case 'plugins': {
        const config = st.applied?.lora ?? st.requested
        return PLUGINS.map((p) => ({ id: p.id, name: p.name, description: p.description, decoding: p.claims(config), presets: p.presets }))
      }
      case 'storage.get':
        return this.opts.storage.get(r.spec.id, String(args[0]))
      case 'storage.set':
        return this.opts.storage.set(r.spec.id, String(args[0]), args[1])
      default:
        throw new Error(`no method ${String(method)}`)
    }
  }
}
