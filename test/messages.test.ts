import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from '../src/protocol/bytes.ts'
import { airtimeUs, ldro, validateConfig } from '../src/protocol/lora.ts'
import {
  encodeInfo,
  encodeRadioStatus,
  encodeRx,
  parseErr,
  parseInfo,
  parseRadioStatus,
  parseRx,
  parseSetConfigReply,
  parseTxDone,
  setConfigPayload,
  txPayload,
  type LoRaConfig,
} from '../src/protocol/messages.ts'
import { DEFAULT_PRESET, matchPreset } from '../src/meshcore/presets.ts'
import { MOCK_INFO } from '../src/protocol/transports/mock.ts'

// payloads from Appendix C (pre-COBS frame minus type, tag and CRC)
const C22_INFO = '01 00 00 01 00 02 00 03 00 01 00 00 00 00 00 E0 1F FF 03 FF 00 40 00 10 00 80 D1 F0 08 00 70 38 39 F7 16 08 DE AD BE EF 01 23 45 67 00'
const C23_CONFIG = '01 A0 27 BE 33 07 07 00 08 00 24 14 0E 00 01 00'
const C23_REPLY = '00 01 01 A0 27 BE 33 07 07 00 08 00 24 14 0E 00 01 00'

const eu868: LoRaConfig = {
  freqHz: 868_100_000,
  sf: 7,
  bw: 7,
  cr: 0,
  preambleLen: 8,
  syncWord: 0x1424,
  txPowerDbm: 14,
  implicitHeader: false,
  payloadCrc: true,
  iqInvert: false,
}

describe('GET_INFO', () => {
  it('parses the C.2.2 reply', () => {
    const i = parseInfo(fromHex(C22_INFO))
    expect(i).toMatchObject({
      protocol: { major: 1, minor: 0 },
      firmware: { major: 0, minor: 1, patch: 0 },
      radioChipId: 2,
      capabilities: 0x10003n,
      sfBitmap: 0x1fe0,
      bwBitmap: 0x03ff,
      maxPayloadBytes: 255,
      rxQueueCapacity: 64,
      txQueueCapacity: 16,
      freqMinHz: 150_000_000,
      freqMaxHz: 960_000_000,
      txPowerMinDbm: -9,
      txPowerMaxDbm: 22,
      mcuUid: 'deadbeef01234567',
      radioUid: '',
    })
    expect(toHex(encodeInfo(i), ' ').toUpperCase()).toBe(C22_INFO)
  })

  it('throws on a truncated reply (the client turns this into a link error)', () => {
    expect(() => parseInfo(fromHex(C22_INFO).subarray(0, 20))).toThrow(RangeError)
  })
})

describe('SET_CONFIG', () => {
  it('builds the C.2.3 LoRa payload', () => {
    expect(toHex(setConfigPayload(eu868), ' ').toUpperCase()).toBe(C23_CONFIG)
  })

  it('parses the echo', () => {
    const r = parseSetConfigReply(fromHex(C23_REPLY))
    expect(r).toMatchObject({ result: 0, owner: 1, modulation: 1, lora: eu868 })
  })

  it('builds the MeshCore USA/Canada preset', () => {
    const c = DEFAULT_PRESET.config
    expect(c).toMatchObject({ freqHz: 910_525_000, sf: 7, bw: 6, cr: 0, preambleLen: 32, syncWord: 0x1424, implicitHeader: false, payloadCrc: true, iqInvert: false })
    expect(toHex(setConfigPayload(c), ' ')).toBe('01 48 82 45 36 07 06 00 20 00 24 14 0a 00 01 00')
    expect(matchPreset({ ...c, txPowerDbm: 2 })?.id).toBe('meshcore-us')
  })
})

describe('validateConfig against GET_INFO', () => {
  it('accepts the preset', () => {
    expect(validateConfig(DEFAULT_PRESET.config, MOCK_INFO)).toEqual([])
  })

  it('catches each out-of-range field', () => {
    const bad = { ...DEFAULT_PRESET.config, freqHz: 2_450_000_000, sf: 4, bw: 11, cr: 4, preambleLen: 0, syncWord: 0x10000, txPowerDbm: 23 }
    const problems = validateConfig(bad, MOCK_INFO)
    expect(problems).toHaveLength(7)
    expect(problems[0]).toBe('frequency must be 150.000–960.000 MHz')
    expect(problems.at(-1)).toBe('TX power must be -9…22 dBm')
  })

  it('uses the SF bitmap, not a range', () => {
    expect(validateConfig({ ...DEFAULT_PRESET.config, sf: 12 }, { ...MOCK_INFO, sfBitmap: 0x0fe0 })).toEqual(['SF12 is not supported (SF5, 6, 7, 8, 9, 10, 11)'])
  })
})

