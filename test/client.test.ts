import { afterEach, describe, expect, it, vi } from 'vitest'
import { ByteWriter } from '../src/protocol/bytes.ts'
import { DongLoRaClient, DongLoRaError, TimeoutError, type LinkError, type Transport, type TransportSink } from '../src/protocol/client.ts'
import { cobsEncode } from '../src/protocol/cobs.ts'
import { ErrCode, MsgType, TxResult } from '../src/protocol/codes.ts'
import { encodeFrame, frameBody, FrameDecoder, type Frame } from '../src/protocol/framing.ts'
import { encodeInfo, encodeRx } from '../src/protocol/messages.ts'
import type { Ticker, TickerFactory } from '../src/protocol/ticker.ts'
import { MOCK_INFO, MockDongLoRaTransport } from '../src/protocol/transports/mock.ts'
import { DEFAULT_PRESET } from '../src/meshcore/presets.ts'

/** A transport whose replies the test writes by hand. */
class ScriptedTransport implements Transport {
  readonly label = 'scripted'
  sink: TransportSink | null = null
  sent: Frame[] = []
  closed = 0
  writeDelayMs = 0
  inFlight = 0
  maxInFlight = 0
  private readonly decoder = new FrameDecoder()

  async open(sink: TransportSink) {
    this.sink = sink
  }
  async write(data: Uint8Array) {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs))
    this.sent.push(...this.decoder.push(data))
    this.inFlight--
  }
  async close() {
    this.closed++
  }

  reply(type: number, tag: number, payload?: Uint8Array) {
    this.sink!.onData(encodeFrame(type, tag, payload))
  }
  raw(bytes: Uint8Array) {
    this.sink!.onData(bytes)
  }
  last(): Frame {
    return this.sent[this.sent.length - 1]
  }
}

/** A keepalive ticker the test drives by hand. */
function manualTicker(): { factory: TickerFactory; tick: () => void } {
  let fn: (() => void) | null = null
  return {
    factory: (_ms, f): Ticker => {
      fn = f
      return { stop: () => (fn = null) }
    },
    tick: () => fn?.(),
  }
}

async function scripted(options = {}) {
  const t = new ScriptedTransport()
  const ticker = manualTicker()
  const c = new DongLoRaClient(t, { ticker: ticker.factory, ...options })
  const linkErrors: LinkError[] = []
  c.on('linkError', (e) => linkErrors.push(e))
  await c.connect()
  return { t, c, linkErrors, tick: ticker.tick }
}

const sentCount = (t: ScriptedTransport, n: number) => vi.waitFor(() => expect(t.sent.length).toBeGreaterThanOrEqual(n))

afterEach(() => vi.useRealTimers())

describe('tags', () => {
  it('matches replies by tag, in any order', async () => {
    const { t, c } = await scripted()
    const ping = c.ping()
    const info = c.getInfo()
    await sentCount(t, 2)
    const [p, i] = t.sent
    expect(p.tag).not.toBe(i.tag)
    t.reply(MsgType.Ok, i.tag, encodeInfo(MOCK_INFO))
    t.reply(MsgType.Ok, p.tag)
    expect((await info).firmware).toEqual({ major: 1, minor: 5, patch: 2 })
    expect(await ping).toBeGreaterThanOrEqual(0)
  })

  it('starts at 1, never uses 0, and skips outstanding tags when it wraps', async () => {
    const { t, c } = await scripted()
    void c.ping().catch(() => {}) // tag 1 stays outstanding
    await sentCount(t, 1)
    expect(t.sent[0].tag).toBe(1)
    ;(c as unknown as { nextTag: number }).nextTag = 0xffff
    void c.ping().catch(() => {})
    void c.ping().catch(() => {})
    await sentCount(t, 3)
    expect(t.sent.map((f) => f.tag)).toEqual([1, 0xffff, 2])
  })

  it('rejects with the device error code', async () => {
    const { t, c } = await scripted()
    const p = c.setConfig({ ...DEFAULT_PRESET.config, freqHz: 2_450_000_000 })
    await sentCount(t, 1)
    t.reply(MsgType.Err, t.last().tag, new ByteWriter().u16(ErrCode.Param).toBytes())
    await expect(p).rejects.toMatchObject({ name: 'DongLoRaError', code: ErrCode.Param })
    await expect(p).rejects.toThrow('SET_CONFIG: EPARAM')
  })

  it('times out, and reports the late reply as unmatched', async () => {
    vi.useFakeTimers()
    const { t, c, linkErrors } = await scripted({ timeoutMs: 2000 })
    const p = c.ping()
    const rejected = expect(p).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(2001)
    await rejected
    t.reply(MsgType.Ok, t.sent[0].tag)
    expect(linkErrors).toHaveLength(1)
    expect(linkErrors[0].kind).toBe('unmatched')
    expect(linkErrors[0].reason).toMatch(/OK for tag 0x0001, which has no command waiting/)
  })
})

