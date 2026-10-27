// MeshCore as a protocol plugin: the decoder in src/meshcore, its presets, and what adverts and Public channel
// posts tell about nodes and messages.

import { PUBLIC_CHANNEL } from '../meshcore/crypto.ts'
import { decodeMeshCore, type MeshDecode } from '../meshcore/decode.ts'
import { MESHCORE_SYNC_WORD, PRESETS } from '../meshcore/presets.ts'
import type { RxPacket } from '../protocol/messages.ts'
import type { ByteRegion, DecodeField, Learned, PacketDecode, ProtocolPlugin } from './types.ts'

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`
const coords = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`

function regionsOf(m: MeshDecode, len: number): ByteRegion[] {
  const out: ByteRegion[] = [{ from: 0, to: 1, kind: 'header', label: 'header' }]
  let pos = 1
  if (m.transportCodes) {
    out.push({ from: 1, to: 5, kind: 'meta', label: 'transport codes' })
    pos = 5
  }
  if (m.hops !== undefined || m.failure?.stage === 'path') out.push({ from: pos, to: pos + 1, kind: 'length', label: 'path len' })
  if (m.path) out.push({ from: pos + 1, to: pos + 1 + m.path.length / 2, kind: 'path', label: 'path' })
  if (m.payloadOffset !== undefined) out.push({ from: m.payloadOffset, to: len, kind: 'payload', label: 'payload' })
  return out
}

function fieldsOf(m: MeshDecode): DecodeField[] {
  const f: DecodeField[] = []
  if (m.header) {
    f.push({ label: 'Type', value: `${m.header.payloadName} (0x${m.header.payloadType.toString(16)}), payload v${m.header.version + 1}` })
    f.push({ label: 'Route', value: m.header.routeName + (m.transportCodes ? ` · codes ${m.transportCodes.map((c) => c.toString(16).padStart(4, '0')).join(' ')}` : '') })
  }
  if (m.hops !== undefined) {
    const hops = m.path ? (m.path.match(new RegExp(`.{${m.hashSize! * 2}}`, 'g'))?.join(' ') ?? '') : '(not read)'
    f.push({ label: 'Path', value: m.hops ? `${m.hops} hop${m.hops === 1 ? '' : 's'} × ${m.hashSize} B: ${hops}` : 'direct from the sender (0 hops)' })
  }
  if (m.payloadLength !== undefined) f.push({ label: 'Payload', value: `${m.payloadLength} bytes from byte ${m.payloadOffset}` })
  const a = m.advert
  if (a) {
    if (a.name !== undefined) f.push(a.name ? { label: 'Name', value: a.name } : { label: 'Name', value: '(empty)', tone: 'muted' })
    if (a.typeName) f.push({ label: 'Node type', value: a.typeName })
    if (a.publicKey) f.push({ label: 'Public key', value: a.publicKey, mono: true })
    if (a.timestamp !== undefined) f.push({ label: 'Advert time', value: new Date(a.timestamp * 1000).toLocaleString() })
    if (a.hasLocation) f.push({ label: 'Position', value: coords(a.lat!, a.lon!) })
    if (a.signatureValid !== undefined) f.push({ label: 'Signature', value: a.signatureValid ? 'valid Ed25519' : 'invalid', tone: a.signatureValid ? 'ok' : 'err' })
  }
  const g = m.group
  if (g) {
    if (g.channelHash !== undefined) f.push({ label: 'Channel hash', value: `${hex2(g.channelHash)}${g.channel ? ` (${g.channel})` : ''}` })
    if (g.mac) f.push({ label: 'MAC', value: g.mac, mono: true })
    if (g.sender !== undefined) f.push(g.sender ? { label: 'Sender', value: g.sender } : { label: 'Sender', value: '(none)', tone: 'muted' })
    if (g.body !== undefined) f.push({ label: 'Text', value: g.body })
    if (g.timestamp !== undefined) f.push({ label: 'Sent', value: new Date(g.timestamp * 1000).toLocaleString() })
    if (g.data !== undefined) f.push({ label: 'Data', value: `type 0x${g.dataType!.toString(16)} · ${g.data}`, mono: true })
  }
  const d = m.addressed
  if (d) {
    f.push({ label: 'Addressing', value: `${d.srcHash !== undefined ? hex2(d.srcHash) : '0x??'} → ${d.destHash !== undefined ? hex2(d.destHash) : '0x??'}` })
    if (d.mac) f.push({ label: 'MAC', value: d.mac, mono: true })
    if (d.ciphertextLength !== undefined) f.push({ label: 'Ciphertext', value: `${d.ciphertextLength} bytes (peer-to-peer, not decryptable here)` })
  }
  if (m.ackChecksum) f.push({ label: 'Ack checksum', value: m.ackChecksum, mono: true })
  return f
}

/** Adverts only count once their Ed25519 signature checks out; channel senders are whatever the post claims. */
function learn(decode: PacketDecode): Learned {
  const m = decode.data as MeshDecode
  if (m.status !== 'decoded') return {}
  const out: Learned = {}
  const a = m.advert
  if (a?.publicKey && a.signatureValid) {
    out.nodes = [{ id: a.publicKey, name: a.name, kind: a.typeName, hops: m.hops ?? 0, lat: a.hasLocation ? a.lat : undefined, lon: a.hasLocation ? a.lon : undefined }]
  }
  const g = m.group
  if (g?.text !== undefined) {
    // repeaters forward the same payload by different paths: channel, timestamp and text identify it
    const key = `${g.channelHash ?? ''}/${g.timestamp ?? ''}/${g.text}`
    out.messages = [{ channel: g.channel ?? '', sender: g.sender ?? '', text: g.body ?? '', sentAt: g.timestamp, hops: m.hops ?? 0, key }]
  }
  return out
}

export const meshcorePlugin: ProtocolPlugin = {
  id: 'meshcore',
  name: 'MeshCore',
  description: 'MeshCore mesh packets: adverts with Ed25519 signatures, the Public channel, paths and addressed traffic',
  presets: PRESETS,
  stages: [
    { stage: 'header', label: 'Header (truncated, unknown version)' },
    { stage: 'path', label: 'Path (truncated, reserved hash size, too long)' },
    { stage: 'payload', label: 'Payload (truncated, unknown type)' },
    { stage: 'advert', label: 'Advert fields' },
    { stage: 'signature', label: 'Advert signature' },
    { stage: 'mac', label: 'Channel MAC' },
    { stage: 'decrypt', label: 'Decrypt / plaintext' },
  ],
  claims: (config) => config.syncWord === MESHCORE_SYNC_WORD,
  decode(raw: Uint8Array, _rx: RxPacket): PacketDecode {
    const m = decodeMeshCore(raw, { channels: [PUBLIC_CHANNEL], verifySignatures: true })
    return { protocol: 'meshcore', status: m.status, summary: m.summary, failure: m.failure, fields: fieldsOf(m), regions: regionsOf(m, raw.length), data: m }
  },
  learn,
}
