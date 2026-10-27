// The console server: shares one DongLoRa dongle, through donglora-mux, with the console page, scripts and
// anything else that speaks HTTP. `pnpm server --help` for options; README "Console server" for the API.
//
//   /api/...  JSON API and a server-sent event stream, from the server's own session (server/api.ts)
//   /ws       the DongLoRa byte stream, one mux session per WebSocket (server/relay.ts)
//   /         the built console (dist/), once `pnpm build` has run
//
// It listens on 127.0.0.1 and refuses requests whose Host isn't loopback (DNS rebinding) or whose Origin
// isn't this server, the hosted console or an --allow-origin, so a web page you happen to visit can't
// drive the radio. Requests with no Origin (curl, scripts) are allowed. TX is refused unless --allow-tx.

import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'
import { DEFAULT_PRESET, presetById, PRESETS } from '../src/meshcore/presets.ts'
import { describeConfig } from '../src/protocol/lora.ts'
import { RadioStore } from '../src/radio/store.ts'
import { handleApi, type ServerFacts } from './api.ts'
import { relay } from './relay.ts'
import { defaultMuxSocket, demoUpstream, muxUpstream, parseMuxTarget, type Upstream } from './upstream.ts'

const HELP = `usage: pnpm server [options]

Shares a DongLoRa dongle through donglora-mux: a JSON API under /api, the DongLoRa
byte stream on /ws for the console's "Connect server", and the built console on /.

  --mux <path|host:port>  mux socket (default ${defaultMuxSocket()})
  --demo                  a simulated dongle instead of mux, for trying it out
  --port <n>              listen port (default 5742; 0 picks a free one)
  --host <addr>           listen address (default 127.0.0.1); anything else exposes
                          the radio to the network, so put TLS and auth in front
  --allow-origin <url>    another web origin allowed to use the API (repeatable);
                          https://syntroniks.github.io and this server are allowed
  --allow-tx              let /api/tx and /ws clients transmit (refused otherwise)
  --preset <id>           config the server's session asks for (default ${DEFAULT_PRESET.id}):
                          ${PRESETS.map((p) => p.id).join(', ')}
  -h, --help              this text
`

const DEFAULT_ORIGINS = ['https://syntroniks.github.io']
const MAX_RELAYS = 16
const RETRY_MS = 3000
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`)

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`)
  process.exit(2)
}

function options() {
  let parsed
  try {
    parsed = parseArgs({
      options: {
        mux: { type: 'string' },
        demo: { type: 'boolean', default: false },
        port: { type: 'string', default: '5742' },
        host: { type: 'string', default: '127.0.0.1' },
        'allow-origin': { type: 'string', multiple: true, default: [] },
        'allow-tx': { type: 'boolean', default: false },
        preset: { type: 'string', default: DEFAULT_PRESET.id },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  if (parsed.help) {
    console.log(HELP)
    process.exit(0)
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port ${parsed.port} isn't a port number`)
  const preset = presetById(parsed.preset)
  if (!preset) fail(`unknown --preset ${parsed.preset}`)
  if (parsed.demo && parsed.mux) fail('--demo and --mux are exclusive')
  for (const o of parsed['allow-origin']) if (!/^https?:\/\/[^/]+$/.test(o)) fail(`--allow-origin ${o} isn't an origin like https://example.com`)
  const upstream: Upstream = parsed.demo ? demoUpstream() : muxUpstream(parseMuxTarget(parsed.mux ?? defaultMuxSocket()))
  return {
    port,
    host: parsed.host,
    upstream,
    allowTx: parsed['allow-tx'],
    origins: new Set([...DEFAULT_ORIGINS, ...parsed['allow-origin']]),
    preset,
  }
}

const opts = options()
const exposed = !LOOPBACK.has(opts.host)

// ---- request policy ---------------------------------------------------------------------------------

/** Bound to loopback, only loopback Host names are real: anything else is a DNS-rebinding page. */
function hostAllowed(req: IncomingMessage): boolean {
  if (exposed) return true
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return LOOPBACK.has(host)
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (opts.origins.has(origin)) return true
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
}

function corsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (!origin) return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'Origin')
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-max-age', '600')
    // Chrome's Private Network Access preflight, for the hosted console reaching localhost
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('access-control-allow-private-network', 'true')
  }
}

function refuse(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error }) + '\n')
}

