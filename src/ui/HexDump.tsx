export interface HexRegion {
  from: number
  to: number // exclusive
  className: string
  label: string
}

/** 16 bytes a row with offsets and ASCII. Regions tint byte ranges; `mark` outlines the byte where decoding failed. */
export function HexDump({ bytes, regions = [], mark }: { bytes: Uint8Array; regions?: HexRegion[]; mark?: number }) {
  const rows: number[] = []
  for (let i = 0; i < Math.max(bytes.length, 1); i += 16) rows.push(i)
  const classOf = (i: number) => {
    const r = regions.find((x) => i >= x.from && i < x.to)
    return `${r?.className ?? ''}${i === mark ? ' hex-mark' : ''}`
  }
  // a failure at the end of the bytes ("truncated") gets a marker cell past the last byte
  const markPastEnd = mark !== undefined && mark >= bytes.length
  return (
    <div className="hexdump">
      {regions.length > 0 && (
        <div className="hex-legend">
          {regions.map((r) => (
            <span key={r.label} className={r.className}>{r.label}</span>
          ))}
          {mark !== undefined && <span className="hex-mark">failed here</span>}
        </div>
      )}
      {rows.map((start) => {
        const row = Array.from(bytes.subarray(start, start + 16))
        const last = start + 16 >= bytes.length
        return (
          <div className="hex-row" key={start}>
            <span className="hex-off">{start.toString(16).padStart(4, '0')}</span>
            <span className="hex-bytes">
              {row.map((b, j) => (
                <span key={j} className={classOf(start + j)} title={`byte ${start + j}`}>
                  {b.toString(16).padStart(2, '0')}
                </span>
              ))}
              {last && markPastEnd && row.length < 16 && <span className="hex-mark hex-end" title={`byte ${mark}: the packet ended here`}>··</span>}
            </span>
            <span className="hex-ascii">{row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}</span>
          </div>
        )
      })}
      {markPastEnd && bytes.length % 16 === 0 && (
        <div className="hex-row">
          <span className="hex-off">{bytes.length.toString(16).padStart(4, '0')}</span>
          <span className="hex-bytes"><span className="hex-mark hex-end" title={`byte ${mark}: the packet ended here`}>··</span></span>
        </div>
      )}
    </div>
  )
}
