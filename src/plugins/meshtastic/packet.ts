// The Meshtastic packet on the air (firmware src/mesh/RadioInterface.h PacketHeader): a 16-byte clear header,
// then the channel-encrypted protobuf Data message (mesh.proto). Building packets is for tests and the
// simulated dongle; the console itself only listens.

import { expandPsk, aesCtr } from './crypto.ts'
import { ProtoError, ProtoReader, ProtoWriter, WireType } from './proto.ts'

export const HEADER_LEN = 16
export const BROADCAST = 0xffffffff

export const HeaderFlag = { HopLimitMask: 0x07, WantAck: 0x08, ViaMqtt: 0x10, HopStartShift: 5 } as const

export interface MeshtasticHeader {
  to: number
  from: number
  id: number
  flags: number
  hopLimit: number
  wantAck: boolean
  viaMqtt: boolean
  /** 0 from firmware before 2.3, which didn't send it */
  hopStart: number
  /** channel hash */
  channel: number
  /** last byte of the node id the sender wants to relay this; 0 when unset (firmware before 2.6 or flooding) */
  nextHop: number
  /** last byte of the node id that transmitted this copy */
  relayNode: number
}

export const nodeId = (n: number): string => `!${(n >>> 0).toString(16).padStart(8, '0')}`

/** Hops taken so far, when the sender said how many it started with. */
export function hopsTaken(h: MeshtasticHeader): number | undefined {
  if (!h.hopStart || h.hopStart < h.hopLimit) return undefined
  return h.hopStart - h.hopLimit
}

/** raw must hold at least HEADER_LEN bytes */
export function parseHeader(raw: Uint8Array): MeshtasticHeader {
  const v = new DataView(raw.buffer, raw.byteOffset, HEADER_LEN)
  const flags = raw[12]
  return {
    to: v.getUint32(0, true),
    from: v.getUint32(4, true),
    id: v.getUint32(8, true),
    flags,
    hopLimit: flags & HeaderFlag.HopLimitMask,
    wantAck: (flags & HeaderFlag.WantAck) !== 0,
    viaMqtt: (flags & HeaderFlag.ViaMqtt) !== 0,
    hopStart: flags >> HeaderFlag.HopStartShift,
    channel: raw[13],
    nextHop: raw[14],
    relayNode: raw[15],
  }
}

export interface HeaderInit {
  to: number
  from: number
  id: number
  hopLimit: number
  hopStart: number
  channel: number
  wantAck?: boolean
  viaMqtt?: boolean
  nextHop?: number
  relayNode?: number
}

export function encodeHeader(h: HeaderInit): Uint8Array {
  const out = new Uint8Array(HEADER_LEN)
  const v = new DataView(out.buffer)
  v.setUint32(0, h.to >>> 0, true)
  v.setUint32(4, h.from >>> 0, true)
  v.setUint32(8, h.id >>> 0, true)
  out[12] = (h.hopLimit & 7) | (h.wantAck ? HeaderFlag.WantAck : 0) | (h.viaMqtt ? HeaderFlag.ViaMqtt : 0) | ((h.hopStart & 7) << HeaderFlag.HopStartShift)
  out[13] = h.channel
  out[14] = h.nextHop ?? 0
  // the firmware sets relay_node to its own last byte when it transmits
  out[15] = h.relayNode ?? h.from & 0xff
  return out
}

export interface MeshtasticData {
  portnum: number
  payload: Uint8Array
  /** where payload starts, in the packet: CTR keeps plaintext and ciphertext byte positions the same */
  payloadOffset: number
  wantResponse?: boolean
  dest?: number
  source?: number
  requestId?: number
  replyId?: number
  /** nonzero: the text is an emoji reaction to replyId */
  emoji?: number
  /** bit 0: the sender is OK with this going to MQTT */
  bitfield?: number
}

/**
 * Parses a decrypted Data message; `base` is where it starts in the packet, for error offsets. Like the
 * firmware (Router.cpp perhapsDecode), a parse error or a missing portnum means the key was wrong.
 */
export function parseData(plain: Uint8Array, base = HEADER_LEN): MeshtasticData {
  const r = new ProtoReader(plain, base)
  const d: MeshtasticData = { portnum: 0, payload: new Uint8Array(0), payloadOffset: base }
  for (let t = r.tag(); t; t = r.tag()) {
    switch (t.field) {
      case 1:
        r.expect(t, WireType.Varint)
        d.portnum = r.int32()
        break
      case 2: {
        r.expect(t, WireType.Len)
        const { bytes, at } = r.len()
        d.payload = bytes.slice()
        d.payloadOffset = at
        break
      }
      case 3:
        r.expect(t, WireType.Varint)
        d.wantResponse = r.bool()
        break
      case 4:
      case 5:
      case 6:
      case 7:
      case 8: {
        r.expect(t, WireType.Fixed32)
        const v = r.fixed32()
        if (t.field === 4) d.dest = v
        else if (t.field === 5) d.source = v
        else if (t.field === 6) d.requestId = v
        else if (t.field === 7) d.replyId = v
        else d.emoji = v
        break
      }
      case 9:
        r.expect(t, WireType.Varint)
        d.bitfield = r.uint32()
        break
      default:
        r.skip(t.wire)
    }
  }
  if (d.portnum === 0) throw new ProtoError('no portnum (UNKNOWN_APP)', base)
  return d
}

export type DataInit = Omit<MeshtasticData, 'payloadOffset'>

export function encodeData(d: DataInit): Uint8Array {
  const w = new ProtoWriter().varint(1, d.portnum)
  if (d.payload.length) w.bytes(2, d.payload)
  if (d.wantResponse) w.bool(3, true)
  if (d.dest) w.fixed32(4, d.dest)
  if (d.source) w.fixed32(5, d.source)
  if (d.requestId) w.fixed32(6, d.requestId)
  if (d.replyId) w.fixed32(7, d.replyId)
  if (d.emoji) w.fixed32(8, d.emoji)
  if (d.bitfield !== undefined) w.varint(9, d.bitfield)
  return w.toBytes()
}

export interface PacketInit extends HeaderInit, Partial<Omit<DataInit, 'portnum' | 'payload'>> {
  /** the channel key, or a PSK as configured (a 1-byte index expands to the default key) */
  key: Uint8Array
  portnum: number
  payload: Uint8Array
}

/** Header + encrypted Data, as a Meshtastic radio would transmit it. */
export function encodeMeshtasticPacket(p: PacketInit): Uint8Array {
  const { to, from, id, hopLimit, hopStart, channel, wantAck, viaMqtt, nextHop, relayNode, key, ...data } = p
  const header = encodeHeader({ to, from, id, hopLimit, hopStart, channel, wantAck, viaMqtt, nextHop, relayNode })
  const body = aesCtr(expandPsk(key), id, from, encodeData(data))
  const out = new Uint8Array(HEADER_LEN + body.length)
  out.set(header)
  out.set(body, HEADER_LEN)
  return out
}
