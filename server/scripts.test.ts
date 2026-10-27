// Scripts end to end: the real sandbox in a worker thread, the host answering from a RadioStore on the
// simulated dongle. Covers the API, events, storage, the TX rule and how errors end (or don't end) a script.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_INFO_1_6, MockDongLoRaTransport } from '../src/protocol/transports/mock.ts'
import { RadioStore } from '../src/radio/store.ts'
import { ScriptHost, type ScriptLine, type ScriptSpec } from '../src/scripts/host.ts'
import { spawnScriptWorker } from './scripts.ts'

let store: RadioStore
let host: ScriptHost
let lines: { name: string; line: ScriptLine }[]
let canTx: boolean

const spec = (name: string, source: string, allowTx = false): ScriptSpec => ({ id: name, name, source, allowTx })
const printed = (name: string) => lines.filter((l) => l.name === name).map((l) => `${l.line.level}: ${l.line.text}`)

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out; output so far:\n${lines.map((l) => `${l.name} ${l.line.level}: ${l.line.text}`).join('\n')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(async () => {
  lines = []
  canTx = false
  store = new RadioStore()
  await store.connectTransport(new MockDongLoRaTransport({ traffic: true, intervalMs: [40, 80], info: MOCK_INFO_1_6 }), true)
  const data = new Map<string, unknown>()
  host = new ScriptHost(store, {
    spawn: spawnScriptWorker,
    txRefusal: (s) => (!s.allowTx ? 'not allowed' : !canTx ? 'TX is not armed' : undefined),
    armForTx: true,
    output: (s, line) => lines.push({ name: s.name, line }),
    storage: { get: (id, k) => data.get(`${id}/${k}`), set: (id, k, v) => void data.set(`${id}/${k}`, v) },
  })
})

afterEach(async () => {
  host.stopAll()
  await store.disconnect()
})

describe('scripts', () => {
  it('calls the radio, gets events, keeps storage', async () => {
    host.start(
      spec(
        'basic',
        `const s = await radio.state()
        print('status', s.status, 'preset', s.preset)
        print('plugins', (await radio.plugins()).map((p) => p.id).join(','))
        await storage.set('n', 41)
        print('stored', (await storage.get('n')) + 1)
        let seen = 0
        const off = on('packet', (p) => { if (++seen === 2) { print('two packets, last from', p.decode.protocol); off() } })`,
      ),
    )
    await until(() => printed('basic').some((l) => l.includes('two packets')))
    expect(printed('basic')).toEqual(
      expect.arrayContaining(['info: status connected preset meshcore-us', 'info: stored 42', expect.stringMatching(/^info: plugins meshcore/), 'info: two packets, last from meshcore']),
    )
    expect(host.isRunning('basic')).toBe(true)
  })

  it('refuses TX unless the script may transmit and the host allows it', async () => {
    host.start(spec('quiet', `try { await radio.tx('0102') } catch (e) { warn(e.message) }`))
    await until(() => printed('quiet').some((l) => l.startsWith('warn: tx()')))
    expect(printed('quiet')).toContain('warn: tx(): not allowed')

    host.start(spec('loud', `try { await radio.tx(new Uint8Array([1, 2])) } catch (e) { warn(e.message) }`, true))
    await until(() => printed('loud').some((l) => l.startsWith('warn: tx()')))
    expect(printed('loud')).toContain('warn: tx(): TX is not armed')

    canTx = true
    host.start(spec('sends', `const done = await radio.tx('0102'); print('result', done.result)`, true))
    await until(() => printed('sends').some((l) => l.startsWith('info: result')))
    expect(printed('sends')).toEqual(expect.arrayContaining(['warn: TX 2 B', expect.stringMatching(/^info: result [01]$/)]))
  })

  it('survives a throwing handler, ends on a throwing top level or a syntax error', async () => {
    host.start(spec('flaky', `let n = 0; on('packet', () => { if (++n === 1) throw new Error('boom'); if (n === 3) print('still here') })`))
    await until(() => printed('flaky').includes('info: still here'))
    expect(printed('flaky').some((l) => l.startsWith('err: Error: boom'))).toBe(true)
    expect(host.isRunning('flaky')).toBe(true)

    host.start(spec('dies', `await sleep(10); throw new Error('nope')`))
    await until(() => !host.isRunning('dies'))
    expect(printed('dies').at(-1)).toMatch(/^err: failed: Error: nope/)

    host.start(spec('typo', `print('a'`))
    await until(() => !host.isRunning('typo'))
    expect(printed('typo').at(-1)).toMatch(/^err: failed: syntax/)
  })

  it('rejects a bad config and unknown events, and stops cleanly', async () => {
    host.start(
      spec(
        'checks',
        `try { await radio.setConfig('nope') } catch (e) { warn(e.message) }
        try { on('sneeze', () => {}) } catch (e) { warn(e.message) }
        every(150, () => print('tick'))`,
      ),
    )
    await until(() => printed('checks').includes('info: tick'))
    expect(printed('checks').some((l) => l.startsWith('warn: unknown preset'))).toBe(true)
    expect(printed('checks').some((l) => l.startsWith("warn: on(): no event 'sneeze'"))).toBe(true)
    host.stop('checks')
    const ticks = printed('checks').filter((l) => l === 'info: tick').length
    await new Promise((r) => setTimeout(r, 400))
    expect(printed('checks').filter((l) => l === 'info: tick').length).toBe(ticks)
    expect(printed('checks').at(-1)).toBe('info: stopped')
  })
})
