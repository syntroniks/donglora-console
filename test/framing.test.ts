import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from '../src/protocol/bytes.ts'
import { cobsDecode, cobsEncode } from '../src/protocol/cobs.ts'
import { crc16 } from '../src/protocol/crc.ts'
import { decodeFrame, encodeFrame, frameBody, FrameDecoder, MAX_WIRE_FRAME, type FrameFault } from '../src/protocol/framing.ts'
import { APPENDIX_C } from './appendixC.ts'

const hex = (b: Uint8Array) => toHex(b, ' ').toUpperCase()

describe('CRC-16/CCITT-FALSE', () => {
  it('matches the check value', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1)
  })
})

describe('COBS', () => {
  it('round-trips runs of zeros and long non-zero runs', () => {
    for (const len of [0, 1, 253, 254, 255, 508, 600]) {
      const src = Uint8Array.from({ length: len }, (_, i) => (i % 7 === 3 ? 0 : (i % 255) + 1))
      const enc = cobsEncode(src)
      expect(enc.includes(0)).toBe(false)
      expect([...cobsDecode(enc)!]).toEqual([...src])
    }
  })

  it('encodes a 259-byte zero-free body with an 0xFF code byte (C.8.3)', () => {
    const body = Uint8Array.from([0x04, 0x01, 0x01, 0x01, ...Array.from({ length: 253 }, (_, i) => i + 1), 0x53, 0x46])
    const enc = cobsEncode(body)
    expect(enc.length).toBe(261)
    expect(enc[0]).toBe(0xff)
    expect(enc[255]).toBe(0x06)
    expect(crc16(body.subarray(0, 257))).toBe(0x4653)
  })

  it('rejects a code byte that points past the end', () => {
    expect(cobsDecode(Uint8Array.of(0x05, 1, 2))).toBeNull()
  })
})

describe('Appendix C wire examples', () => {
  it.each(APPENDIX_C)('%s', (_what, pre, wire) => {
    const body = fromHex(pre)
    // our encoder builds the same pre-COBS frame (CRC included) and the same wire bytes
    const payload = body.subarray(3, body.length - 2)
    expect(hex(frameBody(body[0], body[1] | (body[2] << 8), payload))).toBe(pre)
    expect(hex(encodeFrame(body[0], body[1] | (body[2] << 8), payload))).toBe(wire)
    // and decodes the wire bytes back
    const frames = new FrameDecoder().push(fromHex(wire))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ type: body[0], tag: body[1] | (body[2] << 8), payload: payload.slice() })
  })

  it('splits batched frames from one read (C.3.2)', () => {
    const chunk = fromHex('03 04 64 01 04 41 CC 53 00  03 04 65 01 04 42 1B 15 00  03 04 66 01 04 43 E6 9E 00')
    expect(new FrameDecoder().push(chunk).map((f) => f.tag)).toEqual([0x64, 0x65, 0x66])
  })

  it('reassembles a frame split across reads', () => {
    const d = new FrameDecoder()
    const wire = fromHex('02 C0 01 04 21 FD 5F 09 83 FF FF FF 80 DE 80 02 01 01 01 02 01 01 01 07 01 02 03 04 B9 8E 00')
    expect(d.push(wire.subarray(0, 5))).toEqual([])
    expect(d.push(wire.subarray(5, 20))).toEqual([])
    const [f] = d.push(wire.subarray(20))
    expect(f.type).toBe(0xc0)
    expect([...f.payload.subarray(20)]).toEqual([1, 2, 3, 4])
  })
})

describe('FrameDecoder failures are reported, never dropped quietly', () => {
  const collect = () => {
    const faults: FrameFault[] = []
    return { faults, d: new FrameDecoder((f) => faults.push(f)) }
  }

  it('reports a CRC mismatch with the decoded body and the CRC offset', () => {
    const { faults, d } = collect()
    const body = frameBody(0x80, 7)
    body[3] ^= 0xff
    expect(d.push(Uint8Array.from([...cobsEncode(body), 0]))).toEqual([])
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ kind: 'crc', offset: 3 })
    expect(faults[0].reason).toMatch(/CRC 0x[0-9a-f]{4} but the bytes give 0x[0-9a-f]{4}/)
    expect(hex(faults[0].body!)).toBe(hex(body))
  })

  it('reports bad COBS with the wire bytes and where it broke', () => {
    const { faults, d } = collect()
    d.push(Uint8Array.of(0x09, 0xc0, 0x01, 0x00))
    expect(faults[0]).toMatchObject({ kind: 'cobs', offset: 0 })
    expect([...faults[0].wire]).toEqual([0x09, 0xc0, 0x01])
  })

  it('reports a frame shorter than type + tag + CRC', () => {
    const { faults, d } = collect()
    d.push(Uint8Array.from([...cobsEncode(Uint8Array.of(0x80, 0x01)), 0]))
    expect(faults[0]).toMatchObject({ kind: 'short', reason: 'frame is 2 bytes, minimum is 5' })
  })

  it('reports and recovers from a run with no delimiter', () => {
    const { faults, d } = collect()
    const junk = new Uint8Array(MAX_WIRE_FRAME + 100).fill(0x41)
    expect(d.push(Uint8Array.from([...junk, 0, ...encodeFrame(0x80, 9)]))).toHaveLength(1)
    expect(faults).toHaveLength(1)
    expect(faults[0].kind).toBe('overflow')
    expect(faults[0].reason).toContain(`${MAX_WIRE_FRAME + 100} bytes without a 0x00 delimiter`)
  })

  it('carries on with the next frame after a bad one (C.9.2)', () => {
    const { faults, d } = collect()
    const good = encodeFrame(0x80, 1)
    const bad = encodeFrame(0x80, 2)
    bad[2] ^= 0x10
    const frames = d.push(Uint8Array.from([...good, ...bad, ...encodeFrame(0x80, 3)]))
    expect(frames.map((f) => f.tag)).toEqual([1, 3])
    expect(faults.map((f) => f.kind)).toEqual(['crc'])
  })

  it('decodeFrame returns the fault instead of throwing', () => {
    expect(decodeFrame(Uint8Array.of(0x02, 0x80))).toMatchObject({ kind: 'short' })
  })
})
