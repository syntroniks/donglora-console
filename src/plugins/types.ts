// Protocol plugins: what a LoRa protocol contributes to the console. A plugin is data and functions, no UI,
// so the page, the shell, the console server and scripts all run the same code. The console's views are
// generic: they render a plugin's decode as rows and hex regions, and its nodes and messages in shared lists.

import type { LoRaConfig, RxPacket } from '../protocol/messages.ts'

/**
 * decoded: everything the plugin can read was read. partial: the packet is this protocol's but a later
 * stage failed. undecodable: it doesn't parse as this protocol. no-key: encrypted for a key the console
 * doesn't have, which isn't a failure. unknown: no plugin claims packets received with this radio config.
 */
export type DecodeStatus = 'decoded' | 'partial' | 'undecodable' | 'no-key' | 'unknown'

export interface DecodeFailure {
  /** plugin-defined stage name, eg. 'header', 'decrypt'; labelled by the plugin's `stages` */
  stage: string
  reason: string
  /** byte offset into the packet where it went wrong */
  offset: number
}

/** How a byte range is tinted in the hex dump. */
export type RegionKind = 'header' | 'address' | 'meta' | 'length' | 'path' | 'payload' | 'mac'

export interface ByteRegion {
  from: number
  /** exclusive */
  to: number
  kind: RegionKind
  label: string
}

export interface DecodeField {
  label: string
  value: string
  tone?: 'ok' | 'err' | 'warn' | 'muted'
  /** show as code: keys, hashes, hex */
  mono?: boolean
}

export interface PacketDecode {
  /** id of the plugin that decoded it */
  protocol: string
  status: DecodeStatus
  /** one line for the packet table */
  summary: string
  failure?: DecodeFailure
  /** detail rows, in order */
  fields: DecodeField[]
  regions: ByteRegion[]
  /** the plugin's own structured decode, JSON-safe apart from Uint8Array and bigint; for scripts and the API */
  data?: unknown
}

export interface Preset {
  id: string
  name: string
  config: LoRaConfig
}

/** What one packet says about a node. The store merges sightings into a HeardNode per protocol and id. */
export interface NodeSighting {
  /** stable within the protocol: a MeshCore public key, a Meshtastic !node id */
  id: string
  name?: string
  shortName?: string
  /** repeater, client, router, ... */
  kind?: string
  hops?: number
  lat?: number
  lon?: number
  /** small facts worth a column or a tooltip: hardware, battery, firmware role */
  details?: Record<string, string>
}

export interface MessageSighting {
  /** channel or conversation name */
  channel: string
  sender: string
  text: string
  /** sender's clock, unix seconds, when the protocol carries it */
  sentAt?: number
  hops?: number
  /** the same for every copy of this message the mesh delivers (flood repeats arrive by several paths) */
  key?: string
}

export interface Learned {
  nodes?: NodeSighting[]
  messages?: MessageSighting[]
}

export interface ComposeInput {
  /** one of `channels(config)` */
  channel: string
  text: string
  /** the sender's display name; what a protocol does with it is up to the plugin */
  sender: string
  /** unix seconds */
  now: number
}

export interface Composed {
  /** the packet to transmit */
  bytes: Uint8Array
  /** how the message shows in the list; its `key` matches what `learn` gives the mesh's copies of it */
  message: MessageSighting
}

/** Sending channel text. The packet goes out as it is; the console arms and gates TX. */
export interface Composer {
  /** channels that can be posted to with this radio config, best match first */
  channels(config: LoRaConfig): string[]
  /** the most UTF-8 bytes of text one packet carries for this sender */
  maxTextBytes(sender: string): number
  /** why this sender name can't be used, if it can't */
  senderProblem?(sender: string): string | undefined
  build(input: ComposeInput): Composed
}

export interface ProtocolPlugin {
  id: string
  name: string
  description: string
  presets: Preset[]
  /** labels for the failure stages this plugin reports, in pipeline order */
  stages: { stage: string; label: string }[]
  /** whether packets received with this radio config can be this protocol's; usually a sync-word check */
  claims(config: LoRaConfig): boolean
  decode(raw: Uint8Array, rx: RxPacket): PacketDecode
  /** what a packet with a good CRC tells about nodes and messages. Only trust what the protocol lets you trust. */
  learn?(decode: PacketDecode, rx: RxPacket): Learned
  /** present when the plugin can send channel messages */
  compose?: Composer
}