// ---- the server's own session -----------------------------------------------------------------------

const store = new RadioStore()
store.setRequested(opts.preset.config)
store.on('log', (e) => log(`radio: ${e.text}`))

let relays = 0
const startedAt = Date.now()
const facts = (): ServerFacts => ({ name: 'donglora-console server', version: VERSION, upstream: opts.upstream.label, allowTx: opts.allowTx, startedAt, relays })

let stopping = false
async function keepConnected(): Promise<void> {
  let lastError = ''
  while (!stopping) {
    if (store.getState().status === 'disconnected') {
      await store.connectTransport(opts.upstream.connect(), opts.upstream.demo)
      const s = store.getState()
      if (s.status === 'connected') lastError = ''
      else if (s.error && s.error !== lastError) {
        lastError = s.error
        log(`${s.error}; retrying every ${RETRY_MS / 1000} s`)
      }
    }
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
}

// ---- static console ---------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

async function serveStatic(url: URL, res: ServerResponse, head: boolean): Promise<void> {
  let rel: string
  try {
    rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  } catch {
    return refuse(res, 400, 'bad path')
  }
  let file = join(DIST, rel)
  if (!file.startsWith(DIST) || rel.split(sep).includes('..')) return refuse(res, 400, 'bad path')
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html') // a client-side route
  }
  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return void res.end(`The console isn't built: run \`pnpm build\` (or use \`pnpm dev\`, which proxies /api and /ws here).\nThe API is at /api.\n`)
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  res.end(head ? undefined : body)
}

// ---- HTTP and WebSocket -----------------------------------------------------------------------------

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!hostAllowed(req)) return refuse(res, 403, `Host ${req.headers.host} isn't a loopback name`)
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (!originAllowed(req)) return refuse(res, 403, `origin ${req.headers.origin} isn't allowed (--allow-origin)`)
    corsHeaders(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return void res.end()
    }
    return void handleApi(req, res, url, { store, facts })
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'the console is read-only; the API is under /api')
  void serveStatic(url, res, req.method === 'HEAD')
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
let nextRelay = 1

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
}

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found')
  if (!hostAllowed(req) || !originAllowed(req)) {
    log(`refused /ws from origin ${req.headers.origin ?? '(none)'}, host ${req.headers.host}`)
    return rejectUpgrade(socket, 403, 'Forbidden')
  }
  if (relays >= MAX_RELAYS) return rejectUpgrade(socket, 503, 'Service Unavailable')
  wss.handleUpgrade(req, socket, head, (ws) => {
    const who = `ws#${nextRelay++} (${req.headers.origin ?? req.socket.remoteAddress})`
    relays++
    log(`${who} connected`)
    ws.on('close', (code, reason) => {
      relays--
      log(`${who} closed${reason.length ? `: ${reason.toString()}` : ` (${code})`}`)
    })
    void relay(ws, opts.upstream.connect(), who, { allowTx: opts.allowTx, log })
  })
})

http.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `error: ${opts.host}:${opts.port} is in use (another console server?)` : `error: ${err.message}`)
  process.exit(1)
})

http.listen(opts.port, opts.host, () => {
  const address = http.address()
  const port = address && typeof address === 'object' ? address.port : opts.port
  const where = `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}`
  log(`donglora-console server ${VERSION} on ${where}  (API ${where}/api, console ${where}/, /ws for "Connect server")`)
  log(`upstream: ${opts.upstream.label}; session config: ${opts.preset.name}, ${describeConfig(opts.preset.config)}`)
  log(`TX ${opts.allowTx ? 'ALLOWED (--allow-tx)' : 'refused'}; origins: this server, ${[...opts.origins].join(', ')}`)
  if (exposed) log(`warning: listening on ${opts.host}, not loopback: anyone who reaches it can use the radio`)
  void keepConnected()
})

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  log('shutting down')
  for (const ws of wss.clients) ws.close(1001, 'server shutting down')
  await store.disconnect().catch(() => {})
  http.close()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
