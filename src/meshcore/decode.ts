// MeshCore packet decoding (docs/packet_format.md, docs/payloads.md, src/Mesh.cpp). Never throws: every
// result says how far decoding got, and when it stopped, at which stage, why, and at which byte of the
// raw packet. Fields that parsed before the failure are kept.

import { ed25519 } from '@noble/curves/ed25519.js'
import { toHex } from '../protocol/bytes.ts'
import {
  ADV_TYPE_NAMES,
  AdvFlag,
  CIPHER_BLOCK_SIZE,
  CIPHER_MAC_SIZE,
  MAX_PACKET_PAYLOAD,
  MAX_PATH_SIZE,
  PAYLOAD_TYPE_NAMES,
  PAYLOAD_VERSION_1,
  PayloadType,
  PUB_KEY_SIZE,
  ROUTE_TYPE_NAMES,
  SIGNATURE_SIZE,
} from './codes.ts'
import { aesEcbDecrypt, channelMac, PUBLIC_CHANNEL, type Channel } from './crypto.ts'

export type DecodeStage = 'header' | 'path' | 'payload' | 'advert' | 'signature' | 'channel' | 'decrypt' | 'mac'

/**
 * decoded: everything this console can read was read. partial: the header and path are fine, a later stage
 * failed. undecodable: the header or path failed, so the payload can't be found. no-key: a channel message
 * for a channel whose key this console doesn't have, which isn't a failure.
 */
export type DecodeStatus = 'decoded' | 'partial' | 'undecodable' | 'no-key'

export interface DecodeFailure {
  stage: DecodeStage
  reason: string
  offset: number // into the raw packet
}

export interface PacketHeader {
  routeType: number
  routeName: string
  payloadType: number
  payloadName: string
  version: number
}

export interface Advert {
  publicKey: string // hex
  timestamp: number
  signature: string // hex
  flags: number
  type: number
  typeName: string
  lat: number
  lon: number
  hasLocation: boolean
  name: string
  signatureValid: boolean
}

export interface GroupMessage {
  channelHash: number
  channel: string // name of the channel whose key worked
  mac: string // hex
  timestamp: number
  flags: number
  text: string
  sender: string
  body: string
  dataType: number // group-data only
  data: string // hex, group-data only
}

/** request, response, text and path payloads: peer-to-peer encrypted, so only the outer fields */
export interface Addressed {
  destHash: number
  srcHash: number
  mac: string
  ciphertextLength: number
}

export interface MeshDecode {
  status: DecodeStatus
  failure?: DecodeFailure
  header?: PacketHeader
  transportCodes?: [number, number]
  hops?: number
  hashSize?: number
  path?: string // hex
  payloadOffset?: number
  payloadLength?: number
  advert?: Partial<Advert>
  group?: Partial<GroupMessage>
  addressed?: Partial<Addressed>
  ackChecksum?: string
  anonPublicKey?: string
  summary: string
}

export interface DecodeOptions {
  channels?: Channel[]
  /** check advert signatures (Ed25519, about a millisecond each) */
  verifySignatures?: boolean
}

/** MeshCore only signs the first 32 bytes of advert appdata (MAX_ADVERT_DATA_SIZE). */
const MAX_ADVERT_DATA_SIZE = 32

const utf8 = new TextDecoder('utf-8', { fatal: true })
const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const i32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

/** UTF-8 up to the first NUL; null if the bytes aren't valid UTF-8. */
function text(b: Uint8Array): string | null {
  const end = b.indexOf(0)
  try {
    return utf8.decode(end >= 0 ? b.subarray(0, end) : b)
  } catch {
    return null
  }
}

/** "alice: hello there" -> { sender: 'alice', body: 'hello there' }. Channel posts carry the sender's name inline. */
export function splitChannelText(t: string): { sender: string; body: string } {
  const i = t.indexOf(': ')
  return i > 0 ? { sender: t.slice(0, i), body: t.slice(i + 2) } : { sender: '', body: t }
}

