// The protocol plugins the console ships with, and the lookups everything else uses: presets across all
// plugins, and which plugin decodes a packet received with a given radio config.

import type { LoRaConfig, RxPacket } from '../protocol/messages.ts'
import { toHex } from '../protocol/bytes.ts'
import { meshcorePlugin } from './meshcore.ts'
import { meshtasticPlugin } from './meshtastic/index.ts'
import type { DecodeStatus, PacketDecode, Preset, ProtocolPlugin } from './types.ts'

export type * from './types.ts'

export const PLUGINS: ProtocolPlugin[] = [meshcorePlugin, meshtasticPlugin]

export const pluginById = (id: string): ProtocolPlugin | undefined => PLUGINS.find((p) => p.id === id)

export interface PluginPreset extends Preset {
  plugin: string
}

export const PRESETS: PluginPreset[] = PLUGINS.flatMap((p) => p.presets.map((preset) => ({ ...preset, plugin: p.id })))

/** MeshCore USA/Canada: what the console and the server ask for unless told otherwise. */
export const DEFAULT_PRESET: PluginPreset = PRESETS.find((p) => p.id === 'meshcore-us') ?? PRESETS[0]

/**
 * By id, or by the id without its plugin prefix, trying plugins in registry order: 'us' is 'meshcore-us',
 * 'longfast-us' is 'meshtastic-longfast-us'.
 */
export function presetById(id: string): PluginPreset | undefined {
  return PRESETS.find((p) => p.id === id) ?? PLUGINS.map((plugin) => PRESETS.find((p) => p.id === `${plugin.id}-${id}`)).find(Boolean)
}

/** The preset a config matches exactly, ignoring TX power. */
export function matchPreset(c: LoRaConfig): PluginPreset | undefined {
  const key = (x: LoRaConfig) => JSON.stringify({ ...x, txPowerDbm: 0 })
  const k = key(c)
  return PRESETS.find((p) => key(p.config) === k)
}

/** Plugins that claim packets received with this config, in registry order. */
export const pluginsFor = (config: LoRaConfig | undefined): ProtocolPlugin[] => (config ? PLUGINS.filter((p) => p.claims(config)) : [])

const RANK: Record<DecodeStatus, number> = { decoded: 4, partial: 3, 'no-key': 2, undecodable: 1, unknown: 0 }

/**
 * Decode with every plugin that claims the radio config and keep the best result. With no config (not
 * configured yet) or no claiming plugin, the packet is 'unknown': its bytes are still shown.
 */
export function decodePacket(raw: Uint8Array, rx: RxPacket, config: LoRaConfig | undefined): PacketDecode {
  let best: PacketDecode | undefined
  for (const p of pluginsFor(config)) {
    let d: PacketDecode
    try {
      d = p.decode(raw, rx)
    } catch (err) {
      d = { protocol: p.id, status: 'undecodable', summary: `${p.name} decoder crashed`, failure: { stage: 'plugin', reason: String(err), offset: 0 }, fields: [], regions: [] }
    }
    if (!best || RANK[d.status] > RANK[best.status]) best = d
  }
  return best ?? unknownDecode(raw, config)
}

function unknownDecode(raw: Uint8Array, config: LoRaConfig | undefined): PacketDecode {
  const sync = config ? `sync word 0x${config.syncWord.toString(16)}` : 'no config'
  return {
    protocol: 'unknown',
    status: 'unknown',
    summary: `${raw.length} B, no plugin for this radio config (${sync}) · ${toHex(raw.subarray(0, 8), ' ')}${raw.length > 8 ? ' …' : ''}`,
    fields: [{ label: 'Protocol', value: `none of ${PLUGINS.map((p) => p.name).join(', ')} claims packets received with ${sync}`, tone: 'muted' }],
    regions: [],
  }
}

/** Stage label for the Overview's failure counts; keys are `${protocol}/${stage}`. */
export function stageLabel(key: string): string {
  const [protocol, stage] = key.split('/')
  const p = pluginById(protocol)
  return `${p?.name ?? protocol}: ${p?.stages.find((s) => s.stage === stage)?.label ?? stage}`
}
