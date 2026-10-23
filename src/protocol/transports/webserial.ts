// WebSerial transport (Chrome / Edge on desktop). Needs a secure context: https or localhost.

import type { Transport, TransportSink } from '../client.ts'
import { USB_PRODUCT_ID, USB_VENDOR_ID } from '../codes.ts'

export const isWebSerialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator

/** DongLoRa's own USB id, then the USB-UART bridges some boards use (client-py discovery.py). */
const FILTERS: SerialPortFilter[] = [
  { usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID },
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP2102
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }, // CH9102
  { usbVendorId: 0x1a86, usbProductId: 0x7522 }, // CH340K
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
  { usbVendorId: 0x0403, usbProductId: 0x6001 }, // FT232R
]

// The open transport lives on globalThis so it survives this module being hot-replaced: a connect after
// a hot update closes whatever the old module instance left open instead of failing with "port is
// already open".
const g = globalThis as typeof globalThis & { __dongloraWebSerial?: WebSerialTransport }

export async function closeWebSerial(): Promise<void> {
  await g.__dongloraWebSerial?.close()
}

export class WebSerialTransport implements Transport {
  readonly label: string
  private readonly port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private loop: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()
  private closing = false

  constructor(port: SerialPort) {
    this.port = port
    const info = port.getInfo()
    this.label = info.usbVendorId !== undefined ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}` : 'serial port'
  }

  /** Ask the user to pick a port. Call it synchronously from a click handler (user gesture). */
  static async request(): Promise<WebSerialTransport> {
    if (!isWebSerialSupported()) throw new Error('this browser has no WebSerial (use Chrome or Edge on desktop)')
    const picked = navigator.serial.requestPort({ filters: FILTERS }) // before any await
    const port = await picked
    await closeWebSerial()
    return new WebSerialTransport(port)
  }

  async open(sink: TransportSink): Promise<void> {
    this.closing = false
    await this.port.open({ baudRate: 115200, bufferSize: 4096 })
    g.__dongloraWebSerial = this
    // the firmware treats DTR as "host present" (firmware/src/host/usb.rs); don't rely on the default
    await this.port.setSignals({ dataTerminalReady: true })
    this.loop = this.readLoop(sink)
  }

  private async readLoop(sink: TransportSink): Promise<void> {
    let fatal: Error | undefined
    // port.readable comes back after a recoverable error (overrun, framing, parity, break), and is null
    // once the device is gone, which ends the loop
    while (this.port.readable && !this.closing) {
      const reader = this.port.readable.getReader()
      this.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) sink.onData(value)
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (this.closing) break
        if (this.port.readable) sink.onError?.(new Error(`serial read error (${e.name}): bytes were lost, still reading`))
        else fatal = e // eg. NetworkError: the device was unplugged
      } finally {
        reader.releaseLock()
        this.reader = null
      }
    }
    if (!this.closing) sink.onClose(fatal ?? new Error('serial port closed'))
  }

  /** One write at a time: a second getWriter() while one is held throws "stream is locked". */
  write(data: Uint8Array): Promise<void> {
    const next = this.writing.then(async () => {
      const writable = this.port.writable
      if (!writable) throw new Error('port not writable')
      const writer = writable.getWriter()
      try {
        await writer.write(data)
      } finally {
        writer.releaseLock()
      }
    })
    this.writing = next.catch(() => {})
    return next
  }

  async close(): Promise<void> {
    if (this.closing) return this.loop ?? undefined
    this.closing = true
    try {
      await this.reader?.cancel()
    } catch {
      // already gone
    }
    await this.loop // the reader must be released before the port can close
    await this.writing
    try {
      await this.port.setSignals({ dataTerminalReady: false }) // tells the firmware the host left
    } catch {
      // unplugged
    }
    try {
      await this.port.close()
    } catch {
      // already closed, or unplugged
    }
    if (g.__dongloraWebSerial === this) g.__dongloraWebSerial = undefined
  }
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0')
