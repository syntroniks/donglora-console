import { bwKHz, crText, ldro, mhz, syncWordHex } from '../protocol/lora.ts'
import type { LoRaConfig } from '../protocol/messages.ts'
import { matchPreset } from '../plugins/index.ts'
import type { Row } from './parts.tsx'

export function configRows(c: LoRaConfig): Row[] {
  const preset = matchPreset(c)
  return [
    { label: 'Frequency', value: `${mhz(c.freqHz)} MHz` },
    { label: 'SF · BW · CR', value: `SF${c.sf} · ${bwKHz(c.bw)} kHz · CR ${crText(c.cr)}${ldro(c) ? ' · LDRO' : ''}` },
    { label: 'Preamble', value: `${c.preambleLen} symbols` },
    { label: 'Sync word', value: syncWordHex(c.syncWord) },
    { label: 'TX power', value: `${c.txPowerDbm} dBm (chip setting)` },
    { label: 'Header / CRC / IQ', value: `${c.implicitHeader ? 'implicit' : 'explicit'} · CRC ${c.payloadCrc ? 'on' : 'off'} · IQ ${c.iqInvert ? 'inverted' : 'normal'}` },
    { label: 'Preset', value: preset?.name ?? 'custom', muted: !preset },
  ]
}
