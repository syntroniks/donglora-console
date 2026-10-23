import type { MeasuredPoint, NoisePoint } from './store.ts'

const W = 640
const H = 170
const PAD = { l: 38, r: 8, t: 8, b: 18 }
/** a pause this long in measured samples (RX stopped, disconnected) breaks their line */
const MEASURED_GAP_MS = 3000

/** Packet RSSI, measured RSSI (RADIO_STATUS) and noise over time, plain SVG. */
export function NoiseChart({ points, measured = [] }: { points: NoisePoint[]; measured?: MeasuredPoint[] }) {
  if (points.length + measured.length < 2) return <p className="empty">The chart starts after two samples.</p>
  const t0 = Math.min(points[0]?.at ?? Infinity, measured[0]?.at ?? Infinity)
  const t1 = Math.max(points[points.length - 1]?.at ?? 0, measured[measured.length - 1]?.at ?? 0, t0 + 1000)
  const values = [
    ...points.flatMap((p) => [p.rssi, p.noise, p.floor, p.median]),
    ...measured.flatMap((p) => [p.dbm, p.floor, p.median]),
  ].filter((v): v is number => v !== undefined)
  const lo = Math.floor((Math.min(...values) - 3) / 10) * 10
  const hi = Math.ceil((Math.max(...values) + 3) / 10) * 10
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b)
  // floor and median come with both packets and measured samples
  const steps = [...points, ...measured].sort((a, b) => a.at - b.at)
  const line = (key: 'median' | 'floor') => {
    const pts = steps.filter((p) => p[key] !== undefined)
    // step line: the value holds until the next update
    return pts.map((p, i) => `${i ? 'H' : 'M'}${x(p.at).toFixed(1)} ${i ? `V${y(p[key]!).toFixed(1)}` : y(p[key]!).toFixed(1)}`).join(' ') + (pts.length ? ` H${x(t1).toFixed(1)}` : '')
  }
  const measuredPath = measured
    .map((p, i) => `${i && p.at - measured[i - 1].at < MEASURED_GAP_MS ? 'L' : 'M'}${x(p.at).toFixed(1)} ${y(p.dbm).toFixed(1)}`)
    .join(' ')
  const grid: number[] = []
  for (let v = lo; v <= hi; v += 10) grid.push(v)
  const mins = (t1 - t0) / 60000
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="noise floor, measured RSSI and packet RSSI over time">
        {grid.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="chart-label" x={PAD.l - 4} y={y(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        <text className="chart-label" x={PAD.l} y={H - 4}>−{mins < 1 ? `${Math.round(mins * 60)} s` : `${mins.toFixed(mins < 10 ? 1 : 0)} min`}</text>
        <text className="chart-label" x={W - PAD.r} y={H - 4} textAnchor="end">now</text>
        {measured.length > 0 && <path className="chart-measured" d={measuredPath} />}
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
        {measured.length > 0 && <span className="lg-measured">RSSI now (RADIO_STATUS)</span>}
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
