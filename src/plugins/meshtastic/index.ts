// Meshtastic as a protocol plugin, receive only: the default channel of every modem preset, decoded with the
// well-known default key, and what node info, positions, telemetry and text posts tell about nodes and messages.

import { LORA_BANDWIDTHS_KHZ } from '../../protocol/codes.ts'
import type { LoRaConfig, RxPacket } from '../../protocol/messages.ts'
import type { Composer, Learned, MessageSighting, NodeSighting, PacketDecode, ProtocolPlugin } from '../types.ts'
import { encodeText } from './apps.ts'
import { PortNum } from './codes.ts'
import { DEFAULT_CHANNELS } from './crypto.ts'
import { decodeMeshtastic, type MeshtasticDecode } from './decode.ts'
import { BROADCAST, encodeMeshtasticPacket, nodeId } from './packet.ts'
import { MESHTASTIC_PRESETS, MESHTASTIC_SYNC_WORD, MODEM_PRESETS } from './presets.ts'

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
    // the sender's packet id is unique per sender, and the same in every rebroadcast
    const msg: MessageSighting = { channel, sender: nodeId(h.from), text: a.text, hops: m.hops, key: `${h.from}/${h.id}` }
    out.messages = [msg]
  }
  return out
}

/** Room for text in one packet: the firmware's 233-byte Data payload, less the header and protobuf framing. */
const MAX_TEXT_BYTES = 200
const HOP_LIMIT = 3

/**
 * A stable node number for a sender name (FNV-1a), so the same name always sends as the same !node. Other
 * radios learn names from NODEINFO, which this doesn't send, so they show the !node id.
 */
export function nodeNumFor(name: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(name)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  // 0-3 are reserved and 0xffffffff is broadcast
  return h < 4 || h === BROADCAST ? (h ^ 0x5a5a5a5a) >>> 0 : h
}

/** The default channel of the modem preset this config uses first, then the rest. */
function channelsFor(config: LoRaConfig): string[] {
  const bwKhz = LORA_BANDWIDTHS_KHZ[config.bw]
  const matching = Object.values(MODEM_PRESETS).find((m) => m.sf === config.sf && m.bwKhz === bwKhz)?.name
  const names = DEFAULT_CHANNELS.map((c) => c.name)
  return matching ? [matching, ...names.filter((n) => n !== matching)] : names
}

/** Text broadcast on a default channel, with the default key, from the sender's derived node number. */
const compose: Composer = {
  channels: channelsFor,
  maxTextBytes: () => MAX_TEXT_BYTES,
  senderProblem: (sender) => (!sender.trim() ? 'set a sender name: it picks the node id this console sends as' : undefined),
  build({ channel, text, sender }) {
    const ch = DEFAULT_CHANNELS.find((c) => c.name === channel)
    if (!ch) throw new Error(`no default Meshtastic channel '${channel}'`)
    const from = nodeNumFor(sender)
    const id = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0
    const bytes = encodeMeshtasticPacket({ to: BROADCAST, from, id, hopLimit: HOP_LIMIT, hopStart: HOP_LIMIT, channel: ch.hash, key: ch.key, portnum: PortNum.Text, payload: encodeText(text) })
    return { bytes, message: { channel, sender: nodeId(from), text, hops: 0, key: `${from}/${id}` } }
  },
}

export const meshtasticPlugin: ProtocolPlugin = {
  id: 'meshtastic',
  name: 'Meshtastic',
  description: 'Meshtastic mesh packets on the default channels: text, positions, node info, telemetry, routing and traceroutes; sends channel text',
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
  compose,
}
