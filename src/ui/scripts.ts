// Scripts in the page: the library (kept in localStorage), which ones are running, and each one's output.
// Each runs in its own Web Worker (src/scripts/worker.ts) against the page's radio store. Like the radio
// store, one instance lives on globalThis so a hot update keeps the running workers.

import { EXAMPLES, type ScriptExample } from '../scripts/examples.ts'
import { ScriptHost, type HostChannel, type ScriptLine, type ScriptSpec } from '../scripts/host.ts'
import type { HostToScript, ScriptToHost } from '../scripts/messages.ts'
import { store } from './store.ts'

export interface SavedScript extends ScriptSpec {
  /** start whenever the console connects to a dongle */
  runOnConnect: boolean
}

export interface ScriptsState {
  scripts: SavedScript[]
  running: string[]
  output: Record<string, ScriptLine[]>
}

const LIBRARY_KEY = 'donglora-console.scripts'
const DATA_KEY = (id: string) => `donglora-console.script-data.${id}`
const OUTPUT_MAX = 300

function loadLibrary(): SavedScript[] {
  try {
    const v = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]') as SavedScript[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function readData(id: string): Record<string, unknown> {
  try {
    return (JSON.parse(localStorage.getItem(DATA_KEY(id)) ?? '{}') as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function spawnWorker(): HostChannel {
  const w = new Worker(new URL('../scripts/worker.ts', import.meta.url), { type: 'module' })
  return {
    post: (m: HostToScript) => w.postMessage(m),
    onMessage: (fn) => w.addEventListener('message', (e: MessageEvent<ScriptToHost>) => fn(e.data)),
    onError: (fn) =>
      w.addEventListener('error', (e) => {
        e.preventDefault()
        fn(e.message || 'the worker failed to load')
      }),
    terminate: () => w.terminate(),
  }
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export class ScriptsStore {
  private state: ScriptsState
  private readonly subscribers = new Set<() => void>()
  private readonly lineListeners = new Set<(s: ScriptSpec, line: ScriptLine) => void>()
  private readonly host: ScriptHost

  constructor() {
    this.state = { scripts: loadLibrary(), running: [], output: {} }
    this.host = new ScriptHost(store, {
      spawn: spawnWorker,
      txRefusal: (spec) => {
        if (!spec.allowTx) return 'this script may not transmit: tick "may transmit" and run it again'
        if (!store.getState().txArmed) return 'TX is not armed (Radio tab)'
        return undefined
      },
      output: (spec, line) => {
        this.patch((s) => ({ output: { ...s.output, [spec.id]: [...(s.output[spec.id] ?? []), line].slice(-OUTPUT_MAX) } }))
        for (const fn of this.lineListeners) fn(spec, line)
      },
      storage: {
        get: (id, key) => readData(id)[key],
        set: (id, key, value) => {
          const data = readData(id)
          if (value === undefined) delete data[key]
          else data[key] = value
          localStorage.setItem(DATA_KEY(id), JSON.stringify(data))
        },
      },
      exited: () => this.patch({ running: this.host.runningIds() }),
    })
    let was = store.getState().status
    store.subscribe(() => {
      const now = store.getState().status
      if (now === 'connected' && was !== 'connected') {
        for (const s of this.state.scripts) if (s.runOnConnect && !this.host.isRunning(s.id)) this.run(s.id)
      }
      was = now
    })
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  getState = (): ScriptsState => this.state

  /** every output line of every script, for the shell */
  onLine(fn: (s: ScriptSpec, line: ScriptLine) => void): () => void {
    this.lineListeners.add(fn)
    return () => this.lineListeners.delete(fn)
  }

  private patch(p: Partial<ScriptsState> | ((s: ScriptsState) => Partial<ScriptsState>)): void {
    this.state = { ...this.state, ...(typeof p === 'function' ? p(this.state) : p) }
    for (const fn of this.subscribers) fn()
  }

  private persist(scripts: SavedScript[]): void {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(scripts))
    this.patch({ scripts })
  }

  byName(name: string): SavedScript | undefined {
    const n = name.toLowerCase()
    return this.state.scripts.find((s) => s.id === name || s.name.toLowerCase() === n)
  }

  create(from?: ScriptExample): SavedScript {
    const base = from?.name ?? 'New script'
    let name = base
    for (let i = 2; this.byName(name); i++) name = `${base} ${i}`
    const script: SavedScript = { id: newId(), name, source: from?.source ?? EXAMPLES[0].source, allowTx: false, runOnConnect: false }
    this.persist([...this.state.scripts, script])
    return script
  }

  save(script: SavedScript): void {
    this.persist(this.state.scripts.map((s) => (s.id === script.id ? script : s)))
  }

  remove(id: string): void {
    this.host.stop(id)
    localStorage.removeItem(DATA_KEY(id))
    this.persist(this.state.scripts.filter((s) => s.id !== id))
    this.patch((s) => {
      const output = { ...s.output }
      delete output[id]
      return { output }
    })
  }

  run(id: string): void {
    const s = this.state.scripts.find((x) => x.id === id)
    if (!s) throw new Error('no such script')
    this.host.start(s)
    this.patch({ running: this.host.runningIds() })
  }

  stop(id: string): void {
    this.host.stop(id)
  }

  isRunning(id: string): boolean {
    return this.host.isRunning(id)
  }

  clearOutput(id: string): void {
    this.patch((s) => ({ output: { ...s.output, [id]: [] } }))
  }
}

const g = globalThis as typeof globalThis & { __dongloraScripts?: ScriptsStore }

function singleton(): ScriptsStore {
  const prev = g.__dongloraScripts
  if (!prev) return (g.__dongloraScripts = new ScriptsStore())
  Object.setPrototypeOf(prev, ScriptsStore.prototype)
  return prev
}

export const scripts = singleton()