export function decodeMeshCore(raw: Uint8Array, options: DecodeOptions = {}): MeshDecode {
  const channels = options.channels ?? [PUBLIC_CHANNEL]
  const out: MeshDecode = { status: 'decoded', summary: '' }
  const fail = (stage: DecodeStage, reason: string, offset: number): MeshDecode => {
    out.failure = { stage, reason, offset }
    out.status = stage === 'header' || stage === 'path' ? 'undecodable' : 'partial'
    out.summary = `${out.header?.payloadName ?? 'packet'}: ${reason}`
    return out
  }

  // ---- header ----
  if (raw.length === 0) return fail('header', 'empty packet', 0)
  const h = raw[0]
  const routeType = h & 0x03
  const payloadType = (h >> 2) & 0x0f
  const version = h >> 6
  out.header = {
    routeType,
    routeName: ROUTE_TYPE_NAMES[routeType],
    payloadType,
    payloadName: PAYLOAD_TYPE_NAMES[payloadType] ?? `type ${hex2(payloadType)}`,
    version,
  }
  if (version !== PAYLOAD_VERSION_1) return fail('header', `unknown payload version ${version + 1} (header ${hex2(h)}); only version 1 exists`, 0)
  let pos = 1
  if (routeType === 0 || routeType === 3) {
    if (raw.length < pos + 4) return fail('header', `truncated: ${out.header.routeName} needs 4 bytes of transport codes at byte 1, has ${raw.length - 1}`, raw.length)
    out.transportCodes = [u16(raw, 1), u16(raw, 3)]
    pos += 4
  }

  // ---- path ----
  if (raw.length <= pos) return fail('path', `truncated: no path length byte at byte ${pos}`, pos)
  const pathLen = raw[pos]
  const hashCode = pathLen >> 6
  if (hashCode === 3) return fail('path', `reserved hash-size code 3 in path length ${hex2(pathLen)}`, pos)
  out.hashSize = hashCode + 1
  out.hops = pathLen & 63
  const pathBytes = out.hops * out.hashSize
  if (pathBytes > MAX_PATH_SIZE) {
    return fail('path', `path is ${pathBytes} bytes (${out.hops} hops × ${out.hashSize}), over the ${MAX_PATH_SIZE}-byte limit`, pos)
  }
  pos++
  if (raw.length < pos + pathBytes) return fail('path', `truncated: path needs ${pathBytes} bytes at byte ${pos}, has ${raw.length - pos}`, raw.length)
  out.path = toHex(raw.subarray(pos, pos + pathBytes))
  pos += pathBytes

  // ---- payload ----
  const p = raw.subarray(pos)
  const at = pos
  out.payloadOffset = at
  out.payloadLength = p.length
  if (!(payloadType in PAYLOAD_TYPE_NAMES)) return fail('payload', `unknown payload type ${hex2(payloadType)}`, 0)
  if (p.length > MAX_PACKET_PAYLOAD) return fail('payload', `payload is ${p.length} bytes, over MeshCore's ${MAX_PACKET_PAYLOAD}-byte limit`, at + MAX_PACKET_PAYLOAD)

  const route = `${out.header.routeName}${out.hops ? `, ${out.hops} hop${out.hops === 1 ? '' : 's'}` : ''}`
  switch (payloadType) {
    case PayloadType.Advert:
      return decodeAdvert(out, p, at, options.verifySignatures ?? true, fail, route)
    case PayloadType.GroupText:
    case PayloadType.GroupData:
      return decodeGroup(out, p, at, channels, payloadType === PayloadType.GroupData, fail, route)
    case PayloadType.Request:
    case PayloadType.Response:
    case PayloadType.Text:
    case PayloadType.Path: {
      // dest hash, src hash, MAC, ciphertext (Mesh.cpp: needs more than the 4 header bytes)
      if (p.length > 0) out.addressed = { destHash: p[0] }
      if (p.length > 1) out.addressed!.srcHash = p[1]
      if (p.length <= 2 + CIPHER_MAC_SIZE) return fail('payload', `truncated: ${p.length} bytes, needs hashes, a MAC and ciphertext (5+)`, at + p.length)
      const ct = p.length - 2 - CIPHER_MAC_SIZE
      out.addressed = { destHash: p[0], srcHash: p[1], mac: toHex(p.subarray(2, 4)), ciphertextLength: ct }
      if (ct % CIPHER_BLOCK_SIZE) return fail('payload', `ciphertext is ${ct} bytes, not a multiple of ${CIPHER_BLOCK_SIZE}`, at + 4)
      out.summary = `${out.header.payloadName} ${hex2(p[1])} → ${hex2(p[0])}, encrypted ${ct} B · ${route}`
      return out
    }
    case PayloadType.AnonRequest: {
      if (p.length <= 1 + PUB_KEY_SIZE + CIPHER_MAC_SIZE) return fail('payload', `truncated: ${p.length} bytes, needs a hash, a public key, a MAC and ciphertext (36+)`, at + p.length)
      out.addressed = { destHash: p[0], mac: toHex(p.subarray(33, 35)), ciphertextLength: p.length - 35 }
      out.anonPublicKey = toHex(p.subarray(1, 33))
      out.summary = `anon-request → ${hex2(p[0])} from ${out.anonPublicKey.slice(0, 8)}… · ${route}`
      return out
    }
    case PayloadType.Ack: {
      if (p.length < 4) return fail('payload', `truncated: ack is ${p.length} bytes, needs 4`, at + p.length)
      out.ackChecksum = toHex(p.subarray(0, 4))
      out.summary = `ack ${out.ackChecksum} · ${route}`
      return out
    }
    default:
      out.summary = `${out.header.payloadName}, ${p.length} B · ${route}`
      return out
  }
}

