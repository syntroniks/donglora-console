// Meshtastic packet decoding: header, channel by hash, AES-CTR with each key for that hash, the Data message,
// then the app payload. Never throws; like the MeshCore decoder, a failure keeps what parsed before it.

import { toHex } from '../../protocol/bytes.ts'
import type { ByteRegion, DecodeField, DecodeFailure, DecodeStatus, PacketDecode } from '../types.ts'
import { decodeApp, type AppDecode } from './apps.ts'
import { enumName, PORTNUM_NAMES, portLabel, TELEMETRY_VARIANT_NAMES } from './codes.ts'
import { aesCtr, DEFAULT_CHANNELS, type MeshtasticChannel } from './crypto.ts'
import { BROADCAST, HEADER_LEN, hopsTaken, nodeId, parseData, parseHeader, type MeshtasticData, type MeshtasticHeader } from './packet.ts'
import { ProtoError } from './proto.ts'

export type MeshtasticStage = 'header' | 'channel' | 'decrypt' | 'data' | 'app'

/** The structured decode, as PacketDecode.data. */
export interface MeshtasticDecode {
  status: DecodeStatus
  failure?: DecodeFailure
  header?: MeshtasticHeader
  hops?: number
  /** name of the channel whose key decrypted the packet */
  channel?: string
  data?: MeshtasticData
  portName?: string
  app?: AppDecode
}

export interface DecodeOptions {
  /** defaults to every modem preset's default channel */
  channels?: MeshtasticChannel[]
}

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`
const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`
const dest = (n: number) => (n === BROADCAST ? 'all' : nodeId(n))
const yesNo = (b: boolean) => (b ? 'yes' : 'no')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function decodeMeshtastic(raw: Uint8Array, options: DecodeOptions = {}): PacketDecode {
  const m: MeshtasticDecode = { status: 'decoded' }
  let stage: MeshtasticStage = 'header'
  try {
    run(m, raw, options.channels ?? DEFAULT_CHANNELS, (s) => (stage = s))
  } catch (err) {
    // a bug, not a bad packet; still report it as a failure at the stage it happened in
    m.failure = { stage, reason: `decoder error: ${errText(err)}`, offset: 0 }
    m.status = stage === 'header' ? 'undecodable' : 'partial'
  }
  return { protocol: 'meshtastic', status: m.status, summary: summaryOf(m, raw), failure: m.failure, fields: fieldsOf(m, raw), regions: regionsOf(m, raw), data: m }
}

function run(m: MeshtasticDecode, raw: Uint8Array, channels: MeshtasticChannel[], at: (s: MeshtasticStage) => void): void {
  const fail = (stage: MeshtasticStage, reason: string, offset: number, status: DecodeStatus = stage === 'header' ? 'undecodable' : 'partial') => {
    m.failure = { stage, reason, offset }
    m.status = status
  }

  // ---- header ----
  if (raw.length < HEADER_LEN) return fail('header', `truncated: ${raw.length} bytes, the header alone is ${HEADER_LEN}`, raw.length)
  const h = parseHeader(raw)
  m.header = h
  m.hops = hopsTaken(h)

  // ---- channel ----
  at('channel')
  const candidates = channels.filter((c) => c.hash === h.channel)
  if (!candidates.length) {
    // PKI direct messages (firmware 2.5+) go out with channel 0 and the recipient's public key instead
    const pki = h.channel === 0 && h.to !== BROADCAST ? '; channel 0 on a direct message is usually PKI-encrypted' : ''
    return fail('channel', `no key for channel hash ${hex2(h.channel)}${pki}`, 13, 'no-key')
  }

  // ---- decrypt, and Data: the firmware's only test of the key is whether Data parses ----
  at('decrypt')
  const ct = raw.subarray(HEADER_LEN)
  let firstErr: ProtoError | undefined
  for (const c of candidates) {
    try {
      m.data = parseData(aesCtr(c.key, h.id, h.from, ct), HEADER_LEN)
      m.channel = c.name
      break
    } catch (err) {
      if (!(err instanceof ProtoError)) throw err
      firstErr ??= err
    }
  }
  const d = m.data
  if (!d) {
    const names = candidates.map((c) => c.name).join(', ')
    // an unencrypted channel has no key to blame
    if (candidates.every((c) => c.key.length === 0)) return fail('data', `Data message on ${names} doesn't parse: ${firstErr!.message}`, firstErr!.offset)
    const keys = candidates.length === 1 ? `the ${names} key` : `any of the ${names} keys`
    return fail('decrypt', `${keys} for hash ${hex2(h.channel)} gives no valid Data message (${firstErr!.message}); another channel with the same hash, or corrupt`, HEADER_LEN)
  }
  m.portName = enumName(PORTNUM_NAMES, d.portnum)

  // ---- app ----
  at('app')
  try {
    m.app = decodeApp(d.portnum, d.payload, d.payloadOffset)
  } catch (err) {
    if (!(err instanceof ProtoError)) throw err
    return fail('app', `${m.portName}: ${err.message}`, err.offset)
  }
}

