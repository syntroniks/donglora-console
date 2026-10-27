// Messages between a script's sandbox (a Web Worker in the page, a worker thread in the console server) and
// the host that owns the radio session. Everything crosses by structured clone, so bytes stay Uint8Array.

export const SCRIPT_EVENTS = ['packet', 'node', 'message', 'link-error', 'log', 'connected', 'disconnected'] as const
export type ScriptEvent = (typeof SCRIPT_EVENTS)[number]

export const SCRIPT_METHODS = [
  'state',
  'info',
  'config',
  'setConfig',
  'rxStart',
  'rxStop',
  'ping',
  'status',
  'tx',
  'say',
  'packets',
  'nodes',
  'messages',
  'plugins',
  'storage.get',
  'storage.set',
] as const
export type ScriptMethod = (typeof SCRIPT_METHODS)[number]

export type HostToScript =
  | { t: 'start'; name: string; source: string }
  | { t: 'event'; event: ScriptEvent; data: unknown }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }

export type ScriptToHost =
  | { t: 'subscribe'; event: ScriptEvent }
  | { t: 'call'; id: number; method: ScriptMethod; args: unknown[] }
  | { t: 'print'; level: 'info' | 'warn' | 'err'; text: string }
  /** the script's top level finished; it keeps running while it has handlers or timers */
  | { t: 'ready' }
  | { t: 'failed'; error: string }
