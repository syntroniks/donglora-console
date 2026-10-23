// node-serialport transport, for scripts that talk to a dongle outside the browser.

import { SerialPort } from 'serialport'
import type { Transport, TransportSink } from '../src/protocol/client.ts'

export class NodeSerialTransport implements Transport {
  readonly label: string
  private readonly path: string
  private port: SerialPort | null = null

  constructor(path: string) {
    this.path = path
    this.label = path
  }

  open(sink: TransportSink): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: 115200, lock: true }, (err) => {
        if (err) return reject(err)
        // The firmware treats DTR as "host present". Linux raises DTR on open already; set() also
        // touches break control, which CDC-ACM devices may refuse, so its failure isn't fatal.
        port.set({ dtr: true }, () => resolve())
      })
      port.on('data', (chunk: Buffer) => sink.onData(new Uint8Array(chunk)))
      port.on('close', () => sink.onClose())
      port.on('error', (err: Error) => sink.onError?.(err))
      this.port = port
    })
  }

  write(data: Uint8Array): Promise<void> {
    const port = this.port
    if (!port) return Promise.reject(new Error('port not open'))
    return new Promise((resolve, reject) => {
      port.write(Buffer.from(data), (err) => (err ? reject(err) : port.drain(() => resolve())))
    })
  }

  close(): Promise<void> {
    const port = this.port
    this.port = null
    if (!port?.isOpen) return Promise.resolve()
    return new Promise((resolve) => port.set({ dtr: false }, () => port.close(() => resolve())))
  }
}

/** DongLoRa's own USB id first, then USB-UART bridges some boards use (client-py discovery.py). */
export const DONGLORA_USB_IDS = ['1209:5741', '10c4:ea60', '1a86:55d4', '1a86:7522', '1a86:7523', '0403:6001']

export interface FoundPort {
  path: string
  usbId: string
  serialNumber?: string
}

/** Serial ports that are DongLoRa dongles by USB VID:PID, native first. Nothing else is ever returned. */
export async function findDongles(): Promise<FoundPort[]> {
  const found: FoundPort[] = []
  for (const p of await SerialPort.list()) {
    const usbId = `${p.vendorId ?? ''}:${p.productId ?? ''}`.toLowerCase()
    if (DONGLORA_USB_IDS.includes(usbId)) found.push({ path: p.path, usbId, serialNumber: p.serialNumber })
  }
  return found.sort((a, b) => DONGLORA_USB_IDS.indexOf(a.usbId) - DONGLORA_USB_IDS.indexOf(b.usbId))
}
