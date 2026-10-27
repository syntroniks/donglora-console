// /ws: relays the DongLoRa byte stream between one WebSocket client and its own upstream connection, so the
// console's normal client code runs over it unchanged.
//
// Frames from the client are decoded and re-encoded rather than passed through as bytes, so the relay can
// refuse TX when the server runs without --allow-tx. A refused TX gets ERR(EUNKNOWN_CMD) with its tag,
// which is also what mux answers for a command it won't forward. A corrupt frame gets the async
// ERR(EFRAME) the firmware would send.

import type { RawData, WebSocket } from 'ws'
import { ByteWriter } from '../src/protocol/bytes.ts'
import type { Transport } from '../src/protocol/client.ts'
import { ErrCode, MsgType } from '../src/protocol/codes.ts'
import { encodeFrame, FrameDecoder } from '../src/protocol/framing.ts'

export interface RelayOptions {
  allowTx: boolean
  log: (text: string) => void
}

const errFrame = (tag: number, code: number) => encodeFrame(MsgType.Err, tag, new ByteWriter().u16(code).toBytes())

/** A close reason has to fit in 123 bytes. */
const fit = (reason: string) => (Buffer.byteLength(reason) <= 123 ? reason : `${Buffer.from(reason).subarray(0, 120).toString()}...`)

export async function relay(ws: WebSocket, upstream: Transport, who: string, { allowTx, log }: RelayOptions): Promise<void> {
  let closed = false
  const close = (code: number, reason: string) => {
    if (closed) return
    closed = true
    ws.close(code, fit(reason))
    void upstream.close()
  }

  // hold client frames until the upstream is open; mux answers nothing before it has the socket anyway
  const queued: Uint8Array[] = []
  let ready = false
  const decoder = new FrameDecoder(() => {
    if (ws.readyState === ws.OPEN) ws.send(errFrame(0, ErrCode.Frame))
  })
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) return close(1003, 'binary DongLoRa frames only')
    for (const f of decoder.push(new Uint8Array(data as Buffer))) {
      if (f.type === MsgType.Tx && !allowTx) {
        log(`${who}: refused TX (tag ${f.tag}), server runs without --allow-tx`)
        ws.send(errFrame(f.tag, ErrCode.UnknownCmd))
        continue
      }
      const wire = encodeFrame(f.type, f.tag, f.payload)
      if (ready) upstream.write(wire).catch((err: Error) => close(1011, `upstream write failed: ${err.message}`))
      else queued.push(wire)
    }
  })
  ws.on('close', () => close(1000, 'client left'))
  ws.on('error', () => close(1011, 'websocket error'))

  try {
    await upstream.open({
      onData: (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk)
      },
      onError: (err) => log(`${who}: upstream: ${err.message}`),
      onClose: (err) => close(1011, err?.message ?? 'upstream closed'),
    })
  } catch (err) {
    close(1011, err instanceof Error ? err.message : String(err))
    return
  }
  if (closed) return void upstream.close()
  ready = true
  for (const wire of queued.splice(0)) await upstream.write(wire).catch(() => {})
}
