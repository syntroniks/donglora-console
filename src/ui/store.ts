// The page's radio store, held outside React so that StrictMode double effects and Fast Refresh remounts
// can't open a second port or orphan the first. Components read it with useRadio().
// There is one store per page, kept on globalThis: a hot update of this module (or of anything it
// imports) keeps the instance, with its client, port and subscribers, and gives it the new code.

import { MockDongLoRaTransport } from '../protocol/transports/mock.ts'
import { waitForPortReturn, WebSerialTransport } from '../protocol/transports/webserial.ts'
import { WebSocketTransport } from '../protocol/transports/websocket.ts'
import { RadioStore } from '../radio/store.ts'

export * from '../radio/store.ts'

/** What GET /api/server on the console server answers. */
interface ServerFacts {
  allowTx: boolean
}

/** The console server's HTTP base for a /ws URL: ws://host:5742/ws -> http://host:5742 */
export const serverHttpBase = (wsUrl: string): string => {
  const u = new URL(wsUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = u.pathname.replace(/\/ws\/?$/, '')
  u.search = ''
  return u.toString().replace(/\/$/, '')
}

/** Where the console server is: this page's own origin when the server (or Vite's proxy) serves it, else localhost. */
export function defaultServerUrl(): string {
  const saved = localStorage.getItem(SERVER_URL_KEY)
  if (saved) return saved
  if (location.hostname.endsWith('github.io')) return 'ws://localhost:5742/ws'
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
}

const SERVER_URL_KEY = 'donglora-console.serverUrl'
const SENDER_KEY = 'donglora-console.sender'

/** The name messages are sent as (Messages view, /say, scripts' radio.say), kept in this browser. */
export const savedSender = (): string => localStorage.getItem(SENDER_KEY) ?? ''
export const saveSender = (name: string): void => localStorage.setItem(SENDER_KEY, name.trim())

/** How long to wait for a dongle that dropped off the bus (a replug, or the board resetting) before giving up. */
const RETURN_WAIT_MS = 30_000

export class ConsoleStore extends RadioStore {
  /** The port the user picked, kept so it can be reopened when the dongle comes back. */
  private serialPort: SerialPort | undefined
  private waitingForPort: AbortController | undefined

  /** Must run synchronously inside the click handler: WebSerial's port picker needs the user gesture. */
  connectSerial(): Promise<void> {
    this.patch({ txBlocked: undefined })
    return this.connectTransport(
      WebSerialTransport.request().then((t) => {
        this.serialPort = t.serialPort
        return t
      }),
    )
  }

  /**
   * The dongle vanished from USB: its firmware reset the MCU to recover a wedged radio, or it was unplugged.
   * The browser keeps the permission for the port, so when the device is back, open it again and carry on
   * with the same config, no click needed.
   */
  protected override onConnectionLost(_err: Error): void {
    const port = this.serialPort
    if (!port || this.state.demo) return
    this.waitingForPort?.abort()
    const wait = (this.waitingForPort = new AbortController())
    this.log('waiting for the dongle to come back', 'info')
    void waitForPortReturn(port, RETURN_WAIT_MS, wait.signal).then(async (back) => {
      if (this.waitingForPort === wait) this.waitingForPort = undefined
      if (wait.signal.aborted) return
      if (!back) return this.log('the dongle did not come back; connect again', 'warn')
      // the user may have connected something else in the meantime
      if (this.client || this.state.status !== 'disconnected') return
      this.log('the dongle is back; reconnecting')
      await this.connectTransport(new WebSerialTransport(back))
    })
  }

  override async disconnect(): Promise<void> {
    this.waitingForPort?.abort() // a deliberate disconnect ends any wait for the dongle
    this.waitingForPort = undefined
    await super.disconnect()
  }

  connectDemo(): Promise<void> {
    this.patch({ txBlocked: undefined })
    return this.connectTransport(new MockDongLoRaTransport({ traffic: true, failures: true, linkFaults: true }), true)
  }

  /** Through the console server (server/), which shares the dongle with other programs via donglora-mux. */
  async connectServer(wsUrl: string): Promise<void> {
    localStorage.setItem(SERVER_URL_KEY, wsUrl)
    let facts: ServerFacts | undefined
    try {
      const res = await fetch(`${serverHttpBase(wsUrl)}/api/server`)
      if (res.ok) facts = (await res.json()) as ServerFacts
    } catch {
      // an older server, or a proxy that only passes /ws; the server still refuses TX itself
    }
    this.patch({ txBlocked: facts && !facts.allowTx ? 'the console server was started without --allow-tx, so it refuses TX' : undefined })
    return this.connectTransport(new WebSocketTransport(wsUrl))
  }
}

const g = globalThis as typeof globalThis & { __dongloraStore?: ConsoleStore }

function singleton(): ConsoleStore {
  const prev = g.__dongloraStore
  if (!prev) return (g.__dongloraStore = new ConsoleStore())
  // Vite re-ran this module: keep the live instance, give it this version's methods. Listeners the client
  // holds call through `this`, so they reach the new methods too.
  Object.setPrototypeOf(prev, ConsoleStore.prototype)
  prev.upgrade()
  return prev
}

export const store = singleton()