function routeOf(m: MeshtasticDecode): string {
  const h = m.header!
  const parts = [m.channel ?? `channel ${hex2(h.channel)}`]
  parts.push(m.hops === undefined ? `hop limit ${h.hopLimit}` : m.hops === 0 ? 'direct' : plural(m.hops, 'hop'))
  if (h.viaMqtt) parts.push('via MQTT')
  return parts.join(', ')
}

const pct = (v: number) => `${v.toFixed(1)}%`
const battery = (v: number) => (v > 100 ? 'external power' : `${v}%`)

function appSummary(m: MeshtasticDecode): string {
  const a = m.app!
  const d = m.data!
  switch (a.kind) {
    case 'text':
      return JSON.stringify(a.text)
    case 'position':
      return a.lat !== undefined && a.lon !== undefined ? `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}${a.altitude !== undefined ? `, ${a.altitude} m` : ''}` : 'no position'
    case 'nodeinfo':
      return [a.longName !== undefined ? JSON.stringify(a.longName) : '(no name)', a.shortName ? `(${a.shortName})` : '', a.hwModelName, a.roleName].filter(Boolean).join(' ')
    case 'routing': {
      const what = a.variant === 'error' ? (a.errorReason === 0 ? 'ack' : (a.errorName ?? '')) : a.variant
      return d.requestId ? `${what} for ${hex8(d.requestId)}` : what
    }
    case 'telemetry': {
      const parts: string[] = []
      const dm = a.device
      if (dm?.batteryLevel !== undefined) parts.push(`battery ${battery(dm.batteryLevel)}`)
      if (dm?.voltage !== undefined) parts.push(`${dm.voltage.toFixed(2)} V`)
      if (dm?.channelUtilization !== undefined) parts.push(`ch util ${pct(dm.channelUtilization)}`)
      const e = a.environment
      if (e?.temperature !== undefined) parts.push(`${e.temperature.toFixed(1)} °C`)
      if (e?.relativeHumidity !== undefined) parts.push(`${e.relativeHumidity.toFixed(0)}% RH`)
      if (e?.barometricPressure !== undefined) parts.push(`${e.barometricPressure.toFixed(1)} hPa`)
      if (!parts.length) parts.push(a.variant !== undefined ? enumName(TELEMETRY_VARIANT_NAMES, a.variant) : 'empty')
      return parts.join(', ')
    }
    case 'traceroute':
      return a.route.length ? `via ${a.route.map(nodeId).join(', ')}` : 'no hops recorded'
    case 'neighborinfo':
      return plural(a.neighbors.length, 'neighbor')
    case 'other':
      return `portnum ${d.portnum}, ${plural(a.size, 'byte')}`
  }
}

function summaryOf(m: MeshtasticDecode, raw: Uint8Array): string {
  const h = m.header
  if (!h) return `Meshtastic packet: ${m.failure?.reason ?? 'not decoded'}`
  const what = `${m.data ? portLabel(m.data.portnum) : 'packet'} ${nodeId(h.from)} → ${dest(h.to)}`
  if (m.status === 'no-key') return `${what}: ${raw.length - HEADER_LEN} B encrypted, no key · ${routeOf(m)}`
  const body = m.app ? appSummary(m) : (m.failure?.reason ?? '')
  return `${what}: ${body} · ${routeOf(m)}`
}

