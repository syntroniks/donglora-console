// How the console server reaches the dongle: a donglora-mux socket, or a simulated dongle (--demo).
//
// Every user gets a connection of its own (the server's session and each /ws client), so mux does the
// sharing: it rewrites tags per client, keeps RX on while anyone wants it and locks the config to the
// first client that sets it. Only mux holds the serial port.

import { createConnection, type Socket } from 'node:net'
import type { Transport, TransportSink } from '../src/protocol/client.ts'
import { MOCK_INFO_1_6, MockDongLoRaTransport } from '../src/protocol/transports/mock.ts'

export interface Upstream {
  /** shown in logs and in GET /api/server */
  readonly label: string
  readonly demo: boolean
  /** a fresh connection; nothing is sent until the caller opens it */
  connect(): Transport
}

export type MuxTarget = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number }

/** Same lookup as donglora-client (client-rs connect.rs): $DONGLORA_MUX, then $XDG_RUNTIME_DIR, then /tmp. */
export function defaultMuxSocket(): string {
  if (process.env.DONGLORA_MUX) return process.env.DONGLORA_MUX
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/donglora/mux.sock`
  return '/tmp/donglora-mux.sock'
}

/** `tcp://host:port` or `host:port` for mux's --tcp listener, anything else is a Unix socket path. */
export function parseMuxTarget(s: string): MuxTarget {
  const m = /^(?:tcp:\/\/)?(\[[^\]]+\]|[^/:]+):(\d+)$/.exec(s)
  if (m) return { kind: 'tcp', host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) }
  return { kind: 'unix', path: s }
}

export const describeMuxTarget = (t: MuxTarget): string => (t.kind === 'unix' ? `mux ${t.path}` : `mux tcp://${t.host}:${t.port}`)

export class MuxSocketTransport implements Transport {
  readonly label: string
  private readonly target: MuxTarget
  private socket: Socket | null = null

  constructor(target: MuxTarget) {
    this.target = target
    this.label = describeMuxTarget(target)
  }

  open(sink: TransportSink): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = this.target
      const socket = t.kind === 'unix' ? createConnection(t.path) : createConnection(t.port, t.host)
      let opened = false
      socket.setNoDelay(true)
      socket.once('connect', () => {
        opened = true
        this.socket = socket
        resolve()
      })
      socket.on('data', (chunk: Buffer) => sink.onData(new Uint8Array(chunk)))
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (!opened) reject(new Error(connectHint(this.label, err)))
        else sink.onError?.(err)
      })
      socket.on('close', () => {
        this.socket = null
        if (opened) sink.onClose(new Error(`${this.label} closed the connection`))
      })
    })
  }

  write(data: Uint8Array): Promise<void> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error(`not connected to ${this.label}`))
    return new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(err) : resolve())))
  }

  close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return Promise.resolve()
    return new Promise((resolve) => socket.end(() => resolve()))
  }
}

function connectHint(label: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return `can't reach ${label} (${err.code}): is donglora-mux running?`
  return `can't reach ${label}: ${err.message}`
}

export const muxUpstream = (target: MuxTarget): Upstream => ({
  label: describeMuxTarget(target),
  demo: false,
  connect: () => new MuxSocketTransport(target),
})

/** A simulated firmware 1.6.0 dongle per connection, with traffic; for trying the server without hardware. */
export const demoUpstream = (): Upstream => ({
  label: 'demo dongle (simulated)',
  demo: true,
  connect: () => new MockDongLoRaTransport({ traffic: true, info: MOCK_INFO_1_6 }),
})
