// Consistent Overhead Byte Stuffing (Cheshire & Baker), as in PROTOCOL.md Appendix A. The output never
// contains 0x00, so a single 0x00 can mark the end of each frame on the wire.

export function cobsEncode(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length + Math.ceil(src.length / 254) + 1)
  let codeAt = 0
  let o = 1
  let code = 1
  for (const b of src) {
    if (b === 0) {
      out[codeAt] = code
      codeAt = o++
      code = 1
      continue
    }
    out[o++] = b
    if (++code === 0xff) {
      out[codeAt] = code
      codeAt = o++
      code = 1
    }
  }
  out[codeAt] = code
  return out.slice(0, o)
}

/** null when the input isn't valid COBS (a 0x00 inside, or a code byte pointing past the end). */
export function cobsDecode(src: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(src.length)
  let o = 0
  let i = 0
  while (i < src.length) {
    const code = src[i++]
    if (code === 0) return null
    const end = i + code - 1
    if (end > src.length) return null
    for (; i < end; i++) {
      if (src[i] === 0) return null
      out[o++] = src[i]
    }
    if (code !== 0xff && i < src.length) out[o++] = 0
  }
  return out.slice(0, o)
}
