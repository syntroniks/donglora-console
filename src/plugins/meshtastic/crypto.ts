// Meshtastic channel crypto (firmware src/mesh/CryptoEngine.cpp, Channels.cpp): AES-CTR with the expanded
// channel key, no MAC. The counter block is the packet id as a u64 LE, then the sender's node number as a u32
// LE, then a zero 32-bit counter. Anyone with the key can forge a packet, so nothing decrypted is authenticated.

import { ctr } from '@noble/ciphers/aes.js'
import { MODEM_PRESETS } from './presets.ts'

/** PSK index 1, "AQ==": what every default channel uses */
export const DEFAULT_PSK = Uint8Array.of(0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01)

export interface MeshtasticChannel {
  name: string
  /** 16 bytes (AES-128), 32 (AES-256), or empty for an unencrypted channel */
  key: Uint8Array
  hash: number
}

/**
 * A channel's PSK as configured to the key the radio uses (Channels::getKey): one byte is an index, 0 meaning
 * no encryption and N the default key with N - 1 added to its last byte; short keys are zero-padded.
 */
export function expandPsk(psk: Uint8Array): Uint8Array {
  if (psk.length === 0) return psk
  if (psk.length === 1) {
    if (psk[0] === 0) return new Uint8Array(0)
    const k = DEFAULT_PSK.slice()
    k[15] = (k[15] + psk[0] - 1) & 0xff
    return k
  }
  if (psk.length > 32) throw new RangeError(`PSK is ${psk.length} bytes, the most is 32`)
  const out = new Uint8Array(psk.length <= 16 ? 16 : 32)
  out.set(psk)
  return out
}

const xorBytes = (b: Uint8Array) => b.reduce((a, c) => a ^ c, 0)

/** The byte in every packet header that says which channel it's on: XOR of the name's bytes and the key's. */
export function channelHash(name: string, key: Uint8Array): number {
  return xorBytes(new TextEncoder().encode(name)) ^ xorBytes(key)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** psk as the apps show it (base64, eg. 'AQ==') or raw bytes */
export function makeChannel(name: string, psk: Uint8Array | string = 'AQ=='): MeshtasticChannel {
  const key = expandPsk(typeof psk === 'string' ? fromBase64(psk) : psk)
  return { name, key, hash: channelHash(name, key) }
}

/** Each modem preset's unnamed primary channel with the default key; their names differ, so do their hashes. */
export const DEFAULT_CHANNELS: MeshtasticChannel[] = Object.values(MODEM_PRESETS).map((m) => makeChannel(m.name))

export function meshtasticNonce(packetId: number, from: number): Uint8Array {
  const n = new Uint8Array(16)
  const v = new DataView(n.buffer)
  v.setUint32(0, packetId >>> 0, true)
  v.setUint32(8, from >>> 0, true)
  return n
}

/** Encrypts and decrypts alike. An empty key means the channel is unencrypted, so the bytes pass through. */
export function aesCtr(key: Uint8Array, packetId: number, from: number, data: Uint8Array): Uint8Array {
  if (key.length === 0) return data.slice()
  if (key.length !== 16 && key.length !== 32) throw new RangeError(`key is ${key.length} bytes, Meshtastic uses 16 or 32`)
  if (data.length === 0) return new Uint8Array(0)
  return ctr(key, meshtasticNonce(packetId, from)).encrypt(data)
}
