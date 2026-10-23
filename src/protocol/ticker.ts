// Repeating timers for the keepalive. Browsers throttle main-thread timers in background tabs (to
// once a second, or once a minute after a while), which would let the device's 1000 ms inactivity
// timer fire. Timers inside a dedicated Worker aren't throttled that way, so in a browser the tick
// comes from a tiny inline Worker. Node (scripts, tests) has no Worker global and uses setInterval.

export interface Ticker {
  stop(): void
}

export type TickerFactory = (ms: number, fn: () => void) => Ticker

export const intervalTicker: TickerFactory = (ms, fn) => {
  const t = setInterval(fn, ms)
  return { stop: () => clearInterval(t) }
}

const WORKER_SOURCE = 'let t; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data) }'

export const workerTicker: TickerFactory = (ms, fn) => {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  const worker = new Worker(url)
  worker.onmessage = () => fn()
  worker.postMessage(ms)
  return {
    stop: () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    },
  }
}

export const defaultTicker: TickerFactory = (ms, fn) => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return intervalTicker(ms, fn)
  try {
    return workerTicker(ms, fn)
  } catch {
    return intervalTicker(ms, fn) // eg. a CSP that forbids blob: workers
  }
}
