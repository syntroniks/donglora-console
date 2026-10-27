// The console server end to end, against its simulated dongle (--demo): the API, the event stream, the
// request policy and the /ws relay driven by the console's own client code.

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket as WsClient } from 'ws'
import { DongLoRaClient } from '../src/protocol/client.ts'
import { ErrCode, SetConfigResult, TxResult } from '../src/protocol/codes.ts'
import { WebSocketTransport } from '../src/protocol/transports/websocket.ts'
import { DEFAULT_PRESET } from '../src/meshcore/presets.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

interface Running {
  child: ChildProcess
  base: string
  ws: string
}

function start(...args: string[]): Promise<Running> {
  const child = spawn(process.execPath, [MAIN, '--demo', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server didn't start:\n${out}`)), 5000)
    const onData = (chunk: Buffer) => {
      out += chunk.toString()
      const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (!m) return
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      resolve({ child, base: m[1], ws: `${m[1].replace('http', 'ws')}/ws` })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The HTTP status a WebSocket upgrade gets with this Origin header. */
function upgradeStatus(url: string, origin: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WsClient(url, { origin })
    ws.on('open', () => {
      ws.close()
      resolve(101)
    })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => {})
  })
}

describe('console server, TX refused (default)', () => {
  let s: Running
  beforeAll(async () => {
    s = await start()
  })
  afterAll(() => {
    s?.child.kill()
  })

  it('has its own session: connected, configured, receiving', async () => {
    const state = await until(async () => {
      const { body } = await getJson(`${s.base}/api/state`)
      return body.status === 'connected' && body.rxOn ? body : undefined
    })
    expect(state.preset).toBe(DEFAULT_PRESET.id)
    expect((state.info as { capabilities: string }).capabilities).toMatch(/^0x[0-9a-f]+$/)
    const { body } = await getJson(`${s.base}/api/server`)
    expect(body).toMatchObject({ allowTx: false, upstream: 'demo dongle (simulated)' })
  })

  it('validates config changes and applies presets', async () => {
    const put = (body: unknown) => getJson(`${s.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await put({ sf: 'seven' })).status).toBe(400)
    expect((await put({ preset: 'nope' })).status).toBe(400)
    const eu = await put({ preset: 'meshcore-eu' })
    expect(eu.status).toBe(200)
    expect(eu.body).toMatchObject({ rxOn: true, applied: { lora: { freqHz: 869_618_000 } } })
    expect((await put({ preset: DEFAULT_PRESET.id })).status).toBe(200)
  })

  it('refuses TX on the API', async () => {
    const { status } = await getJson(`${s.base}/api/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hex":"00"}' })
    expect(status).toBe(403)
  })

  it('refuses other origins and non-loopback Host names', async () => {
    expect((await fetch(`${s.base}/api/state`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect(await upgradeStatus(s.ws, 'https://evil.example')).toBe(403)
    expect(await upgradeStatus(s.ws, 'https://syntroniks.github.io')).toBe(101)
  })

  it('streams state and packets as server-sent events', async () => {
    const abort = new AbortController()
    const res = await fetch(`${s.base}/api/events`, { signal: abort.signal })
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    const reader = res.body!.getReader()
    let text = ''
    while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    expect(text).toMatch(/event: state\ndata: \{.*"status":"connected"/)
  })

  it('relays the console client over /ws, and answers TX with EUNKNOWN_CMD', async () => {
    const c = new DongLoRaClient(new WebSocketTransport(s.ws))
    await c.connect()
    try {
      const info = await c.getInfo()
      expect(info.firmware).toEqual({ major: 1, minor: 6, patch: 0 })
      expect((await c.setConfig(DEFAULT_PRESET.config)).result).toBe(SetConfigResult.Applied)
      await c.rxStart()
      expect(await c.radioStatus()).toBeDefined()
      await expect(c.transmit(Uint8Array.of(1, 2, 3))).rejects.toMatchObject({ code: ErrCode.UnknownCmd })
    } finally {
      await c.disconnect()
    }
  })
})

describe('console server with --allow-tx', () => {
  let s: Running
  beforeAll(async () => {
    s = await start('--allow-tx')
  })
  afterAll(() => {
    s?.child.kill()
  })

  it('transmits through /ws and the API', async () => {
    const c = new DongLoRaClient(new WebSocketTransport(s.ws))
    await c.connect()
    try {
      await c.getInfo()
      await c.setConfig(DEFAULT_PRESET.config)
      expect([TxResult.Transmitted, TxResult.ChannelBusy]).toContain((await c.transmit(Uint8Array.of(1, 2, 3))).result)
    } finally {
      await c.disconnect()
    }
    await until(async () => ((await getJson(`${s.base}/api/state`)).body.status === 'connected' ? true : undefined))
    const { status, body } = await getJson(`${s.base}/api/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hex":"0102"}' })
    expect(status).toBe(200)
    expect(typeof body.airtimeUs).toBe('number')
  })
})
