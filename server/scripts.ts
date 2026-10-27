// Scripts given to the console server with --script: each runs in a worker thread against the server's own
// session, starting once that session first connects. Output goes to the server log and GET /api/scripts.
// Storage lives in memory for the life of the process.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { RadioStore } from '../src/radio/store.ts'
import { ScriptHost, type HostChannel, type ScriptLine, type ScriptSpec } from '../src/scripts/host.ts'
import type { ScriptToHost } from '../src/scripts/messages.ts'

const OUTPUT_MAX = 200
const WORKER = new URL('./script-worker.ts', import.meta.url)

export interface ServerScript {
  name: string
  file: string
  running: boolean
  output: ScriptLine[]
}

/** A script worker thread, as a host channel. */
export function spawnScriptWorker(): HostChannel {
  const w = new Worker(WORKER)
  return {
    post: (m) => w.postMessage(m),
    onMessage: (fn) => w.on('message', (m: ScriptToHost) => fn(m)),
    onError: (fn) => w.on('error', (err: Error) => fn(err.message)),
    terminate: () => void w.terminate(),
  }
}

export function startServerScripts(store: RadioStore, files: string[], allowTx: boolean, log: (text: string) => void): () => ServerScript[] {
  const data = new Map<string, Map<string, unknown>>()
  const output = new Map<string, ScriptLine[]>()
  const specs: (ScriptSpec & { file: string })[] = files.map((file, i) => ({ id: `script${i + 1}`, name: basename(file).replace(/\.[cm]?[jt]s$/, ''), file, source: readFileSync(file, 'utf8'), allowTx }))
  const host = new ScriptHost(store, {
    spawn: spawnScriptWorker,
    txRefusal: (spec) => (spec.allowTx ? undefined : 'the server was started without --allow-tx'),
    armForTx: true,
    output: (spec, line) => {
      output.set(spec.id, [...(output.get(spec.id) ?? []), line].slice(-OUTPUT_MAX))
      log(`[${spec.name}] ${line.level === 'info' ? '' : `${line.level}: `}${line.text}`)
    },
    storage: {
      get: (id, key) => data.get(id)?.get(key),
      set: (id, key, value) => {
        if (!data.has(id)) data.set(id, new Map())
        data.get(id)!.set(key, value)
      },
    },
  })

  let started = false
  const startOnce = () => {
    if (started || store.getState().status !== 'connected') return
    started = true
    for (const spec of specs) host.start(spec)
  }
  store.subscribe(startOnce)
  startOnce()
  process.on('exit', () => host.stopAll())

  return () => specs.map((s) => ({ name: s.name, file: s.file, running: host.isRunning(s.id), output: output.get(s.id) ?? [] }))
}
