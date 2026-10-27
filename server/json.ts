// JSON for the API: bytes as lowercase hex, 64-bit values (the capability bitmap) as 0x-prefixed hex.

import { toHex } from '../src/protocol/bytes.ts'

const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`
  if (value instanceof Uint8Array) return toHex(value)
  return value
}

export const toJson = (value: unknown, pretty = false): string => JSON.stringify(value, replacer, pretty ? 2 : undefined)