describe('link errors are reported with their bytes', () => {
  it('async ERR (tag 0) does not touch pending commands', async () => {
    const { t, c, linkErrors } = await scripted()
    const p = c.ping()
    await sentCount(t, 1)
    t.reply(MsgType.Err, 0, new ByteWriter().u16(ErrCode.Frame).toBytes())
    t.reply(MsgType.Ok, t.sent[0].tag)
    await p
    expect(linkErrors).toMatchObject([{ kind: 'async-err', code: ErrCode.Frame }])
    expect(linkErrors[0].reason).toContain('EFRAME')
    expect([...linkErrors[0].bytes.subarray(0, 5)]).toEqual([0x81, 0, 0, 0x02, 0x01])
  })

  it('reports ERADIO and EINTERNAL too', async () => {
    const { t, linkErrors } = await scripted()
    t.reply(MsgType.Err, 0, new ByteWriter().u16(ErrCode.Radio).toBytes())
    t.reply(MsgType.Err, 0, new ByteWriter().u16(ErrCode.Internal).toBytes())
    expect(linkErrors.map((e) => e.reason)).toEqual(['async ERADIO: radio hardware fault', 'async EINTERNAL: firmware internal error'])
  })

  it('unknown frame types', async () => {
    const { t, linkErrors } = await scripted()
    t.reply(0xc7, 0, Uint8Array.of(9))
    expect(linkErrors).toMatchObject([{ kind: 'unknown-type', reason: 'unknown frame type 0xc7', offset: 0 }])
  })

  it('frames with a bad CRC, bad COBS, or too short', async () => {
    const { t, linkErrors } = await scripted()
    const body = frameBody(MsgType.Rx, 0, new Uint8Array(24))
    body[body.length - 1] ^= 1
    t.raw(Uint8Array.from([...cobsEncode(body), 0]))
    t.raw(Uint8Array.of(0x07, 0x80, 0x00))
    t.raw(Uint8Array.from([...cobsEncode(Uint8Array.of(0x80)), 0]))
    expect(linkErrors.map((e) => e.kind)).toEqual(['crc', 'cobs', 'short'])
    expect(linkErrors[0].bytes.length).toBe(body.length)
  })

  it('an RX event too short for its metadata', async () => {
    const { t, c, linkErrors } = await scripted()
    const rx = vi.fn()
    c.on('rx', rx)
    t.reply(MsgType.Rx, 0, new Uint8Array(12))
    expect(rx).not.toHaveBeenCalled()
    expect(linkErrors).toMatchObject([{ kind: 'bad-payload', reason: 'RX payload is 12 bytes, the metadata alone is 20' }])
  })

  it('a reply payload that does not parse', async () => {
    const { t, c, linkErrors } = await scripted()
    const p = c.getInfo()
    await sentCount(t, 1)
    t.reply(MsgType.Ok, t.last().tag, new Uint8Array(10))
    await expect(p).rejects.toThrow(RangeError)
    expect(linkErrors[0].kind).toBe('bad-payload')
    expect(linkErrors[0].reason).toMatch(/^GET_INFO reply: frame too short/)
  })

  it('serial errors the transport recovered from', async () => {
    const { t, linkErrors } = await scripted()
    t.sink!.onError!(new Error('serial read error (BufferOverrunError): bytes were lost, still reading'))
    expect(linkErrors).toMatchObject([{ kind: 'transport' }])
  })

  it('delivers RX with a failed CRC instead of dropping it', async () => {
    const { t, c } = await scripted()
    const got: boolean[] = []
    c.on('rx', (p) => got.push(p.crcValid))
    t.reply(MsgType.Rx, 0, encodeRx({ rssi: -110, snr: -9, freqErr: 0, timestampUs: 1, crcValid: false, packetsDropped: 0, origin: 0, data: Uint8Array.of(1, 2) }))
    expect(got).toEqual([false])
  })
})

describe('TX', () => {
  it('waits for TX_DONE after the OK, on the same tag', async () => {
    const { t, c } = await scripted()
    const p = c.transmit(Uint8Array.of(1, 2, 3))
    await sentCount(t, 1)
    const tag = t.last().tag
    expect([...t.last().payload]).toEqual([0, 1, 2, 3])
    t.reply(MsgType.Ok, tag)
    let settled = false
    void p.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    t.reply(MsgType.TxDone, tag, new ByteWriter().u8(TxResult.Transmitted).u32(30976).toBytes())
    expect(await p).toEqual({ result: 0, airtimeUs: 30976 })
  })

  it('does not retry a TX after ENOTCONFIGURED, but restores the session', async () => {
    const { t, c } = await scripted()
    c.wanted = DEFAULT_PRESET.config
    const lost = vi.fn()
    c.on('sessionLost', lost)
    const p = c.transmit(Uint8Array.of(1))
    await sentCount(t, 1)
    t.reply(MsgType.Err, t.last().tag, new ByteWriter().u16(ErrCode.NotConfigured).toBytes())
    await expect(p).rejects.toBeInstanceOf(DongLoRaError)
    await sentCount(t, 2)
    expect(t.sent.map((f) => f.type)).toEqual([MsgType.Tx, MsgType.SetConfig])
    expect(lost).toHaveBeenCalledOnce()
  })

  it('against the mock: transmits, reports busy, rejects a full queue', async () => {
    const mock = new MockDongLoRaTransport({ busyRate: 0 })
    const c = new DongLoRaClient(mock, { ticker: manualTicker().factory })
    await c.connect()
    await expect(c.transmit(Uint8Array.of(1))).rejects.toMatchObject({ code: ErrCode.NotConfigured })
    await c.setConfig(DEFAULT_PRESET.config)
    const first = c.transmit(new Uint8Array(10).fill(7))
    await expect(c.transmit(Uint8Array.of(2))).rejects.toMatchObject({ code: ErrCode.Busy }) // TX queue holds 1
    expect((await first).result).toBe(TxResult.Transmitted)
    await expect(c.transmit(new Uint8Array(0))).rejects.toMatchObject({ code: ErrCode.Length })
    await c.disconnect()
  })
})