function fieldsOf(m: MeshtasticDecode, raw: Uint8Array): DecodeField[] {
  const f: DecodeField[] = []
  const h = m.header
  if (!h) {
    f.push({ label: 'Length', value: `${raw.length} bytes, a Meshtastic header is ${HEADER_LEN}`, tone: 'err' })
    return f
  }
  f.push({ label: 'From', value: nodeId(h.from), mono: true })
  f.push({ label: 'To', value: h.to === BROADCAST ? `${nodeId(h.to)} (broadcast)` : nodeId(h.to), mono: true })
  f.push({ label: 'Packet id', value: hex8(h.id), mono: true })
  f.push(m.hops !== undefined ? { label: 'Hops', value: m.hops ? String(m.hops) : '0 (heard direct)' } : { label: 'Hops', value: h.hopStart ? `unknown: hop start ${h.hopStart} is under hop limit ${h.hopLimit}` : 'unknown (no hop start)', tone: 'muted' })
  f.push({ label: 'Hop limit', value: String(h.hopLimit) })
  f.push(h.hopStart ? { label: 'Hop start', value: String(h.hopStart) } : { label: 'Hop start', value: 'not set (firmware before 2.3)', tone: 'muted' })
  f.push({ label: 'Want ack', value: yesNo(h.wantAck) })
  f.push({ label: 'Via MQTT', value: yesNo(h.viaMqtt) })
  f.push({ label: 'Channel hash', value: hex2(h.channel), mono: true })
  if (m.channel) f.push({ label: 'Channel', value: m.channel, tone: 'ok' })
  else if (m.status === 'no-key') f.push({ label: 'Channel', value: 'unknown: no key for this hash', tone: 'warn' })
  f.push(h.nextHop ? { label: 'Next hop', value: hex2(h.nextHop), mono: true } : { label: 'Next hop', value: 'not set', tone: 'muted' })
  f.push(h.relayNode ? { label: 'Relay node', value: `…${h.relayNode.toString(16).padStart(2, '0')} (last byte of its id)`, mono: true } : { label: 'Relay node', value: 'not set', tone: 'muted' })
  f.push({ label: 'Encrypted', value: `${raw.length - HEADER_LEN} bytes from byte ${HEADER_LEN}` })

  const d = m.data
  if (!d) return f
  f.push({ label: 'Portnum', value: `${d.portnum} ${m.portName}` })
  if (d.wantResponse) f.push({ label: 'Want response', value: 'yes' })
  if (d.dest !== undefined) f.push({ label: 'Data dest', value: nodeId(d.dest), mono: true })
  if (d.source !== undefined) f.push({ label: 'Data source', value: nodeId(d.source), mono: true })
  if (d.requestId !== undefined) f.push({ label: 'Request id', value: hex8(d.requestId), mono: true })
  if (d.replyId !== undefined) f.push({ label: 'Reply to', value: hex8(d.replyId), mono: true })
  if (d.emoji) f.push({ label: 'Emoji reaction', value: 'yes' })
  if (d.bitfield !== undefined) f.push({ label: 'Bitfield', value: `${hex2(d.bitfield)}${d.bitfield & 1 ? ' (OK to MQTT)' : ''}`, mono: true })

  const a = m.app
  if (!a) {
    f.push({ label: 'Payload', value: toHex(d.payload, ' ') || '(empty)', mono: true })
    return f
  }
  appFields(a, d, f)
  return f
}

