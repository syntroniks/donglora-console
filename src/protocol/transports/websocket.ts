// WebSocket transport: the DongLoRa byte stream relayed by the console server's /ws endpoint (server/),
// which gives each connection its own donglora-mux session. Runs in the browser and in Node 22+, which
// has a global WebSocket.

import type { Transport, TransportSink } from '../client.ts'

/** How long close() waits for the server's close frame before giving up on it. */
const CLOSE_WAIT_MS = 1000

export class WebSocketTransport implements Transport {
  readonly label: string
  private readonly url: string
  private ws: WebSocket | null = null
  private closing = false

  constructor(url: string) {
    this.url = url
    this.label = `server ${url}`
  }

  open(sink: TransportSink): Promise<void> {
    this.closing = false
    return new Promise((resolve, reject) => {
      let opened = false
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        opened = true
        this.ws = ws
        resolve()
      }
      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) sink.onData(new Uint8Array(e.data))
      }
      ws.onclose = (e: CloseEvent) => {
        this.ws = null
        // a refused upgrade (wrong origin, no dongle) closes before open, with code 1006 and no reason
        if (!opened) return reject(new Error(`couldn't connect to ${this.url}${e.reason ? `: ${e.reason}` : ''}`))
        if (!this.closing) sink.onClose(new Error(e.reason || `the server closed the connection (code ${e.code})`))
      }
    })
  }

  write(data: Uint8Array): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected to the server'))
    ws.send(data as Uint8Array<ArrayBuffer>) // the client builds frames on plain ArrayBuffers
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closing = true
    const ws = this.ws
    if (!ws) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, CLOSE_WAIT_MS)
      ws.addEventListener('close', done, { once: true })
      ws.close(1000)
    })
  }
}
