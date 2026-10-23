export function duration(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${Math.floor(secs % 60)}s`
  return `${Math.floor(secs)}s`
}

/** Time since a Date.now() value. */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const diff = (now - ms) / 1000
  if (diff < 2) return 'just now'
  return `${duration(diff)} ago`
}

export function coords(lat: number, lon: number): string {
  if (!lat && !lon) return 'not set'
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

export function shortKey(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`
}

export function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false })
}

export const dbm = (v: number) => `${v.toFixed(1)} dBm`
export const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
export const hz = (v: number) => `${v > 0 ? '+' : ''}${v} Hz`
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