describe('RX, TX_DONE, ERR, TX', () => {
  it('parses the C.2.6 RX event', () => {
    const rx = parseRx(fromHex('21 FD 5F 00 83 FF FF FF 80 DE 80 02 00 00 00 00 01 00 00 00 01 02 03 04'))
    expect(rx).toMatchObject({ rssi: -73.5, snr: 9.5, freqErr: -125, timestampUs: 42_000_000, crcValid: true, packetsDropped: 0, origin: 0 })
    expect([...rx.data]).toEqual([1, 2, 3, 4])
    expect(toHex(encodeRx(rx), ' ').toUpperCase()).toBe('21 FD 5F 00 83 FF FF FF 80 DE 80 02 00 00 00 00 01 00 00 00 01 02 03 04')
  })

  it('keeps crc_valid=0 packets and the dropped count (C.6.2, C.6.3)', () => {
    expect(parseRx(fromHex('E6 FB B0 FF 98 08 00 00 00 0E 27 07 00 00 00 00 00 00 00 00 41 42 FF 00 CC'))).toMatchObject({ rssi: -105, snr: -8, freqErr: 2200, crcValid: false })
    expect(parseRx(fromHex('26 FD 64 00 32 00 00 00 A0 45 C7 07 00 00 00 00 01 03 00 00 01 02')).packetsDropped).toBe(3)
  })

  it('parses TX_DONE and ERR', () => {
    expect(parseTxDone(fromHex('00 00 79 00 00'))).toEqual({ result: 0, airtimeUs: 30976 })
    expect(parseErr(fromHex('03 00'))).toBe(3)
    expect(parseErr(fromHex('01 01'))).toBe(0x0101)
  })

  it('builds TX with only the skip-CAD flag bit', () => {
    expect([...txPayload(fromHex('48 65 6C 6C 6F'))]).toEqual([0, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
    expect(txPayload(Uint8Array.of(1), true)[0]).toBe(1)
  })
})

describe('airtime', () => {
  it('matches the C.2.4 example (SF7, 125 kHz, 5 bytes, preamble 8)', () => {
    expect(airtimeUs(eu868, 5)).toBe(30976)
  })

  it('turns on LDRO when symbols pass 16 ms', () => {
    expect(ldro({ ...eu868, sf: 10 })).toBe(false)
    expect(ldro({ ...eu868, sf: 11 })).toBe(true) // 2048 / 125 kHz = 16.4 ms
  })
})

describe('RADIO_STATUS self-diagnostics', () => {
  const base = { rssiInst: -112.5, rxGain: 0, femType: 0xff, femFlags: 0, rxOk: 3, rxCrcErr: 2, rxHeaderErr: 1 }
  const diag = { buildId: 0x5f87827e, buildDirty: true, spiCancels: 7, spiZeroReads: 0x01020304, wedgeRecoveries: 513, wedgeStage: 2 }

  it('round-trips with and without the diagnostics block', () => {
    expect(encodeRadioStatus(base)).toHaveLength(17)
    expect(parseRadioStatus(encodeRadioStatus(base))).toEqual(base)
    const full = encodeRadioStatus({ ...base, diag })
    expect(full).toHaveLength(33)
    expect(parseRadioStatus(full)).toEqual({ ...base, diag })
  })

  it('reads the block at the offsets the protocol gives', () => {
    const bytes = encodeRadioStatus({ ...base, diag })
    // build_id little-endian at 17, flags at 21, wedge_recoveries u16 at 30, stage at 32
    expect([...bytes.subarray(17, 21)]).toEqual([0x7e, 0x82, 0x87, 0x5f])
    expect(bytes[21]).toBe(1)
    expect([...bytes.subarray(30, 32)]).toEqual([0x01, 0x02])
    expect(bytes[32]).toBe(2)
  })

  it('ignores a block that is cut short instead of guessing at it', () => {
    const bytes = encodeRadioStatus({ ...base, diag })
    expect(parseRadioStatus(bytes.subarray(0, 32)).diag).toBeUndefined()
    expect(parseRadioStatus(bytes.subarray(0, 32)).rxOk).toBe(3)
  })
})
