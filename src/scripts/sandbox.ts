// The script side of the runtime, run inside a worker. The script's source becomes the body of an async
// function whose parameters are the whole API, so it sees nothing of the page or the radio session except
// what it asks the host for over messages:
//
//   radio.state() info() config() setConfig(presetIdOrFields) rxStart() rxStop() ping() status()
//         tx(hexOrBytes) packets(limit) nodes() messages(limit) plugins()
//   on(event, handler) -> off     'packet' 'node' 'message' 'link-error' 'log' 'connected' 'disconnected'
//   every(ms, fn) -> cancel       sleep(ms)       print(...values)       warn(...values)
//   storage.get(key) storage.set(key, value)   kept per script by the host
//
// A handler or timer that throws prints the error and the script keeps running; the top level throwing
// ends it.

import { SCRIPT_EVENTS, type HostToScript, type ScriptEvent, type ScriptMethod, type ScriptToHost } from './messages.ts'

export interface SandboxChannel {
  post(m: ScriptToHost): void
  onMessage(fn: (m: HostToScript) => void): void
}

type AsyncFn = (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => AsyncFn

const MIN_INTERVAL_MS = 100
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** print() formatting: strings as they are, everything else as JSON with bytes in hex and bigints in 0x. */
export function show(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.message
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `0x${x.toString(16)}` : x instanceof Uint8Array ? hex(x) : x)) ?? String(v)
  } catch {
    return String(v)
  }
}

const errorText = (err: unknown) => (err instanceof Error ? (err.stack?.split('\n').slice(0, 3).join('\n') ?? err.message) : String(err))

export function runSandbox(ch: SandboxChannel): void {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const handlers = new Map<ScriptEvent, Set<(data: unknown) => unknown>>()

  const out = (level: 'info' | 'warn' | 'err', values: unknown[]) => ch.post({ t: 'print', level, text: values.map(show).join(' ') })
  const guard = async (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
    try {
      await fn(...args)
    } catch (err) {
      out('err', [errorText(err)])
    }
  }
  const call = (method: ScriptMethod, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ch.post({ t: 'call', id, method, args })
    })

  const radio = {
    state: () => call('state'),
    info: () => call('info'),
    config: () => call('config'),
    setConfig: (c: unknown) => call('setConfig', c),
    rxStart: () => call('rxStart'),
    rxStop: () => call('rxStop'),
    ping: () => call('ping'),
    status: () => call('status'),
    tx: (data: string | Uint8Array) => call('tx', typeof data === 'string' ? data : hex(data)),
    packets: (limit = 20) => call('packets', limit),
    nodes: () => call('nodes'),
    messages: (limit = 50) => call('messages', limit),
    plugins: () => call('plugins'),
  }
  const on = (event: ScriptEvent, fn: (data: unknown) => unknown) => {
    if (!SCRIPT_EVENTS.includes(event)) throw new Error(`on(): no event '${event}'; events are ${SCRIPT_EVENTS.join(', ')}`)
    if (typeof fn !== 'function') throw new Error('on(): the handler must be a function')
    let set = handlers.get(event)
    if (!set) {
      set = new Set()
      handlers.set(event, set)
      ch.post({ t: 'subscribe', event })
    }
    set.add(fn)
    return () => void set.delete(fn)
  }
  const every = (ms: number, fn: () => unknown) => {
    if (!(ms >= MIN_INTERVAL_MS)) throw new Error(`every(): the interval must be at least ${MIN_INTERVAL_MS} ms`)
    const t = setInterval(() => void guard(fn), ms)
    return () => clearInterval(t)
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const print = (...v: unknown[]) => out('info', v)
  const warn = (...v: unknown[]) => out('warn', v)
  const storage = { get: (key: string) => call('storage.get', key), set: (key: string, value: unknown) => call('storage.set', key, value) }

  ch.onMessage((m) => {
    switch (m.t) {
      case 'start': {
        let body: AsyncFn
        try {
          body = new AsyncFunction('radio', 'on', 'every', 'sleep', 'print', 'warn', 'storage', `"use strict";\n${m.source}\n//# sourceURL=${m.name.replace(/[^\w.-]/g, '_')}.js`)
        } catch (err) {
          ch.post({ t: 'failed', error: `syntax: ${errorText(err)}` })
          return
        }
        body(radio, on, every, sleep, print, warn, storage).then(
          () => ch.post({ t: 'ready' }),
          (err: unknown) => ch.post({ t: 'failed', error: errorText(err) }),
        )
        return
      }
      case 'event':
        for (const fn of handlers.get(m.event) ?? []) void guard(fn, m.data)
        return
      case 'reply': {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(m.error))
      }
    }
  })
}
