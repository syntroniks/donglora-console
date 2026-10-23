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

export const LORA_PARAMS_LEN = 15

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

export function parseErr(p: Uint8Array): number {
  return p.length >= 2 ? p[0] | (p[1] << 8) : -1
}
