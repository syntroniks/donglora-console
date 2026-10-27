// Meshtastic modem presets and region frequency slots (firmware src/mesh/RadioInterface.cpp) as DongLoRa LoRa
// configs. Meshtastic's sync word 0x2B is 0x24b4 in the SX126x register; preamble 16, explicit header, CRC on.

import type { LoRaConfig } from '../../protocol/messages.ts'
import type { Preset } from '../types.ts'

export const MESHTASTIC_SYNC_WORD = 0x24b4

export interface ModemPreset {
  /** also the primary channel's name when the user hasn't set one, which feeds the channel hash and the slot */
  name: string
  sf: number
  bwKhz: number
  /** 5..8 for 4/5..4/8 */
  cr: number
}

export const MODEM_PRESETS = {
  LongFast: { name: 'LongFast', sf: 11, bwKhz: 250, cr: 5 },
  // the firmware's display name for LONG_MODERATE is the abbreviation
  LongModerate: { name: 'LongMod', sf: 11, bwKhz: 125, cr: 8 },
  LongSlow: { name: 'LongSlow', sf: 12, bwKhz: 125, cr: 8 },
  MediumSlow: { name: 'MediumSlow', sf: 10, bwKhz: 250, cr: 5 },
  MediumFast: { name: 'MediumFast', sf: 9, bwKhz: 250, cr: 5 },
  ShortSlow: { name: 'ShortSlow', sf: 8, bwKhz: 250, cr: 5 },
  ShortFast: { name: 'ShortFast', sf: 7, bwKhz: 250, cr: 5 },
} satisfies Record<string, ModemPreset>

export interface Region {
  id: string
  startHz: number
  endHz: number
}

// spacing is 0 in both, so it's left out of the slot maths
export const REGIONS = {
  US: { id: 'US', startHz: 902_000_000, endHz: 928_000_000 },
  EU_868: { id: 'EU_868', startHz: 869_400_000, endHz: 869_650_000 },
} satisfies Record<string, Region>

/** djb2 over the UTF-8 bytes, as a u32 */
export function djb2(s: string): number {
  let h = 5381
  for (const c of new TextEncoder().encode(s)) h = (Math.imul(h, 33) + c) >>> 0
  return h
}

/**
 * Centre frequency in Hz of a channel's default slot: djb2(name) % slots, slots = floor(span / bw). The
 * firmware does this in float MHz; whole Hz gives the same answer without float edge cases.
 */
export function meshtasticFrequencyHz(region: Region, bwKhz: number, channelName: string): number {
  const bwHz = bwKhz * 1000
  const slots = Math.floor((region.endHz - region.startHz) / bwHz)
  if (slots < 1) throw new RangeError(`${region.id} is too narrow for ${bwKhz} kHz`)
  const slot = djb2(channelName) % slots
  return region.startHz + bwHz / 2 + slot * bwHz
}

// DongLoRa wire enums
const BW_ENUM: Record<number, number> = { 125: 7, 250: 8, 500: 9 }
const CR_ENUM: Record<number, number> = { 5: 0, 6: 1, 7: 2, 8: 3 }

export function meshtasticConfig(preset: ModemPreset, region: Region, channelName = preset.name): LoRaConfig {
  return {
    freqHz: meshtasticFrequencyHz(region, preset.bwKhz, channelName),
    sf: preset.sf,
    bw: BW_ENUM[preset.bwKhz],
    cr: CR_ENUM[preset.cr],
    preambleLen: 16,
    syncWord: MESHTASTIC_SYNC_WORD,
    // only used if this console transmits, which it doesn't; SET_CONFIG needs a value
    txPowerDbm: 10,
    implicitHeader: false,
    payloadCrc: true,
    iqInvert: false,
  }
}

const preset = (m: ModemPreset, r: Region): Preset => ({
  id: `meshtastic-${m.name.toLowerCase()}-${r.id.replace('_', '').toLowerCase()}`,
  name: `Meshtastic ${m.name} (${r.id})`,
  config: meshtasticConfig(m, r),
})

export const MESHTASTIC_PRESETS: Preset[] = [
  preset(MODEM_PRESETS.LongFast, REGIONS.US),
  preset(MODEM_PRESETS.MediumFast, REGIONS.US),
  preset(MODEM_PRESETS.ShortFast, REGIONS.US),
  preset(MODEM_PRESETS.LongFast, REGIONS.EU_868),
  preset(MODEM_PRESETS.MediumFast, REGIONS.EU_868),
]
