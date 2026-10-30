// What is known about the receiver front end (RX gain, AGC, external FEM with its LNA and PA). Firmware 1.6.0
// (protocol v1.1) reports RX gain and the FEM's state in RADIO_STATUS; those values are overlaid with
// deviceReported() and labelled device-reported. Everything else comes from reading the firmware source
// for a given version and board, and is labelled that way.

import { FEM_TYPE_NAMES, FemFlag, FemType, RX_GAIN_NAMES } from '../protocol/codes.ts'
import type { DeviceInfo, RadioStatus } from '../protocol/messages.ts'

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
  /** how the board was worked out: GET_INFO doesn't name it */
  boardBasis: string
  rxGain: FrontEndValue
  agcReset: FrontEndValue
  femType: FrontEndValue
  femPower: FrontEndValue
  femLna: FrontEndValue
  femPa: FrontEndValue
  tcxo: FrontEndValue
  dcdc: FrontEndValue
}

type Row = Omit<FrontEnd, 'firmware' | 'board' | 'boardBasis'>
const fw = (value: string, note: string): FrontEndValue => ({ value, source: 'firmware-default', note })
const awaiting = (note: string): FrontEndValue => ({ value: 'reported by RADIO_STATUS (no reply yet)', source: 'unknown', note })

/** Keyed by "<firmware>/<board>", from reading that firmware's source. */
const KNOWN: Record<string, Row> = {
  '1.5.2/heltec_v4': {
    rxGain: fw('power saving (0x94 in reg 0x08AC); boosted 0x96 would add ~3 dB for ~2 mA', 'rx_boost: false in firmware/src/board/esp32s3.rs; lora-phy writes it before every RX and CAD'),
    agcReset: fw('never; the SX1262 AGC runs on its own', 'MeshCore warm-sleeps the SX126x every agc.reset.interval to reset the analog front end; DongLoRa 1.5.2 has no equivalent'),
    femType: fw('not detected: GC1109 on V4.2, KCT8103L on V4.3', 'DongLoRa 1.5.2 has no front-end module support, so it never reads the board revision'),
    femPower: fw('no: LDO (GPIO7) and CSD (GPIO2) never driven', 'firmware/src/board/heltec_v4.rs; MeshCore drives them in variants/heltec_v4/LoRaFEMControl.cpp'),
    femLna: fw('not driven: front-end module likely unpowered (GPIO7/2/46/5 untouched)', 'MeshCore powers it and offers radio.fem.rxgain on/off (KCT8103L, V4.3 only)'),
    femPa: fw('not driven: TX goes into the unpowered module, the dBm value is the SX1262 setting', 'GPIO46 CPS / GPIO5 CTX untouched in firmware/src/board/heltec_v4.rs'),
    tcxo: fw('1.8 V', 'firmware/src/board/esp32s3.rs'),
    dcdc: fw('on', 'firmware/src/board/esp32s3.rs'),
  },
  // RX gain and the FEM rows are only placeholders until the first RADIO_STATUS reply replaces them
  '1.6.0/heltec_v4': {
    rxGain: awaiting('DongLoRa 1.6.0 reads reg 0x08AC for RADIO_STATUS'),
    agcReset: fw('never; the SX1262 AGC runs on its own', 'DongLoRa 1.6.0 adds no AGC reset either; MeshCore warm-sleeps the SX126x every agc.reset.interval'),
    femType: awaiting('DongLoRa 1.6.0 detects GC1109 (V4.2) or KCT8103L (V4.3)'),
    femPower: fw('powered and enabled at boot', 'DongLoRa 1.6.0 drives the V4 front-end module; RADIO_STATUS reports its state'),
    femLna: fw('on in RX', 'DongLoRa 1.6.0 enables the FEM LNA for RX'),
    femPa: fw('PA in TX; tx_power_dbm is approximate antenna output through a measured gain curve', 'DongLoRa 1.6.0; GET_INFO reports the output range (2…28 dBm GC1109, 4…28 dBm KCT8103L)'),
    tcxo: fw('1.8 V', 'firmware/src/board/esp32s3.rs, assumed unchanged since 1.5.2'),
    dcdc: fw('on', 'firmware/src/board/esp32s3.rs, assumed unchanged since 1.5.2'),
  },
}
// 1.6.1 changes how RADIO_STATUS is answered, not the V4 front end
KNOWN['1.6.1/heltec_v4'] = KNOWN['1.6.0/heltec_v4']

const unknown: FrontEndValue = { value: 'unknown', source: 'unknown', note: 'no table entry for this firmware and board' }