describe('writes and keepalive', () => {
  it('never overlaps writes', async () => {
    const { t, c } = await scripted()
    t.writeDelayMs = 5
    const all = [c.ping(), c.getInfo(), c.rxStart(), c.ping()]
    await sentCount(t, 4)
    expect(t.maxInFlight).toBe(1)
    for (const f of t.sent) t.reply(MsgType.Ok, f.tag, f.type === MsgType.GetInfo ? encodeInfo(MOCK_INFO) : undefined)
    await Promise.all(all)
  })

  it('PINGs when nothing else was written for 400 ms, whether or not the last one was answered', async () => {
    vi.useFakeTimers()
    const { t, tick } = await scripted()
    tick()
    expect(t.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(450)
    tick()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sent.map((f) => f.type)).toEqual([MsgType.Ping])
    tick() // too soon after the last one
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(450)
    tick() // the first PING is still unanswered (its reply was lost): send another anyway
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sent.map((f) => f.type)).toEqual([MsgType.Ping, MsgType.Ping])
  })

  it('keeps the mock configured for 10 s with the real interval ticker', async () => {
    vi.useFakeTimers()
    const mock = new MockDongLoRaTransport()
    const c = new DongLoRaClient(mock) // Node has no Worker: setInterval
    await c.connect()
    const setup = c.setConfig(DEFAULT_PRESET.config).then(() => c.rxStart())
    await vi.advanceTimersByTimeAsync(10)
    await setup
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mock.timeouts).toBe(0)
    expect(mock.receiving).toBe(true)
    expect(c.health.pings).toBeGreaterThan(15)
    expect(c.health.maxGapMs).toBeLessThan(600)
    await c.disconnect()
  })

  it('notices a write gap, probes, and restores config and RX', async () => {
    vi.useFakeTimers()
    const mock = new MockDongLoRaTransport()
    const ticker = manualTicker()
    const c = new DongLoRaClient(mock, { ticker: ticker.factory })
    const events: string[] = []
    c.on('sessionLost', (r) => events.push(`lost: ${r}`))
    c.on('recovered', () => events.push('recovered'))
    await c.connect()
    const setup = c.setConfig(DEFAULT_PRESET.config).then(() => c.rxStart())
    await vi.advanceTimersByTimeAsync(10)
    await setup
    // a background tab stalls the keepalive for 1.5 s: the dongle resets
    await vi.advanceTimersByTimeAsync(1500)
    expect(mock.timeouts).toBe(1)
    expect(mock.receiving).toBe(false)
    ticker.tick()
    await vi.advanceTimersByTimeAsync(50)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatch(/^lost: no frame sent for \d+ ms; the device had reset its session/)
    expect(events[1]).toBe('recovered')
    expect(mock.config).toEqual(DEFAULT_PRESET.config)
    expect(mock.receiving).toBe(true)
    expect(c.health).toMatchObject({ lostSessions: 1, recoveries: 1 })
    await c.disconnect()
  })

  it('RX_START answered ENOTCONFIGURED re-sends the config first', async () => {
    const mock = new MockDongLoRaTransport()
    const c = new DongLoRaClient(mock, { ticker: manualTicker().factory })
    await c.connect()
    c.wanted = DEFAULT_PRESET.config // as if configured before the dongle reset
    await c.rxStart()
    expect(mock.receiving).toBe(true)
    expect(mock.received.map((f) => f.type)).toEqual([MsgType.RxStart, MsgType.SetConfig, MsgType.RxStart])
    await c.disconnect()
  })
})

describe('closing', () => {
  it('fails pending commands and closes the port when the transport drops', async () => {
    const { t, c } = await scripted()
    const p = c.ping()
    const closed = vi.fn()
    c.on('close', closed)
    t.sink!.onClose(new Error('device lost'))
    await expect(p).rejects.toThrow('device lost')
    await vi.waitFor(() => expect(closed).toHaveBeenCalled())
    expect(c.isOpen).toBe(false)
    expect(t.closed).toBe(1)
  })
})
