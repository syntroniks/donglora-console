// MeshCore regional radio presets (MeshCore docs/radio_presets.md, docs/faq.md, docs/cli_commands.md) as
// DongLoRa LoRa configs. MeshCore radios use the RadioLib "private" sync word 0x12, which is 0x1424 in
// the SX126x register, explicit headers, payload CRC on and normal IQ.

import type { LoRaConfig } from '../protocol/messages.ts'

/** RadioLibWrappers.h: 32 preamble symbols up to SF8, 16 above. */
export const meshcorePreamble = (sf: number): number => (sf <= 8 ? 32 : 16)

export const MESHCORE_SYNC_WORD = 0x1424

export interface Preset {
  id: string
  name: string
  config: LoRaConfig
}

function meshcore(freqHz: number, sf: number, bw: number, cr: number): LoRaConfig {
  return {
    freqHz,
    sf,
    bw,
    cr,
    preambleLen: meshcorePreamble(sf),
    syncWord: MESHCORE_SYNC_WORD,
    // only used if this console transmits, which it doesn't unless TX is armed; SET_CONFIG needs a value
    txPowerDbm: 10,
    implicitHeader: false,
    payloadCrc: true,
    iqInvert: false,
  }
}

// bw is the DongLoRa enum: 6 = 62.5 kHz. cr is the enum: 0 = 4/5 ... 3 = 4/8.
export const PRESETS: Preset[] = [
  { id: 'meshcore-us', name: 'MeshCore USA/Canada', config: meshcore(910_525_000, 7, 6, 0) },
  { id: 'meshcore-eu', name: 'MeshCore EU/UK (firmware default)', config: meshcore(869_618_000, 8, 6, 0) },
  { id: 'meshcore-au', name: 'MeshCore Australia (narrow)', config: meshcore(916_575_000, 7, 6, 2) },
  { id: 'meshcore-nz', name: 'MeshCore New Zealand (narrow)', config: meshcore(917_375_000, 7, 6, 0) },
]

export const DEFAULT_PRESET = PRESETS[0]

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id || p.id === `meshcore-${id}`)
}

/** The preset a config matches exactly, ignoring TX power. */
export function matchPreset(c: LoRaConfig): Preset | undefined {
  return PRESETS.find((p) => {
    const a = { ...p.config, txPowerDbm: 0 }
    const b = { ...c, txPowerDbm: 0 }
    return JSON.stringify(a) === JSON.stringify(b)
  })
}
