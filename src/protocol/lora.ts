// LoRa parameter helpers: display, validation against GET_INFO, and time on air.

import { LORA_BANDWIDTHS_KHZ, LORA_CODING_RATES } from './codes.ts'
import type { DeviceInfo, LoRaConfig } from './messages.ts'

export const bwKHz = (bw: number): number => LORA_BANDWIDTHS_KHZ[bw] ?? NaN
export const crText = (cr: number): string => LORA_CODING_RATES[cr] ?? `cr ${cr}`
export const mhz = (hz: number): string => (hz / 1e6).toFixed(3)

/** "910.525 MHz · SF7 · 62.5 kHz · CR 4/5" */
export function describeConfig(c: LoRaConfig): string {
  return `${mhz(c.freqHz)} MHz · SF${c.sf} · ${bwKHz(c.bw)} kHz · CR ${crText(c.cr)}`
}

export const syncWordHex = (w: number): string => `0x${w.toString(16).padStart(4, '0').toUpperCase()}`

const bit = (bitmap: number, n: number) => ((bitmap >> n) & 1) === 1

export function supportedSfs(info: DeviceInfo): number[] {
  return Array.from({ length: 16 }, (_, n) => n).filter((n) => bit(info.sfBitmap, n))
}

export function supportedBws(info: DeviceInfo): number[] {
  return Array.from({ length: 16 }, (_, n) => n).filter((n) => bit(info.bwBitmap, n) && n < LORA_BANDWIDTHS_KHZ.length)
}

/**
 * Problems that would make the device answer EPARAM, checked locally first (§14.2). Without GET_INFO only
 * the enum ranges are checked.
 */
export function validateConfig(c: LoRaConfig, info?: DeviceInfo): string[] {
  const errs: string[] = []
  const int = (v: number) => Number.isInteger(v)
  if (!int(c.freqHz) || c.freqHz <= 0) errs.push('frequency must be a whole number of Hz')
  else if (info && (c.freqHz < info.freqMinHz || c.freqHz > info.freqMaxHz)) {
    errs.push(`frequency must be ${mhz(info.freqMinHz)}–${mhz(info.freqMaxHz)} MHz`)
  }
  if (!int(c.sf) || (info ? !bit(info.sfBitmap, c.sf) : c.sf < 5 || c.sf > 12)) {
    errs.push(`SF${c.sf} is not supported${info ? ` (SF${supportedSfs(info).join(', ')})` : ''}`)
  }
  if (!int(c.bw) || c.bw < 0 || c.bw >= LORA_BANDWIDTHS_KHZ.length || (info && !bit(info.bwBitmap, c.bw))) {
    errs.push('bandwidth is not supported by this radio')
  }
  if (!int(c.cr) || c.cr < 0 || c.cr > 3) errs.push('coding rate must be 4/5 to 4/8')
  if (!int(c.preambleLen) || c.preambleLen < 1 || c.preambleLen > 0xffff) errs.push('preamble must be 1–65535 symbols')
  if (!int(c.syncWord) || c.syncWord < 0 || c.syncWord > 0xffff) errs.push('sync word must be 0x0000–0xFFFF')
  const [pmin, pmax] = info ? [info.txPowerMinDbm, info.txPowerMaxDbm] : [-128, 127]
  if (!int(c.txPowerDbm) || c.txPowerDbm < pmin || c.txPowerDbm > pmax) errs.push(`TX power must be ${pmin}…${pmax} dBm`)
  return errs
}

/** The firmware turns on low data rate optimisation when a symbol lasts over 16 ms (§6.3). */
export function ldro(c: LoRaConfig): boolean {
  return 2 ** c.sf / (bwKHz(c.bw) * 1000) > 0.016
}

/** Semtech AN1200.13 time on air, in microseconds. */
export function airtimeUs(c: LoRaConfig, payloadLen: number): number {
  const tsym = 2 ** c.sf / (bwKHz(c.bw) * 1000)
  const de = ldro(c) ? 1 : 0
  const ih = c.implicitHeader ? 1 : 0
  const crc = c.payloadCrc ? 1 : 0
  // SF5 and SF6 on SX126x need 6.25 preamble symbols over the configured length, not 4.25
  const extra = c.sf <= 6 ? 6.25 : 4.25
  const num = 8 * payloadLen - 4 * c.sf + 28 + 16 * crc - 20 * ih
  const den = 4 * (c.sf - 2 * de)
  const payloadSymbols = 8 + Math.max(Math.ceil(num / den) * (c.cr + 5), 0)
  return Math.round((c.preambleLen + extra + payloadSymbols) * tsym * 1e6)
}
