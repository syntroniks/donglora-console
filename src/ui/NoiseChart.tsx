import type { NoisePoint } from './store.ts'

const W = 640
const H = 170
const PAD = { l: 38, r: 8, t: 8, b: 18 }

/** Packet RSSI and noise over time, plain SVG. */
export function NoiseChart({ points }: { points: NoisePoint[] }) {
  if (points.length < 2) return <p className="empty">The chart starts after two packets.</p>
  const t0 = points[0].at
  const t1 = Math.max(points[points.length - 1].at, t0 + 1000)
  const values = points.flatMap((p) => [p.rssi, p.noise, p.floor, p.median].filter((v): v is number => v !== undefined))
  const lo = Math.floor((Math.min(...values) - 3) / 10) * 10
  const hi = Math.ceil((Math.max(...values) + 3) / 10) * 10
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b)
  const line = (key: 'median' | 'floor') => {
    const pts = points.filter((p) => p[key] !== undefined)
    // step line: the value holds until the next update
    return pts.map((p, i) => `${i ? 'H' : 'M'}${x(p.at).toFixed(1)} ${i ? `V${y(p[key]!).toFixed(1)}` : y(p[key]!).toFixed(1)}`).join(' ') + (pts.length ? ` H${x(t1).toFixed(1)}` : '')
  }
  const grid: number[] = []
  for (let v = lo; v <= hi; v += 10) grid.push(v)
  const mins = (t1 - t0) / 60000
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="noise floor and packet RSSI over time">
        {grid.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="chart-label" x={PAD.l - 4} y={y(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        <text className="chart-label" x={PAD.l} y={H - 4}>−{mins < 1 ? `${Math.round(mins * 60)} s` : `${mins.toFixed(mins < 10 ? 1 : 0)} min`}</text>
        <text className="chart-label" x={W - PAD.r} y={H - 4} textAnchor="end">now</text>
        <path className="chart-median" d={line('median')} />
        <path className="chart-floor" d={line('floor')} />
        {points.map((p, i) => (
          <g key={i}>
            {p.noise !== undefined && <circle className="chart-noise" cx={x(p.at)} cy={y(p.noise)} r={2} />}
            <circle className={p.crcValid ? 'chart-rssi' : 'chart-rssi-bad'} cx={x(p.at)} cy={y(p.rssi)} r={2.6} />
          </g>
        ))}
      </svg>
      <div className="chart-legend">
        <span className="lg-rssi">packet RSSI</span>
        <span className="lg-rssi-bad">RSSI, CRC fail</span>
        <span className="lg-noise">noise under packet</span>
        <span className="lg-median">rolling median</span>
        <span className="lg-floor">floor (MeshCore method)</span>
        <span className="muted">dBm</span>
      </div>
    </div>
  )
}
