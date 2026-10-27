// A RadioState snapshot without the long lists, for the server's /api/state and for scripts' radio.state(),
// and the parser both use for config changes given as a preset id or LoRa fields.

import { matchPreset, presetById, PRESETS } from '../plugins/index.ts'
import type { LoRaConfig } from '../protocol/messages.ts'
import type { RadioState } from './store.ts'

export function summarize(s: RadioState) {
  const config = s.applied?.lora ?? s.requested
  return {
    status: s.status,
    label: s.label,
    error: s.error,
    connectedAt: s.connectedAt,
    info: s.info,
    requested: s.requested,
    applied: s.applied,
    preset: matchPreset(config)?.id ?? null,
    rxOn: s.rxOn,
    txArmed: s.txArmed,
    stats: s.stats,
    health: s.health,
    noise: s.noise,
    radioStatus: s.radioStatus,
    radioStatusAt: s.radioStatusAt,
    counts: { packets: s.packets.length, nodes: Object.keys(s.nodes).length, messages: s.messages.length, linkErrors: s.linkErrors.length },
  }
}

export type RadioSummary = ReturnType<typeof summarize>

/** Thrown for a config input that can't be applied; the server answers it with 400. */
export class ConfigInputError extends Error {}

const LORA_KEYS: Record<keyof LoRaConfig, 'number' | 'boolean'> = {
  freqHz: 'number',
  sf: 'number',
  bw: 'number',
  cr: 'number',
  preambleLen: 'number',
  syncWord: 'number',
  txPowerDbm: 'number',
  implicitHeader: 'boolean',
  payloadCrc: 'boolean',
  iqInvert: 'boolean',
}

/**
 * A preset id ('meshtastic-longfast-us', or a unique suffix such as 'us'), `{ preset: id }`, or LoRa fields
 * (bw and cr as wire enums) laid over the requested config. A preset keeps the requested TX power.
 */
export function configFromInput(input: unknown, requested: LoRaConfig): LoRaConfig {
  const presetId = typeof input === 'string' ? input : input && typeof input === 'object' && 'preset' in input ? (input as { preset: unknown }).preset : undefined
  if (presetId !== undefined) {
    const preset = typeof presetId === 'string' ? presetById(presetId) : undefined
    if (!preset) throw new ConfigInputError(`unknown preset; one of ${PRESETS.map((p) => p.id).join(', ')}`)
    return { ...preset.config, txPowerDbm: requested.txPowerDbm }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigInputError('give a preset id or an object of LoRa fields')
  const config: LoRaConfig = { ...requested }
  for (const [k, v] of Object.entries(input)) {
    const kind = LORA_KEYS[k as keyof LoRaConfig]
    if (!kind) throw new ConfigInputError(`unknown field "${k}"; LoRa fields are ${Object.keys(LORA_KEYS).join(', ')}`)
    if (typeof v !== kind) throw new ConfigInputError(`"${k}" must be a ${kind}`)
    ;(config as unknown as Record<string, unknown>)[k] = v
  }
  return config
}
