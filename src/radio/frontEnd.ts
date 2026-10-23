// What is known about the receiver front end (RX gain, AGC, external LNA). No DongLoRa firmware reports any
// of it yet, so values come from reading the firmware source for a given version and board, and are
// labelled that way. A future diagnostics command (feature-checked with a GET_INFO capability bit) can
// supply device-reported values through deviceReported().

import type { DeviceInfo } from '../protocol/messages.ts'

export type FrontEndSource = 'firmware-default' | 'device-reported' | 'unknown'

export interface FrontEndValue {
  value: string
  source: FrontEndSource
  /** where the value comes from, eg. a source file */
  note?: string
}

export interface FrontEnd {
  firmware: string
  board: string
  boardAssumed: boolean // GET_INFO doesn't name the board
  rxGain: FrontEndValue
  agcReset: FrontEndValue
  femLna: FrontEndValue
  tcxo: FrontEndValue
  dcdc: FrontEndValue
}

/** Capability bit a firmware could set when it supports a front-end diagnostics command. Not assigned yet. */
export const DIAGNOSTICS_CAPABILITY_BIT: number | undefined = undefined

type Row = Omit<FrontEnd, 'firmware' | 'board' | 'boardAssumed'>
const fw = (value: string, note: string): FrontEndValue => ({ value, source: 'firmware-default', note })

/** Keyed by "<firmware>/<board>", from reading that firmware's source. */
const KNOWN: Record<string, Row> = {
  '1.5.2/heltec_v4': {
    rxGain: fw('power saving (0x94 in reg 0x08AC); boosted 0x96 would add ~3 dB for ~2 mA', 'rx_boost: false in firmware/src/board/esp32s3.rs; lora-phy writes it before every RX and CAD'),
    agcReset: fw('never; the SX1262 AGC runs on its own', 'MeshCore warm-sleeps the SX126x every agc.reset.interval to reset the analog front end; DongLoRa 1.5.2 has no equivalent'),
    femLna: fw('not driven: front-end module likely unpowered (GPIO7/2/46/5 untouched)', 'MeshCore powers it and offers radio.fem.rxgain on/off (KCT8103L, V4.3 only)'),
    tcxo: fw('1.8 V', 'firmware/src/board/esp32s3.rs'),
    dcdc: fw('on', 'firmware/src/board/esp32s3.rs'),
  },
}

const unknown: FrontEndValue = { value: 'unknown', source: 'unknown', note: 'no table entry for this firmware and board' }

/** The board can't be read from GET_INFO; an SX1262 on 1.5.2 is assumed to be the Heltec V4 this was built for. */
export function frontEndFor(info: DeviceInfo | undefined): FrontEnd {
  const firmware = info ? `${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}` : '?'
  const board = info?.radioChipId === 0x0002 ? 'heltec_v4' : 'unknown'
  const row = KNOWN[`${firmware}/${board}`]
  return {
    firmware,
    board,
    boardAssumed: true,
    ...(row ?? { rxGain: unknown, agcReset: unknown, femLna: unknown, tcxo: unknown, dcdc: unknown }),
  }
}

/** Overlay values a device reported (future diagnostics command) on the static ones. */
export function deviceReported(base: FrontEnd, reported: Partial<Record<keyof Row, string>>): FrontEnd {
  const out = { ...base }
  for (const [k, v] of Object.entries(reported) as [keyof Row, string | undefined][]) {
    if (v !== undefined) out[k] = { value: v, source: 'device-reported' }
  }
  return out
}

export const FRONT_END_SOURCE_LABELS: Record<FrontEndSource, string> = {
  'firmware-default': 'firmware default (not reported by device)',
  'device-reported': 'device-reported',
  unknown: 'unknown',
}

export const FRONT_END_ROWS: { key: keyof Row; label: string }[] = [
  { key: 'rxGain', label: 'RX gain mode' },
  { key: 'agcReset', label: 'AGC reset' },
  { key: 'femLna', label: 'FEM / LNA' },
  { key: 'tcxo', label: 'TCXO' },
  { key: 'dcdc', label: 'DC-DC' },
]
