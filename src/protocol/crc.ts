// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no xor-out), PROTOCOL.md §2.2 and
// Appendix B. Check value for "123456789" is 0x29B1.

const TABLE = (() => {
  const t = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 8
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1
    t[i] = c & 0xffff
  }
  return t
})()

export function crc16(data: Uint8Array): number {
  let crc = 0xffff
  for (const b of data) crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ b) & 0xff]) & 0xffff
  return crc
}
