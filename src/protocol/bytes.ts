// Little-endian helpers for DongLoRa frames and MeshCore packets.

const utf8 = new TextDecoder('utf-8')
const utf8Encoder = new TextEncoder()

export class ByteReader {
  private readonly view: DataView
  private pos: number
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = offset
  }

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.bytes.length - this.pos
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new RangeError(`frame too short: need ${n} bytes at offset ${this.pos}, have ${this.remaining}`)
    }
  }

  u8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  i8(): number {
    this.need(1)
    return this.view.getInt8(this.pos++)
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  u64(): bigint {
    this.need(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    return v
  }

  take(n: number): Uint8Array {
    this.need(n)
    const out = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** A fixed-size field holding a NUL-terminated UTF-8 string. */
  fixedString(n: number): string {
    return cString(this.take(n))
  }

  /** Everything left in the frame, as UTF-8 (stops at a NUL). */
  restString(): string {
    return cString(this.take(this.remaining))
  }
}

export class ByteWriter {
  private readonly parts: number[] = []

  u8(v: number): this {
    this.parts.push(v & 0xff)
    return this
  }

  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }

  /** also writes negative values as two's complement (i32) */
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }

  u64(v: bigint | number): this {
    let n = BigInt.asUintN(64, BigInt(v))
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(n & 0xffn))
      n >>= 8n
    }
    return this
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i] & 0xff)
    return this
  }

  string(s: string): this {
    return this.bytes(utf8Encoder.encode(s))
  }

  /** s as UTF-8, NUL padded (or truncated) to exactly n bytes. */
  fixedString(s: string, n: number): this {
    const b = utf8Encoder.encode(s).slice(0, n)
    this.bytes(b)
    for (let i = b.length; i < n; i++) this.parts.push(0)
    return this
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

export function cString(b: Uint8Array): string {
  const end = b.indexOf(0)
  return utf8.decode(end >= 0 ? b.subarray(0, end) : b)
}

export function toHex(b: Uint8Array, sep = ''): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(sep)
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2) throw new Error(`odd-length hex: ${hex}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
