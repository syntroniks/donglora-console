// Typed payload builders and parsers, one per message layout in PROTOCOL.md §6 and §10.1.

import { ByteReader, ByteWriter, fromHex, toHex } from './bytes.ts'
import { Modulation } from './codes.ts'

export interface DeviceInfo {
  protocol: { major: number; minor: number }
  firmware: { major: number; minor: number; patch: number }
  radioChipId: number
  capabilities: bigint
  sfBitmap: number
  bwBitmap: number
  maxPayloadBytes: number
  rxQueueCapacity: number
  txQueueCapacity: number
  freqMinHz: number
  freqMaxHz: number
  txPowerMinDbm: number
  txPowerMaxDbm: number
  mcuUid: string // hex
  radioUid: string // hex, often empty
}

/** LoRa parameters (§10.1). bw and cr are the wire enums, not kHz or 4/x. */
export interface LoRaConfig {
  freqHz: number
  sf: number
  bw: number
  cr: number
  preambleLen: number
  syncWord: number
  txPowerDbm: number
  implicitHeader: boolean
  payloadCrc: boolean
  iqInvert: boolean
}

export interface SetConfigReply {
  result: number // SetConfigResult
  owner: number
  modulation: number
  params: Uint8Array
  lora?: LoRaConfig // when modulation is LoRa
}

export interface RxPacket {
  rssi: number // dBm
  snr: number // dB
  freqErr: number // Hz
  timestampUs: number // since device boot
  crcValid: boolean
  packetsDropped: number
  origin: number // 0 = over the air, 1 = another client's TX (multi-client only)
  data: Uint8Array
}

export interface TxDone {
  result: number // TxResult
  airtimeUs: number
}

/** RADIO_STATUS reply (v1.1). Counters run from device boot, not from when the host connected. */
export interface RadioStatus {
  /** instantaneous RSSI in dBm (0.5 dB steps), read when the command was handled; null outside continuous RX */
  rssiInst: number | null
  rxGain: number // RxGain
  femType: number // FemType
  femFlags: number // FemFlag bits
  rxOk: number // packets with a good CRC
  rxCrcErr: number // packets with a bad CRC, delivered as RX events with crc_valid = 0
  rxHeaderErr: number // LoRa header errors, never delivered
  /** firmware self-diagnostics appended to the payload; absent from firmware that doesn't send them */
  diag?: RadioDiag
}

/** The block a device may append to RADIO_STATUS at offset 17 (PROTOCOL.md §6.11): which build this is and how the SPI link is doing. */
export interface RadioDiag {
  /** first four bytes of the firmware's git commit; 0 for a build without git metadata */
  buildId: number
  /** built from a tree with uncommitted changes */
  buildDirty: boolean
  /** radio SPI transfers dropped before they finished, since boot */
  spiCancels: number
  /** health samples whose status byte no working SX126x reports (eg. all zeros), since boot */
  spiZeroReads: number
  /** recovery steps the firmware took on a wedged radio, since boot */
  wedgeRecoveries: number
  /** step the current wedge has reached: 0 healthy, then WEDGE_STAGE_NAMES */
  wedgeStage: number
}

/** Recovery steps in the order the firmware tries them; index = RadioDiag.wedgeStage. */
export const WEDGE_STAGE_NAMES = ['healthy', 'SPI peripheral reset', 'radio reset', 'radio power cycle'] as const

export const LORA_PARAMS_LEN = 15
export const RADIO_STATUS_LEN = 17
export const RADIO_DIAG_LEN = 16
/** rssi_inst when the radio isn't in continuous RX (i16::MIN) */
export const RSSI_NOT_AVAILABLE = -0x8000

export function hasCapability(info: DeviceInfo, bit: number): boolean {
  return ((info.capabilities >> BigInt(bit)) & 1n) === 1n
}

export function parseInfo(p: Uint8Array): DeviceInfo {
  const r = new ByteReader(p)
  const protocol = { major: r.u8(), minor: r.u8() }
  const firmware = { major: r.u8(), minor: r.u8(), patch: r.u8() }
  const info = {
    protocol,
    firmware,
    radioChipId: r.u16(),
    capabilities: r.u64(),
    sfBitmap: r.u16(),
    bwBitmap: r.u16(),
    maxPayloadBytes: r.u16(),
    rxQueueCapacity: r.u16(),
    txQueueCapacity: r.u16(),
    freqMinHz: r.u32(),
    freqMaxHz: r.u32(),
    txPowerMinDbm: r.i8(),
    txPowerMaxDbm: r.i8(),
  }
  const mcuUid = toHex(r.take(r.u8()))
  const radioUid = toHex(r.take(r.u8()))
  return { ...info, mcuUid, radioUid }
}

