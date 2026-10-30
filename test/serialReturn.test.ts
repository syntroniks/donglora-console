import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForPortReturn } from '../src/protocol/transports/webserial.ts'

// a stand-in for navigator.serial: an EventTarget that can announce ports
class FakeSerial extends EventTarget {}
const fakePort = (vendor = 0x1209, product = 0x5741) => Object.assign(new EventTarget(), { getInfo: () => ({ usbVendorId: vendor, usbProductId: product }) }) as unknown as SerialPort

const withSerial = (serial: FakeSerial) => Object.defineProperty(globalThis, 'navigator', { value: { serial }, configurable: true })
const announce = (serial: FakeSerial, port: SerialPort) => {
  const e = new Event('connect')
  Object.defineProperty(e, 'target', { value: port })
  serial.dispatchEvent(e)
}

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'navigator')
})

describe('waitForPortReturn', () => {
  it('resolves with the same port when it comes back', async () => {
    const serial = new FakeSerial()
    withSerial(serial)
    const port = fakePort()
    const p = waitForPortReturn(port, 1000)
    announce(serial, port)
    expect(await p).toBe(port)
  })

  it('takes a new port object with the same USB ids for the dongle, and ignores other devices', async () => {
    const serial = new FakeSerial()
    withSerial(serial)
    const old = fakePort()
    const p = waitForPortReturn(old, 1000)
    announce(serial, fakePort(0x10c4, 0xea60))
    const fresh = fakePort()
    announce(serial, fresh)
    expect(await p).toBe(fresh)
  })

  it('gives up after the timeout, and when aborted', async () => {
    vi.useFakeTimers()
    const serial = new FakeSerial()
    withSerial(serial)
    const timed = waitForPortReturn(fakePort(), 500)
    vi.advanceTimersByTime(500)
    expect(await timed).toBeUndefined()
    const ac = new AbortController()
    const aborted = waitForPortReturn(fakePort(), 500, ac.signal)
    ac.abort()
    expect(await aborted).toBeUndefined()
  })
})
