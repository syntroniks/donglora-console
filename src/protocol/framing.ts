// DongLoRa wire framing (PROTOCOL.md §2):
//   COBS(type u8 | tag u16 | payload | crc16 u16) 0x00
// The CRC covers type, tag and payload. Everything is little-endian.

import { cobsDecode, cobsEncode } from './cobs.ts'
import { crc16 } from './crc.ts'

export interface Frame {
  type: number
  tag: number
  payload: Uint8Array
}

/** Largest pre-COBS frame for a 255-byte radio: 5 + 255 + 20 (§2.3). */
export const MAX_FRAME_BODY = 280

/** Wire bytes kept while waiting for a delimiter. Anything longer is noise, and is dropped. */
export const MAX_WIRE_FRAME = 512

export function frameBody(type: number, tag: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const body = new Uint8Array(5 + payload.length)
  body[0] = type
  body[1] = tag & 0xff
  body[2] = tag >> 8
  body.set(payload, 3)
  const crc = crc16(body.subarray(0, 3 + payload.length))
  body[3 + payload.length] = crc & 0xff
  body[4 + payload.length] = crc >> 8
  return body
}

export function encodeFrame(type: number, tag: number, payload?: Uint8Array): Uint8Array {
  const cobs = cobsEncode(frameBody(type, tag, payload))
  const wire = new Uint8Array(cobs.length + 1)
  wire.set(cobs)
  return wire // ends in the 0x00 delimiter
}

export type FrameFaultKind = 'cobs' | 'short' | 'crc' | 'overflow'

/** A frame that failed to decode, kept with its bytes so it can be shown rather than dropped. */
export interface FrameFault {
  kind: FrameFaultKind
  reason: string
  wire: Uint8Array // COBS bytes as received, without the 0x00 delimiter
  body?: Uint8Array // after COBS decoding, when that worked
  offset?: number // where it went wrong: into body when there is one, else into wire
}

/** Decode one frame's COBS bytes (without the delimiter). */
export function decodeFrame(wire: Uint8Array): Frame | FrameFault {
  const body = cobsDecode(wire)
  if (!body) return { kind: 'cobs', reason: `bad COBS encoding at byte ${cobsFailOffset(wire)}`, wire, offset: cobsFailOffset(wire) }
  if (body.length < 5) return { kind: 'short', reason: `frame is ${body.length} bytes, minimum is 5`, wire, body, offset: 0 }
  const end = body.length - 2
  const crc = body[end] | (body[end + 1] << 8)
  const want = crc16(body.subarray(0, end))
  if (want !== crc) return { kind: 'crc', reason: `CRC ${hex4(crc)} but the bytes give ${hex4(want)}`, wire, body, offset: end }
  return { type: body[0], tag: body[1] | (body[2] << 8), payload: body.slice(3, end) }
}

export const isFault = (f: Frame | FrameFault): f is FrameFault => 'kind' in f

/**
 * Splits the device's byte stream into frames at each 0x00. A frame that fails COBS, length or CRC
 * checks goes to onFault with its bytes, and decoding carries on from the next delimiter (§2.4). A run
 * longer than MAX_WIRE_FRAME without a delimiter is reported as an overflow, not buffered forever.
 */
export class FrameDecoder {
  private buf = new Uint8Array(MAX_WIRE_FRAME)
  private len = 0
  private overflow = 0
  private readonly onFault?: (fault: FrameFault) => void

  constructor(onFault?: (fault: FrameFault) => void) {
    this.onFault = onFault
  }

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = []
    for (const b of chunk) {
      if (b !== 0) {
        if (this.len < this.buf.length) this.buf[this.len++] = b
        else this.overflow++
        continue
      }
      const wire = this.buf.slice(0, this.len)
      this.len = 0
      if (this.overflow) {
        const reason = `${wire.length + this.overflow} bytes without a 0x00 delimiter (limit ${MAX_WIRE_FRAME}); first ${wire.length} kept`
        this.overflow = 0
        this.onFault?.({ kind: 'overflow', reason, wire, offset: MAX_WIRE_FRAME - 1 })
        continue
      }
      if (wire.length === 0) continue // back-to-back delimiters
      const f = decodeFrame(wire)
      if (isFault(f)) this.onFault?.(f)
      else frames.push(f)
    }
    return frames
  }

  reset(): void {
    this.len = 0
    this.overflow = 0
  }
}

/** Index of the first byte that breaks COBS decoding. */
function cobsFailOffset(src: Uint8Array): number {
  let i = 0
  while (i < src.length) {
    const code = src[i]
    if (code === 0) return i
    const end = i + code
    if (end > src.length) return i
    for (let j = i + 1; j < end; j++) if (src[j] === 0) return j
    i = end
  }
  return src.length
}

const hex4 = (n: number) => `0x${n.toString(16).padStart(4, '0')}`
