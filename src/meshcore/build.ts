// Builds MeshCore packets the way the firmware does (Mesh.cpp createAdvert, createGroupDatagram), for
// the mock radio and tests.

import { ed25519 } from '@noble/curves/ed25519.js'
import { ByteWriter } from '../protocol/bytes.ts'
import { AdvFlag, PayloadType, PUB_KEY_SIZE } from './codes.ts'
import { encryptThenMac, type Channel } from './crypto.ts'

export interface PacketSpec {
  routeType?: number // default 1, flood
  payloadType: number
  version?: number
  transportCodes?: [number, number]
  hashSize?: number // 1-3
  path?: Uint8Array // hops * hashSize bytes
}

export function buildPacket(spec: PacketSpec, payload: Uint8Array): Uint8Array {
  const route = spec.routeType ?? 1
  const w = new ByteWriter().u8(((spec.version ?? 0) << 6) | (spec.payloadType << 2) | route)
  if (route === 0 || route === 3) {
    const [a, b] = spec.transportCodes ?? [0, 0]
    w.u16(a).u16(b)
  }
  const hashSize = spec.hashSize ?? 1
  const path = spec.path ?? new Uint8Array(0)
  w.u8(((hashSize - 1) << 6) | (path.length / hashSize))
  return w.bytes(path).bytes(payload).toBytes()
}

export interface AdvertSpec {
  secretKey: Uint8Array // Ed25519 seed, 32 bytes
  timestamp: number
  type: number // ADV_TYPE_*
  name?: string
  lat?: number
  lon?: number
}

export function advertAppData(a: Omit<AdvertSpec, 'secretKey' | 'timestamp'>): Uint8Array {
  const hasLoc = a.lat !== undefined && a.lon !== undefined
  const w = new ByteWriter().u8(a.type | (hasLoc ? AdvFlag.LatLon : 0) | (a.name ? AdvFlag.Name : 0))
  if (hasLoc) w.u32(Math.round(a.lat! * 1e6)).u32(Math.round(a.lon! * 1e6))
  if (a.name) w.string(a.name)
  return w.toBytes()
}

/** Advert payload: public key, timestamp, signature over key + timestamp + appdata, appdata. */
export function advertPayload(a: AdvertSpec): Uint8Array {
  const pub = ed25519.getPublicKey(a.secretKey)
  const app = advertAppData(a)
  const signed = new ByteWriter().bytes(pub).u32(a.timestamp).bytes(app.subarray(0, 32)).toBytes()
  const sig = ed25519.sign(signed, a.secretKey)
  return new ByteWriter().bytes(pub).u32(a.timestamp).bytes(sig).bytes(app).toBytes()
}

export const publicKeyOf = (secretKey: Uint8Array): Uint8Array => ed25519.getPublicKey(secretKey).slice(0, PUB_KEY_SIZE)

/** Group text payload: channel hash, MAC, ciphertext of timestamp + flags + "sender: text". */
export function groupTextPayload(channel: Channel, timestamp: number, text: string, flags = 0): Uint8Array {
  const plain = new ByteWriter().u32(timestamp).u8(flags).string(text).toBytes()
  return new ByteWriter().u8(channel.hash).bytes(encryptThenMac(channel.secret, plain)).toBytes()
}

export const groupTextPacket = (channel: Channel, timestamp: number, text: string, path?: Uint8Array) =>
  buildPacket({ payloadType: PayloadType.GroupText, path }, groupTextPayload(channel, timestamp, text))