/**
 * The board can't be read from GET_INFO. A RADIO_STATUS reply tells a Heltec V4 by its front-end module; other
 * SX1262 boards (RAK4631, T114, ...) report none or unknown. Without RADIO_STATUS an SX1262 is assumed to be
 * the Heltec V4 this was built for. With a RADIO_STATUS reply, its values replace the table's.
 */
export function boardOf(info: DeviceInfo | undefined, status?: RadioStatus): { board: string; basis: string } {
  if (status) {
    const v4 = status.femType === FemType.Gc1109 || status.femType === FemType.Kct8103l
    return v4
      ? { board: 'heltec_v4', basis: 'from the front-end module RADIO_STATUS reports' }
      : { board: 'unknown', basis: 'RADIO_STATUS reports no Heltec V4 front end, and GET_INFO doesn’t name the board' }
  }
  if (info?.radioChipId === 0x0002) return { board: 'heltec_v4', basis: 'assumed for an SX1262: GET_INFO doesn’t name the board' }
  return { board: 'unknown', basis: 'GET_INFO doesn’t name the board' }
}

export function frontEndFor(info: DeviceInfo | undefined, status?: RadioStatus): FrontEnd {
  const firmware = info ? `${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}` : '?'
  const { board, basis } = boardOf(info, status)
  const row = KNOWN[`${firmware}/${board}`]
  const base: FrontEnd = {
    firmware,
    board,
    boardBasis: basis,
    ...(row ?? { rxGain: unknown, agcReset: unknown, femType: unknown, femPower: unknown, femLna: unknown, femPa: unknown, tcxo: unknown, dcdc: unknown }),
  }
  return status ? deviceReported(base, reportedFrontEnd(status)) : base
}

/** Overlay values a device reported (RADIO_STATUS) on the static ones. */
export function deviceReported(base: FrontEnd, reported: Partial<Record<keyof Row, string>>): FrontEnd {
  const out = { ...base }
  for (const [k, v] of Object.entries(reported) as [keyof Row, string | undefined][]) {
    if (v !== undefined) out[k] = { value: v, source: 'device-reported' }
  }
  return out
}

const hex2 = (v: number) => `0x${v.toString(16).padStart(2, '0')}`

/** The rows RADIO_STATUS answers. AGC reset, TCXO and DC-DC aren't in it. */
export function reportedFrontEnd(s: RadioStatus): Partial<Record<keyof Row, string>> {
  const fem = s.femType !== FemType.None
  const on = (bit: number) => (s.femFlags & bit) !== 0
  return {
    rxGain: RX_GAIN_NAMES[s.rxGain] ?? `unknown (${hex2(s.rxGain)})`,
    femType: FEM_TYPE_NAMES[s.femType] ?? `unknown (${hex2(s.femType)})`,
    femPower: fem ? (on(FemFlag.Powered) ? 'yes, enabled' : 'no') : 'no FEM',
    femLna: fem ? (on(FemFlag.Lna) ? 'active' : 'off') : 'no FEM',
    femPa: fem ? (on(FemFlag.Pa) ? 'PA enabled' : 'bypass') : 'no FEM',
  }
}

/**
 * What a tx_power_dbm value means. Firmware 1.6.0 maps it through a measured gain curve when the board's FEM
 * is powered, so it is approximate antenna output; 1.5.2 leaves the FEM unpowered and sets the SX1262 directly.
 */
export type TxPowerMeaning = 'antenna' | 'chip' | 'unknown'

export function txPowerMeaning(info: DeviceInfo | undefined, status?: RadioStatus): TxPowerMeaning {
  if (status) return status.femType !== FemType.None && status.femFlags & FemFlag.Powered ? 'antenna' : 'chip'
  if (!info) return 'unknown'
  const { major, minor } = info.firmware
  return major === 1 && minor <= 5 ? 'chip' : 'unknown'
}

export const TX_POWER_MEANING_LABELS: Record<TxPowerMeaning, string> = {
  antenna: 'approx. antenna output',
  chip: 'SX1262 setting',
  unknown: 'SX1262 setting or antenna output',
}

export const FRONT_END_SOURCE_LABELS: Record<FrontEndSource, string> = {
  'firmware-default': 'firmware default (not reported by device)',
  'device-reported': 'device-reported',
  unknown: 'unknown',
}

export const FRONT_END_ROWS: { key: keyof Row; label: string }[] = [
  { key: 'rxGain', label: 'RX gain mode' },
  { key: 'agcReset', label: 'AGC reset' },
  { key: 'femType', label: 'FEM type' },
  { key: 'femPower', label: 'FEM powered' },
  { key: 'femLna', label: 'FEM RX LNA' },
  { key: 'femPa', label: 'FEM TX PA' },
  { key: 'tcxo', label: 'TCXO' },
  { key: 'dcdc', label: 'DC-DC' },
]