type Fail = (stage: DecodeStage, reason: string, offset: number) => MeshDecode

function decodeAdvert(out: MeshDecode, p: Uint8Array, at: number, verify: boolean, fail: Fail, route: string): MeshDecode {
  const a: Partial<Advert> = {}
  out.advert = a
  if (p.length >= PUB_KEY_SIZE) a.publicKey = toHex(p.subarray(0, PUB_KEY_SIZE))
  if (p.length >= PUB_KEY_SIZE + 4) a.timestamp = u32(p, PUB_KEY_SIZE)
  const fixed = PUB_KEY_SIZE + 4 + SIGNATURE_SIZE
  if (p.length < fixed) return fail('advert', `truncated: advert is ${p.length} bytes, key + timestamp + signature need ${fixed}`, at + p.length)
  a.signature = toHex(p.subarray(PUB_KEY_SIZE + 4, fixed))
  const app = p.subarray(fixed)
  const appAt = at + fixed
  if (app.length > 0) {
    const flags = app[0]
    a.flags = flags
    a.type = flags & AdvFlag.TypeMask
    a.typeName = ADV_TYPE_NAMES[a.type] ?? `type ${a.type}`
    a.hasLocation = (flags & AdvFlag.LatLon) !== 0
    let i = 1
    if (a.hasLocation) {
      if (app.length < i + 8) return fail('advert', `truncated: flags say there's a location but only ${app.length - i} of 8 bytes follow`, appAt + app.length)
      const lat = i32(app, i) / 1e6
      const lon = i32(app, i + 4) / 1e6
      if (Math.abs(lat) > 90) return fail('advert', `latitude ${lat} is out of range`, appAt + i)
      if (Math.abs(lon) > 180) return fail('advert', `longitude ${lon} is out of range`, appAt + i + 4)
      a.lat = lat
      a.lon = lon
      i += 8
    }
    for (const feat of [AdvFlag.Feat1, AdvFlag.Feat2]) {
      if (!(flags & feat)) continue
      if (app.length < i + 2) return fail('advert', `truncated: flags say there's a feature field but only ${app.length - i} of 2 bytes follow`, appAt + app.length)
      i += 2
    }
    if (flags & AdvFlag.Name) {
      const name = text(app.subarray(i))
      if (name === null) return fail('advert', 'name is not valid UTF-8', appAt + i)
      a.name = name
    }
  }
  if (verify) {
    const message = new Uint8Array(PUB_KEY_SIZE + 4 + Math.min(app.length, MAX_ADVERT_DATA_SIZE))
    message.set(p.subarray(0, PUB_KEY_SIZE + 4))
    message.set(app.subarray(0, MAX_ADVERT_DATA_SIZE), PUB_KEY_SIZE + 4)
    let ok = false
    let why = "Ed25519 signature doesn't match the key and contents"
    try {
      ok = ed25519.verify(p.subarray(PUB_KEY_SIZE + 4, fixed), message, p.subarray(0, PUB_KEY_SIZE))
    } catch (err) {
      why = `signature can't be checked: ${err instanceof Error ? err.message : err}`
    }
    a.signatureValid = ok
    if (!ok) return fail('signature', why, at + PUB_KEY_SIZE + 4)
  }
  const where = a.hasLocation ? ` @ ${a.lat!.toFixed(4)}, ${a.lon!.toFixed(4)}` : ''
  out.summary = `advert ${a.name ? `“${a.name}”` : `(no name) ${a.publicKey!.slice(0, 8)}…`} ${a.typeName ?? ''}${where} · ${route}`
  return out
}