function appFields(a: AppDecode, d: MeshtasticData, f: DecodeField[]): void {
  const opt = (label: string, v: string | undefined, mono = false) => {
    if (v !== undefined) f.push({ label, value: v, mono })
  }
  const time = (t: number | undefined) => (t ? new Date(t * 1000).toISOString() : undefined)
  switch (a.kind) {
    case 'text':
      f.push({ label: 'Text', value: a.text })
      return
    case 'position':
      if (a.lat === undefined && a.lon === undefined) f.push({ label: 'Position', value: 'none', tone: 'muted' })
      opt('Latitude', a.lat?.toFixed(7))
      opt('Longitude', a.lon?.toFixed(7))
      opt('Altitude', a.altitude !== undefined ? `${a.altitude} m` : undefined)
      opt('Position time', time(a.time))
      return
    case 'nodeinfo':
      opt('User id', a.id, true)
      opt('Long name', a.longName)
      opt('Short name', a.shortName)
      f.push({ label: 'Hardware', value: `${a.hwModelName} (${a.hwModel})` })
      f.push({ label: 'Role', value: `${a.roleName} (${a.role})` })
      opt('Public key', a.publicKey ? toHex(a.publicKey) : undefined, true)
      return
    case 'routing':
      if (a.variant === 'error') f.push({ label: 'Routing', value: a.errorReason === 0 ? 'ack (NONE)' : `${a.errorName} (${a.errorReason})`, tone: a.errorReason === 0 ? 'ok' : 'warn' })
      else f.push({ label: 'Routing', value: a.variant })
      if (a.route) opt('Route', a.route.route.map(nodeId).join(' → ') || '(none)')
      return
    case 'telemetry': {
      opt('Telemetry time', time(a.time))
      if (a.variant !== undefined) f.push({ label: 'Telemetry', value: enumName(TELEMETRY_VARIANT_NAMES, a.variant) })
      const dm = a.device
      if (dm) {
        opt('Battery', dm.batteryLevel !== undefined ? battery(dm.batteryLevel) : undefined)
        opt('Voltage', dm.voltage?.toFixed(3).concat(' V'))
        opt('Channel utilization', dm.channelUtilization !== undefined ? pct(dm.channelUtilization) : undefined)
        opt('Airtime TX', dm.airUtilTx !== undefined ? pct(dm.airUtilTx) : undefined)
        opt('Uptime', dm.uptimeSeconds !== undefined ? duration(dm.uptimeSeconds) : undefined)
      }
      const e = a.environment
      if (e) {
        opt('Temperature', e.temperature?.toFixed(1).concat(' °C'))
        opt('Humidity', e.relativeHumidity?.toFixed(1).concat('%'))
        opt('Pressure', e.barometricPressure?.toFixed(1).concat(' hPa'))
      }
      return
    }
    case 'traceroute': {
      const snr = (s: number[]) => (s.length ? ` · SNR ${s.map((x) => (x / 4).toFixed(2)).join(', ')} dB` : '')
      f.push({ label: 'Route', value: (a.route.map(nodeId).join(' → ') || '(no hops recorded)') + snr(a.snrTowards) })
      if (a.routeBack.length || a.snrBack.length) f.push({ label: 'Route back', value: (a.routeBack.map(nodeId).join(' → ') || '(no hops)') + snr(a.snrBack) })
      return
    }
    case 'neighborinfo':
      opt('Reporting node', a.nodeId !== undefined ? nodeId(a.nodeId) : undefined, true)
      f.push({ label: 'Neighbors', value: String(a.neighbors.length) })
      return
    case 'other':
      f.push({ label: 'Payload', value: `${plural(a.size, 'byte')}: ${toHex(d.payload, ' ')}`, mono: true })
      return
  }
}

function duration(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const min = Math.floor((s % 3600) / 60)
  return `${d ? `${d}d ` : ''}${h}h ${min}m (${s} s)`
}

function regionsOf(m: MeshtasticDecode, raw: Uint8Array): ByteRegion[] {
  if (!m.header) return raw.length ? [{ from: 0, to: raw.length, kind: 'header', label: 'truncated header' }] : []
  const out: ByteRegion[] = [
    { from: 0, to: 4, kind: 'address', label: 'to' },
    { from: 4, to: 8, kind: 'address', label: 'from' },
    { from: 8, to: 12, kind: 'meta', label: 'packet id' },
    { from: 12, to: 13, kind: 'meta', label: 'flags' },
    { from: 13, to: 14, kind: 'meta', label: 'channel hash' },
    { from: 14, to: 15, kind: 'meta', label: 'next hop' },
    { from: 15, to: 16, kind: 'meta', label: 'relay node' },
  ]
  if (raw.length > HEADER_LEN) out.push({ from: HEADER_LEN, to: raw.length, kind: 'payload', label: m.data ? `encrypted Data (${m.portName})` : 'encrypted Data' })
  return out
}
