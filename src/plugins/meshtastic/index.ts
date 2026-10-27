// Meshtastic as a protocol plugin, receive only: the default channel of every modem preset, decoded with the
// well-known default key, and what node info, positions, telemetry and text posts tell about nodes and messages.

import type { RxPacket } from '../../protocol/messages.ts'
import type { Learned, MessageSighting, NodeSighting, PacketDecode, ProtocolPlugin } from '../types.ts'
import { decodeMeshtastic, type MeshtasticDecode } from './decode.ts'
import { BROADCAST, nodeId } from './packet.ts'
import { MESHTASTIC_PRESETS, MESHTASTIC_SYNC_WORD } from './presets.ts'

export * from './apps.ts'
export * from './codes.ts'
export * from './crypto.ts'
export * from './decode.ts'
export * from './packet.ts'
export * from './presets.ts'
export { ProtoError, ProtoReader, ProtoWriter, WireType } from './proto.ts'

/**
 * Meshtastic signs nothing and the default keys are public, so anyone can send a packet claiming any `from`.
 * Everything here is "heard a packet saying so", not verified; the header's from is all there is to go on.
 */
function learn(decode: PacketDecode, rx: RxPacket): Learned {
  if (decode.protocol !== 'meshtastic' || !rx.crcValid) return {}
  const m = decode.data as MeshtasticDecode | undefined
  const h = m?.header
  if (!m || !h || !m.data) return {}
  const node: NodeSighting = { id: nodeId(h.from), hops: m.hops }
  const out: Learned = { nodes: [node] }
  const a = m.app
  if (a?.kind === 'nodeinfo') {
    if (a.longName) node.name = a.longName
    if (a.shortName) node.shortName = a.shortName
    node.kind = a.roleName.toLowerCase().replace(/_/g, ' ')
    node.details = { hardware: a.hwModelName }
  } else if (a?.kind === 'position' && a.lat !== undefined && a.lon !== undefined && (a.lat !== 0 || a.lon !== 0)) {
    node.lat = a.lat
    node.lon = a.lon
  } else if (a?.kind === 'telemetry' && a.device) {
    const details: Record<string, string> = {}
    const { batteryLevel, voltage } = a.device
    if (batteryLevel !== undefined) details.battery = batteryLevel > 100 ? 'external power' : `${batteryLevel}%`
    if (voltage !== undefined) details.voltage = `${voltage.toFixed(2)} V`
    if (Object.keys(details).length) node.details = details
  } else if (a?.kind === 'text') {
    // direct messages ride the channel key too; keep them out of the channel's own conversation
    const channel = h.to === BROADCAST ? (m.channel ?? '') : `${m.channel ?? ''} → ${nodeId(h.to)}`
    const msg: MessageSighting = { channel, sender: nodeId(h.from), text: a.text, hops: m.hops }
    out.messages = [msg]
  }
  return out
}

export const meshtasticPlugin: ProtocolPlugin = {
  id: 'meshtastic',
  name: 'Meshtastic',
  description: 'Meshtastic mesh packets on the default channels: text, positions, node info, telemetry, routing and traceroutes. Receive only',
  presets: MESHTASTIC_PRESETS,
  stages: [
    { stage: 'header', label: 'Header (truncated)' },
    { stage: 'channel', label: 'Channel hash (no key)' },
    { stage: 'decrypt', label: 'Decrypt (wrong key or corrupt)' },
    { stage: 'data', label: 'Data message (unencrypted channel)' },
    { stage: 'app', label: 'App payload' },
  ],
  claims: (config) => config.syncWord === MESHTASTIC_SYNC_WORD,
  decode: (raw) => decodeMeshtastic(raw),
  learn,
}