function decodeGroup(out: MeshDecode, p: Uint8Array, at: number, channels: Channel[], isData: boolean, fail: Fail, route: string): MeshDecode {
  const g: Partial<GroupMessage> = {}
  out.group = g
  if (p.length > 0) g.channelHash = p[0]
  // Mesh.cpp: channel hash, MAC, and at least one byte of ciphertext
  if (p.length <= 1 + CIPHER_MAC_SIZE) return fail('payload', `truncated: ${p.length} bytes, needs a channel hash, a MAC and ciphertext (4+)`, at + p.length)
  const mac = p.subarray(1, 3)
  const ct = p.subarray(3)
  g.mac = toHex(mac)
  const candidates = channels.filter((c) => c.hash === p[0])
  if (!candidates.length) {
    out.failure = { stage: 'channel', reason: `no key for channel hash ${hex2(p[0])}`, offset: at }
    out.status = 'no-key'
    out.summary = `${out.header!.payloadName} on unknown channel ${hex2(p[0])}, ${ct.length} B encrypted · ${route}`
    return out
  }
  if (ct.length % CIPHER_BLOCK_SIZE) return fail('decrypt', `ciphertext is ${ct.length} bytes, not a multiple of ${CIPHER_BLOCK_SIZE}`, at + 3)
  const channel = candidates.find((c) => {
    const m = channelMac(c.secret, ct)
    return m[0] === mac[0] && m[1] === mac[1]
  })
  if (!channel) {
    const names = candidates.map((c) => `${c.name} (${toHex(channelMac(c.secret, ct))})`).join(', ')
    return fail('mac', `MAC ${g.mac} doesn't match the ${names} key; corrupt, or another channel with the same hash`, at + 1)
  }
  g.channel = channel.name
  let plain: Uint8Array
  try {
    plain = aesEcbDecrypt(channel.secret, ct)
  } catch (err) {
    return fail('decrypt', `AES failed: ${err instanceof Error ? err.message : err}`, at + 3)
  }
  if (isData) {
    if (plain.length < 3) return fail('decrypt', `plaintext is ${plain.length} bytes, needs a data type and length`, at + 3)
    g.dataType = u16(plain, 0)
    const len = plain[2]
    if (len > plain.length - 3) return fail('decrypt', `data length ${len} is longer than the ${plain.length - 3} bytes decrypted`, at + 3)
    g.data = toHex(plain.subarray(3, 3 + len))
    out.summary = `group-data on ${channel.name}: type ${hex2(g.dataType)}, ${len} B · ${route}`
    return out
  }
  if (plain.length < 5) return fail('decrypt', `plaintext is ${plain.length} bytes, needs a timestamp and flags`, at + 3)
  g.timestamp = u32(plain, 0)
  g.flags = plain[4]
  const t = text(plain.subarray(5))
  if (t === null) return fail('decrypt', 'decrypted text is not valid UTF-8', at + 3)
  g.text = t
  const { sender, body } = splitChannelText(t)
  g.sender = sender
  g.body = body
  out.summary = `${channel.name}: ${t} · ${route}`
  return out
}
