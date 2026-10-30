// What the firmware's self-diagnostics (RadioDiag, appended to RADIO_STATUS) say about a wedged radio.
// A wedged radio answers every SPI read with zeros while commands still return OK. Firmware that notices
// resets it itself, in steps (WEDGE_STAGE_NAMES), none of which takes the dongle off USB; the console only
// needs to say so, and to send the config again once the firmware has reset the radio chip, which comes back
// unconfigured.

import { WEDGE_STAGE_NAMES, type RadioDiag, type RadioStatus } from '../protocol/messages.ts'

/** Recovery steps from this stage on reset the radio chip, which then needs SET_CONFIG and RX_START again. */
export const STAGE_RADIO_RESET = 2

/**
 * An instantaneous RSSI of exactly 0 dBm: the SX1262 never reports that while listening, but it is what every
 * SPI read returning zeros decodes to. Seen on a RAK4631 whose SPI transfers had wedged: commands still
 * answered OK, RX never fired. Firmware with diagnostics holds back such readings, so this only catches older firmware.
 */
export const radioReadsZero = (s: RadioStatus | undefined): boolean => s?.rssiInst === 0

/** The radio is wedged right now, by either signal. */
export const radioWedged = (s: RadioStatus | undefined): boolean => radioReadsZero(s) || (s?.diag?.wedgeStage ?? 0) > 0

export const stageName = (stage: number): string => WEDGE_STAGE_NAMES[stage] ?? `step ${stage}`

export interface WedgeUpdate {
  message: string
  /** the firmware reset the radio chip, so the config and RX have to be sent again */
  reconfigure: boolean
}

/** Short build label for the UI: the commit as 8 hex digits, marked when built from a dirty tree. */
export const buildLabel = (d: RadioDiag): string => (d.buildId ? d.buildId.toString(16).padStart(8, '0') : 'unknown') + (d.buildDirty ? ' (uncommitted changes)' : '')

/**
 * Compare two consecutive RADIO_STATUS diagnostics. Says something only when the firmware took a recovery step
 * since the last one (the counter is u16 and wraps), or when the first status of a connection finds a wedge underway.
 */
export function wedgeUpdate(prev: RadioDiag | undefined, next: RadioDiag | undefined): WedgeUpdate | undefined {
  if (!next) return undefined
  if (!prev) {
    return next.wedgeStage > 0
      ? { message: `radio is wedged (SPI reads return zeros); the firmware has reached recovery step "${stageName(next.wedgeStage)}"`, reconfigure: false }
      : undefined
  }
  const steps = (next.wedgeRecoveries - prev.wedgeRecoveries + 0x10000) % 0x10000
  // none, or the counter went backwards by more than half its range: the dongle restarted and its counters began again
  if (steps === 0 || steps > 0x8000) return undefined
  const stage = stageName(next.wedgeStage)
  return {
    message:
      `radio wedged (SPI reads return zeros): the firmware took ${steps === 1 ? 'a recovery step' : `${steps} recovery steps`}, now at "${stage}"` +
      ` (${next.spiZeroReads} bad samples, ${next.spiCancels} dropped SPI transfers since boot)` +
      (next.wedgeStage >= STAGE_RADIO_RESET ? '; sending the config again' : ''),
    reconfigure: next.wedgeStage >= STAGE_RADIO_RESET,
  }
}