export function encodeInfo(i: DeviceInfo): Uint8Array {
  const mcu = fromHex(i.mcuUid)
  const radio = fromHex(i.radioUid)
  return new ByteWriter()
    .u8(i.protocol.major).u8(i.protocol.minor)
    .u8(i.firmware.major).u8(i.firmware.minor).u8(i.firmware.patch)
    .u16(i.radioChipId).u64(i.capabilities).u16(i.sfBitmap).u16(i.bwBitmap)
    .u16(i.maxPayloadBytes).u16(i.rxQueueCapacity).u16(i.txQueueCapacity)
    .u32(i.freqMinHz).u32(i.freqMaxHz).u8(i.txPowerMinDbm).u8(i.txPowerMaxDbm)
    .u8(mcu.length).bytes(mcu).u8(radio.length).bytes(radio)
    .toBytes()
}

export function encodeLoRaParams(c: LoRaConfig): Uint8Array {
  return new ByteWriter()
    .u32(c.freqHz).u8(c.sf).u8(c.bw).u8(c.cr).u16(c.preambleLen).u16(c.syncWord).u8(c.txPowerDbm)
    .u8(c.implicitHeader ? 1 : 0).u8(c.payloadCrc ? 1 : 0).u8(c.iqInvert ? 1 : 0)
    .toBytes()
}

export function parseLoRaParams(p: Uint8Array): LoRaConfig {
  const r = new ByteReader(p)
  return {
    freqHz: r.u32(),
    sf: r.u8(),
    bw: r.u8(),
    cr: r.u8(),
    preambleLen: r.u16(),
    syncWord: r.u16(),
    txPowerDbm: r.i8(),
    implicitHeader: r.u8() === 1,
    payloadCrc: r.u8() === 1,
    iqInvert: r.u8() === 1,
  }
}

export function setConfigPayload(c: LoRaConfig): Uint8Array {
  return new ByteWriter().u8(Modulation.LoRa).bytes(encodeLoRaParams(c)).toBytes()
}

export function parseSetConfigReply(p: Uint8Array): SetConfigReply {
  const r = new ByteReader(p)
  const result = r.u8()
  const owner = r.u8()
  const modulation = r.u8()
  const params = r.take(r.remaining)
  const lora = modulation === Modulation.LoRa && params.length === LORA_PARAMS_LEN ? parseLoRaParams(params) : undefined
  return { result, owner, modulation, params, lora }
}

/** flags bit 0 = skip CAD; the other bits are reserved and must stay 0 (§6.4). */
export function txPayload(data: Uint8Array, skipCad = false): Uint8Array {
  return new ByteWriter().u8(skipCad ? 1 : 0).bytes(data).toBytes()
}

export function parseRx(p: Uint8Array): RxPacket {
  const r = new ByteReader(p)
  const rssi = r.i16() / 10
  const snr = r.i16() / 10
  const freqErr = r.i32()
  const timestampUs = Number(r.u64())
  const crcValid = r.u8() === 1
  const packetsDropped = r.u16()
  const origin = r.u8()
  return { rssi, snr, freqErr, timestampUs, crcValid, packetsDropped, origin, data: r.take(r.remaining) }
}

export function encodeRx(rx: RxPacket): Uint8Array {
  return new ByteWriter()
    .u16(Math.round(rx.rssi * 10)).u16(Math.round(rx.snr * 10)).u32(rx.freqErr).u64(rx.timestampUs)
    .u8(rx.crcValid ? 1 : 0).u16(rx.packetsDropped).u8(rx.origin).bytes(rx.data)
    .toBytes()
}

export function parseTxDone(p: Uint8Array): TxDone {
  const r = new ByteReader(p)
  return { result: r.u8(), airtimeUs: r.u32() }
}

/** Longer payloads are fine: a later firmware may append fields (§16.4). */
export function parseRadioStatus(p: Uint8Array): RadioStatus {
  const r = new ByteReader(p)
  const raw = r.i16()
  const status: RadioStatus = {
    rssiInst: raw === RSSI_NOT_AVAILABLE ? null : raw / 10,
    rxGain: r.u8(),
    femType: r.u8(),
    femFlags: r.u8(),
    rxOk: r.u32(),
    rxCrcErr: r.u32(),
    rxHeaderErr: r.u32(),
  }
  // a block cut short is ignored, not guessed at; longer payloads from later versions are fine
  if (r.remaining >= RADIO_DIAG_LEN) {
    const buildId = r.u32()
    const flags = r.u8()
    status.diag = {
      buildId,
      buildDirty: (flags & 1) !== 0,
      spiCancels: r.u32(),
      spiZeroReads: r.u32(),
      wedgeRecoveries: r.u16(),
      wedgeStage: r.u8(),
    }
  }
  return status
}

export function encodeRadioStatus(s: RadioStatus): Uint8Array {
  const w = new ByteWriter()
    .u16(s.rssiInst === null ? RSSI_NOT_AVAILABLE : Math.round(s.rssiInst * 10)).u8(s.rxGain).u8(s.femType).u8(s.femFlags)
    .u32(s.rxOk).u32(s.rxCrcErr).u32(s.rxHeaderErr)
  const d = s.diag
  if (d) w.u32(d.buildId).u8(d.buildDirty ? 1 : 0).u32(d.spiCancels).u32(d.spiZeroReads).u16(d.wedgeRecoveries).u8(d.wedgeStage)
  return w.toBytes()
}

export function parseErr(p: Uint8Array): number {
  return p.length >= 2 ? p[0] | (p[1] << 8) : -1
}
