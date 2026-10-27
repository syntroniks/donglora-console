// The JSON API under /api and its server-sent event stream, /api/events. Everything is read from the
// server's own RadioStore session, which is one mux client among others: it reports what the radio hears
// whoever else is connected, and it can change the config only while it holds mux's config lock.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fromHex } from '../src/protocol/bytes.ts'
import { DongLoRaError, TimeoutError } from '../src/protocol/client.ts'
import type { LoRaConfig } from '../src/protocol/messages.ts'
import { matchPreset, presetById, PRESETS } from '../src/meshcore/presets.ts'
import { radioStatusAvailable, type RadioState, type RadioStore } from '../src/radio/store.ts'
import { toJson } from './json.ts'

export interface ServerFacts {
  name: string
  version: string
  upstream: string
  allowTx: boolean
  startedAt: number
  /** open /ws connections */
  relays: number
}

export interface ApiContext {
  store: RadioStore
  facts: () => ServerFacts
}

export const ENDPOINTS: { method: string; path: string; summary: string }[] = [
  { method: 'GET', path: '/api', summary: 'this list' },
  { method: 'GET', path: '/api/server', summary: 'server version, upstream (mux socket or demo), whether TX is allowed' },
  { method: 'GET', path: '/api/state', summary: 'connection, device info, config, RX on/off, stats, keepalive health, noise floor, counts' },
  { method: 'GET', path: '/api/info', summary: 'GET_INFO from the dongle' },
  { method: 'GET', path: '/api/config', summary: 'requested and applied config, and the matching preset' },
  { method: 'PUT', path: '/api/config', summary: 'apply {"preset": id} or LoRa fields merged over the requested config; RX restarts if it was on' },
  { method: 'GET', path: '/api/presets', summary: 'MeshCore presets' },
  { method: 'POST', path: '/api/rx/start', summary: 'start continuous RX' },
  { method: 'POST', path: '/api/rx/stop', summary: 'stop RX for this session (mux keeps RX on while any client wants it)' },
  { method: 'GET', path: '/api/packets', summary: 'received packets with their MeshCore decode, newest first; ?limit=50&after=<id>' },
  { method: 'GET', path: '/api/nodes', summary: 'nodes heard from signed adverts, most recent first' },
  { method: 'GET', path: '/api/channel', summary: 'Public channel messages, newest first; ?limit=100' },
  { method: 'GET', path: '/api/radio', summary: 'last RADIO_STATUS (firmware 1.6.0), noise floor, keepalive health' },
  { method: 'GET', path: '/api/link-errors', summary: 'frames that failed to decode or fit, newest first; ?limit=100' },
  { method: 'GET', path: '/api/log', summary: 'session log, newest first' },
  { method: 'POST', path: '/api/tx', summary: 'transmit {"hex": "..."}; only when the server runs with --allow-tx' },
  { method: 'GET', path: '/api/events', summary: 'server-sent events: state (at most 1/s), packet, link-error, log, tx-done' },
]

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const LORA_KEYS: Record<keyof LoRaConfig, 'number' | 'boolean'> = {
  freqHz: 'number',
  sf: 'number',
  bw: 'number',
  cr: 'number',
  preambleLen: 'number',
  syncWord: 'number',
  txPowerDbm: 'number',
  implicitHeader: 'boolean',
  payloadCrc: 'boolean',
  iqInvert: 'boolean',
}

const BODY_MAX = 16 * 1024
const STATE_EVENT_MS = 1000
const SSE_HEARTBEAT_MS = 15_000

