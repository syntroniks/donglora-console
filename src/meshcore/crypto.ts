// MeshCore channel crypto (src/Utils.cpp encryptThenMAC / MACThenDecrypt): AES-128-ECB with the channel
// secret over zero-padded blocks, then HMAC-SHA256 keyed with the secret zero-padded to 32 bytes, over the
// ciphertext, truncated to 2 bytes and sent ahead of it. WebCrypto has no ECB, hence @noble.

import { ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex } from '../protocol/bytes.ts'
import { CIPHER_BLOCK_SIZE, CIPHER_MAC_SIZE, PUB_KEY_SIZE } from './codes.ts'

export interface Channel {
  name: string
  secret: Uint8Array // 16 bytes (128-bit key) or 32
  hash: number // first byte of sha256(secret)
}

export function makeChannel(name: string, secretHex: string): Channel {
  const secret = fromHex(secretHex)
  return { name, secret, hash: sha256(secret)[0] }
}

/** The default Public channel every MeshCore companion has (docs/companion_protocol.md). */
export const PUBLIC_CHANNEL = makeChannel('Public', '8b3387e9c5cdea6ac9e5edbaa115cd72')

function hmacKey(secret: Uint8Array): Uint8Array {
  const key = new Uint8Array(PUB_KEY_SIZE)
  key.set(secret.subarray(0, PUB_KEY_SIZE))
  return key
}

export function channelMac(secret: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, hmacKey(secret), ciphertext).slice(0, CIPHER_MAC_SIZE)
}

export function aesEcbDecrypt(secret: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return ecb(secret.subarray(0, 16), { disablePadding: true }).decrypt(ciphertext)
}

/** MAC + ciphertext, as the firmware's encryptThenMAC writes it. */
export function encryptThenMac(secret: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(plaintext.length / CIPHER_BLOCK_SIZE) * CIPHER_BLOCK_SIZE)
  padded.set(plaintext)
  const ciphertext = ecb(secret.subarray(0, 16), { disablePadding: true }).encrypt(padded)
  const out = new Uint8Array(CIPHER_MAC_SIZE + ciphertext.length)
  out.set(channelMac(secret, ciphertext))
  out.set(ciphertext, CIPHER_MAC_SIZE)
  return out
}
