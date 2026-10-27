// Just enough protobuf for Meshtastic's messages. The reader throws ProtoError with the byte offset where it
// went wrong, so decode failures can point into the packet; callers turn that into a DecodeFailure.

const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

export const WireType = { Varint: 0, Fixed64: 1, Len: 2, Fixed32: 5 } as const

export class ProtoError extends Error {
  /** into the buffer the outermost reader was given */
  readonly offset: number

  constructor(message: string, offset: number) {
    super(message)
    this.offset = offset
  }
}

export interface Tag {
  field: number
  wire: number
  /** offset of the tag itself */
  at: number
}

export class ProtoReader {
  private readonly view: DataView
  private pos: number
  readonly buf: Uint8Array
  /** added to every offset reported, so nested readers report positions in the outer buffer */
  readonly base: number

  constructor(buf: Uint8Array, base = 0) {
    this.buf = buf
    this.base = base
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.pos = 0
  }

  /** where the reader is, in the outer buffer's coordinates */
  get offset(): number {
    return this.base + this.pos
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  private fail(message: string, pos = this.pos): never {
    throw new ProtoError(message, this.base + pos)
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) this.fail(`truncated: ${what} needs ${n} bytes at byte ${this.offset}, has ${this.buf.length - this.pos}`)
  }

  /** The next tag, or null at the end of the message. */
  tag(): Tag | null {
    if (this.done) return null
    const at = this.pos
    const t = this.varint()
    const field = Number(t >> 3n)
    const wire = Number(t & 7n)
    if (field === 0 || field > 0x1fffffff) this.fail(`invalid field number ${field}`, at)
    if (wire !== 0 && wire !== 1 && wire !== 2 && wire !== 5) this.fail(`field ${field} has wire type ${wire}, which isn't valid here (groups aren't used)`, at)
    return { field, wire, at: this.base + at }
  }

  /** Up to 10 bytes, as the 64-bit value it encodes. */
  varint(): bigint {
    const start = this.pos
    let v = 0n
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) this.fail(`truncated: varint at byte ${this.base + start} runs past the end`)
      const b = this.buf[this.pos++]
      v |= BigInt(b & 0x7f) << BigInt(7 * i)
      if (!(b & 0x80)) return BigInt.asUintN(64, v)
    }
    this.fail(`varint at byte ${this.base + start} is longer than 10 bytes`, start)
  }

  uint32(): number {
    return Number(BigInt.asUintN(32, this.varint()))
  }

  /** int32 and enums: negative values arrive sign-extended to 10 bytes */
  int32(): number {
    return Number(BigInt.asIntN(32, this.varint()))
  }

  sint32(): number {
    const n = this.uint32()
    return (n >>> 1) ^ -(n & 1)
  }

  sint64(): bigint {
    const n = this.varint()
    return BigInt.asIntN(64, (n >> 1n) ^ -(n & 1n))
  }

  bool(): boolean {
    return this.varint() !== 0n
  }

  fixed32(): number {
    this.need(4, 'fixed32')
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  sfixed32(): number {
    this.need(4, 'sfixed32')
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  float(): number {
    this.need(4, 'float')
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  fixed64(): bigint {
    this.need(8, 'fixed64')
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    return v
  }

  /** A length-delimited field's contents, and where they start in the outer buffer. */
  len(): { bytes: Uint8Array; at: number } {
    const lenAt = this.offset
    const n = this.varint()
    const left = this.buf.length - this.pos
    if (n > BigInt(left)) this.fail(`truncated: length-delimited field at byte ${lenAt} says ${n} bytes, ${left} left`)
    const at = this.offset
    const bytes = this.buf.subarray(this.pos, this.pos + Number(n))
    this.pos += Number(n)
    return { bytes, at }
  }

  bytes(): Uint8Array {
    return this.len().bytes
  }

  string(): string {
    const { bytes, at } = this.len()
    try {
      return utf8.decode(bytes)
    } catch {
      throw new ProtoError('string is not valid UTF-8', at)
    }
  }

  /** A reader over a nested message; its errors carry offsets in this reader's coordinates. */
  message(): ProtoReader {
    const { bytes, at } = this.len()
    return new ProtoReader(bytes, at)
  }

  skip(wire: number): void {
    if (wire === WireType.Varint) this.varint()
    else if (wire === WireType.Fixed64) this.fixed64()
    else if (wire === WireType.Len) this.len()
    else if (wire === WireType.Fixed32) this.fixed32()
    else this.fail(`can't skip wire type ${wire}`)
  }

  /** Throws unless a known field arrived with the wire type its schema says, as nanopb does. */
  expect(t: Tag, wire: number): void {
    if (t.wire !== wire) throw new ProtoError(`field ${t.field} has wire type ${t.wire}, expected ${wire}`, t.at)
  }

  /** Repeated scalars: proto3 packs them into one length-delimited field, but parsers must accept either form. */
  repeated(t: Tag, wire: number, read: (r: ProtoReader) => number, into: number[]): void {
    if (t.wire === wire) {
      into.push(read(this))
      return
    }
    this.expect(t, WireType.Len)
    const inner = this.message()
    while (!inner.done) into.push(read(inner))
  }
}

export class ProtoWriter {
  private readonly parts: number[] = []

  private rawVarint(v: bigint): void {
    let n = BigInt.asUintN(64, v)
    while (n >= 0x80n) {
      this.parts.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    this.parts.push(Number(n))
  }

  private tag(field: number, wire: number): void {
    this.rawVarint((BigInt(field) << 3n) | BigInt(wire))
  }

  /** uint32, int32 (negative values sign-extend to 10 bytes), enums, uint64 */
  varint(field: number, v: number | bigint): this {
    this.tag(field, WireType.Varint)
    this.rawVarint(BigInt(v))
    return this
  }

  sint32(field: number, v: number): this {
    return this.varint(field, ((v << 1) ^ (v >> 31)) >>> 0)
  }

  bool(field: number, v: boolean): this {
    return this.varint(field, v ? 1 : 0)
  }

  /** fixed32 and sfixed32 */
  fixed32(field: number, v: number): this {
    this.tag(field, WireType.Fixed32)
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }

  float(field: number, v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.tag(field, WireType.Fixed32)
    for (const x of b) this.parts.push(x)
    return this
  }

  bytes(field: number, b: ArrayLike<number>): this {
    this.tag(field, WireType.Len)
    this.rawVarint(BigInt(b.length))
    for (let i = 0; i < b.length; i++) this.parts.push(b[i] & 0xff)
    return this
  }

  string(field: number, s: string): this {
    return this.bytes(field, utf8Encoder.encode(s))
  }

  /** packed repeated fixed32, as proto3 writes `repeated fixed32` */
  packedFixed32(field: number, vs: number[]): this {
    const b: number[] = []
    for (const v of vs) b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this.bytes(field, b)
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}