export function summary(s: RadioState): unknown {
  const config = s.applied?.lora ?? s.requested
  return {
    status: s.status,
    label: s.label,
    error: s.error,
    connectedAt: s.connectedAt,
    info: s.info,
    requested: s.requested,
    applied: s.applied,
    preset: matchPreset(config)?.id ?? null,
    rxOn: s.rxOn,
    txArmed: s.txArmed,
    stats: s.stats,
    health: s.health,
    noise: s.noise,
    radioStatus: s.radioStatus,
    radioStatusAt: s.radioStatusAt,
    counts: { packets: s.packets.length, nodes: Object.keys(s.nodes).length, posts: s.posts.length, linkErrors: s.linkErrors.length },
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<void> {
  const { store } = ctx
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    switch (`${req.method} ${path}`) {
      case 'GET /api':
        return send(res, 200, { endpoints: ENDPOINTS })
      case 'GET /api/server':
        return send(res, 200, ctx.facts())
      case 'GET /api/state':
        return send(res, 200, summary(store.getState()))
      case 'GET /api/info': {
        const info = store.getState().info
        if (!info) throw new HttpError(503, 'no GET_INFO yet: the server has no dongle session')
        return send(res, 200, info)
      }
      case 'GET /api/config': {
        const s = store.getState()
        return send(res, 200, { requested: s.requested, applied: s.applied, preset: matchPreset(s.applied?.lora ?? s.requested)?.id ?? null })
      }
      case 'PUT /api/config': {
        const config = configFrom(await readJson(req), store.getState().requested)
        const reply = await store.applyConfig(config)
        return send(res, 200, { applied: reply, rxOn: store.getState().rxOn })
      }
      case 'GET /api/presets':
        return send(res, 200, PRESETS)
      case 'POST /api/rx/start':
        await store.startRx()
        return send(res, 200, { rxOn: true })
      case 'POST /api/rx/stop':
        await store.stopRx()
        return send(res, 200, { rxOn: false })
      case 'GET /api/packets': {
        const after = intParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = intParam(url, 'limit', 50, 1, 2000)
        return send(res, 200, store.getState().packets.filter((p) => p.id > after).slice(0, limit))
      }
      case 'GET /api/nodes':
        return send(res, 200, Object.values(store.getState().nodes).sort((a, b) => b.lastHeard - a.lastHeard))
      case 'GET /api/channel':
        return send(res, 200, store.getState().posts.slice().reverse().slice(0, intParam(url, 'limit', 100, 1, 500)))
      case 'GET /api/radio': {
        const s = store.getState()
        return send(res, 200, {
          available: radioStatusAvailable(s),
          radioStatus: s.radioStatus,
          radioStatusAt: s.radioStatusAt,
          countersBase: s.countersBase,
          noise: s.noise,
          health: s.health,
        })
      }
      case 'GET /api/link-errors':
        return send(res, 200, store.getState().linkErrors.slice(0, intParam(url, 'limit', 100, 1, 500)))
      case 'GET /api/log':
        return send(res, 200, store.getState().log)
      case 'POST /api/tx': {
        if (!ctx.facts().allowTx) throw new HttpError(403, 'TX is off: start the server with --allow-tx')
        const body = await readJson(req)
        const hex = typeof body.hex === 'string' ? body.hex.replace(/\s+/g, '') : ''
        if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new HttpError(400, 'body needs "hex": an even number of hex digits')
        if (!store.getState().txArmed) store.armTx(true)
        const done = await store.transmit(fromHex(hex))
        return send(res, 200, done)
      }
      case 'GET /api/events':
        return events(req, res, store)
      default:
        if (ENDPOINTS.some((e) => e.path === path)) throw new HttpError(405, `${req.method} isn't supported on ${path}`)
        throw new HttpError(404, `no endpoint ${path}; GET /api lists them`)
    }
  } catch (err) {
    const [status, message] = errorStatus(err)
    if (!res.headersSent) send(res, status, { error: message })
    else res.end()
  }
}

function errorStatus(err: unknown): [number, string] {
  if (err instanceof HttpError) return [err.status, err.message]
  if (err instanceof DongLoRaError) return [502, err.message] // the dongle (or mux) refused it
  if (err instanceof TimeoutError) return [504, err.message]
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'not connected') return [503, 'the server has no dongle session right now (GET /api/state says why)']
  return [500, message]
}

/** `{"preset": "meshcore-us"}`, or LoRa fields (bw and cr as wire enums) laid over the requested config. */
function configFrom(body: Record<string, unknown>, requested: LoRaConfig): LoRaConfig {
  if ('preset' in body) {
    const preset = typeof body.preset === 'string' ? presetById(body.preset) : undefined
    if (!preset) throw new HttpError(400, `unknown preset; one of ${PRESETS.map((p) => p.id).join(', ')}`)
    return preset.config
  }
  const config: LoRaConfig = { ...requested }
  for (const [k, v] of Object.entries(body)) {
    const kind = LORA_KEYS[k as keyof LoRaConfig]
    if (!kind) throw new HttpError(400, `unknown field "${k}"; LoRa fields are ${Object.keys(LORA_KEYS).join(', ')}`)
    if (typeof v !== kind) throw new HttpError(400, `"${k}" must be a ${kind}`)
    ;(config as unknown as Record<string, unknown>)[k] = v
  }
  return config
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `?${name} must be a whole number ${min}..${max}`)
  return n
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'send the body as application/json')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_MAX) throw new HttpError(413, `body is over ${BODY_MAX} bytes`)
    chunks.push(chunk)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object')
  return body as Record<string, unknown>
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = toJson(body, true)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text + '\n')
}

/** Server-sent events. `state` goes out on connect and then at most once a second while anything changes. */
function events(req: IncomingMessage, res: ServerResponse, store: RadioStore): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${toJson(data)}\n\n`)
  res.write('retry: 3000\n\n')
  emit('state', summary(store.getState()))

  let stateTimer: ReturnType<typeof setTimeout> | null = null
  let lastState = Date.now()
  const onChange = () => {
    if (stateTimer) return
    const wait = Math.max(0, STATE_EVENT_MS - (Date.now() - lastState))
    stateTimer = setTimeout(() => {
      stateTimer = null
      lastState = Date.now()
      emit('state', summary(store.getState()))
    }, wait)
  }
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), SSE_HEARTBEAT_MS)
  const off = [
    store.subscribe(onChange),
    store.on('packet', (p) => emit('packet', p)),
    store.on('linkError', (e) => emit('link-error', e)),
    store.on('log', (e) => emit('log', e)),
    store.on('txDone', (tag, done) => emit('tx-done', { tag, ...done })),
  ]
  req.on('close', () => {
    off.forEach((f) => f())
    clearInterval(heartbeat)
    if (stateTimer) clearTimeout(stateTimer)
  })
}
