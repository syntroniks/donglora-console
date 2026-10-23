// DongLoRa Protocol v1.0 constants (protocol-rs/PROTOCOL.md).

/** Message type byte (§4). Host commands have the MSB clear, device frames have it set. */
export const MsgType = {
  Ping: 0x01,
  GetInfo: 0x02,
  SetConfig: 0x03,
  Tx: 0x04,
  RxStart: 0x05,
  RxStop: 0x06,
  Ok: 0x80,
  Err: 0x81,
  Rx: 0xc0,
  TxDone: 0xc1,
} as const

export const MSG_TYPE_NAMES: Record<number, string> = {
  0x01: 'PING',
  0x02: 'GET_INFO',
  0x03: 'SET_CONFIG',
  0x04: 'TX',
  0x05: 'RX_START',
  0x06: 'RX_STOP',
  0x80: 'OK',
  0x81: 'ERR',
  0xc0: 'RX',
  0xc1: 'TX_DONE',
}

/** §7. 0x00xx come back with a command's tag, 0x01xx usually with tag 0. */
export const ErrCode = {
  Param: 0x0001,
  Length: 0x0002,
  NotConfigured: 0x0003,
  Modulation: 0x0004,
  UnknownCmd: 0x0005,
  Busy: 0x0006,
  Radio: 0x0101,
  Frame: 0x0102,
  Internal: 0x0103,
} as const

export const ERR_CODE_NAMES: Record<number, string> = {
  0x0001: 'EPARAM',
  0x0002: 'ELENGTH',
  0x0003: 'ENOTCONFIGURED',
  0x0004: 'EMODULATION',
  0x0005: 'EUNKNOWN_CMD',
  0x0006: 'EBUSY',
  0x0101: 'ERADIO',
  0x0102: 'EFRAME',
  0x0103: 'EINTERNAL',
}

export const ERR_CODE_TEXT: Record<number, string> = {
  0x0001: 'a parameter is out of range',
  0x0002: 'wrong payload length',
  0x0003: 'radio not configured',
  0x0004: 'modulation not supported',
  0x0005: 'unknown command',
  0x0006: 'TX queue full',
  0x0101: 'radio hardware fault',
  0x0102: 'the device got a corrupt frame',
  0x0103: 'firmware internal error',
}

/** §8 */
export const RADIO_CHIP_NAMES: Record<number, string> = {
  0x0000: 'unknown',
  0x0001: 'SX1261',
  0x0002: 'SX1262',
  0x0003: 'SX1268',
  0x0004: 'LLCC68',
  0x0010: 'SX1272',
  0x0011: 'SX1276',
  0x0012: 'SX1277',
  0x0013: 'SX1278',
  0x0014: 'SX1279',
  0x0020: 'SX1280',
  0x0021: 'SX1281',
  0x0030: 'LR1110',
  0x0031: 'LR1120',
  0x0032: 'LR1121',
  0x0040: 'LR2021',
}

/** §9, by bit number. */
export const CAPABILITY_NAMES: Record<number, string> = {
  0: 'LoRa',
  1: 'FSK',
  2: 'GFSK',
  3: 'LR-FHSS',
  4: 'FLRC',
  5: 'MSK',
  6: 'GMSK',
  7: 'BLE-compatible',
  16: 'CAD before TX',
  17: 'IQ inversion',
  18: 'ranging',
  19: 'GNSS scan',
  20: 'WiFi scan',
  21: 'spectral scan',
  22: 'full duplex',
  32: 'multi-client',
}

export const Capability = { LoRa: 0, Cad: 16, IqInvert: 17, FullDuplex: 22, MultiClient: 32 } as const

/** §10 */
export const Modulation = { LoRa: 0x01, Fsk: 0x02, LrFhss: 0x03, Flrc: 0x04 } as const

export const MODULATION_NAMES: Record<number, string> = { 0x01: 'LoRa', 0x02: 'FSK', 0x03: 'LR-FHSS', 0x04: 'FLRC' }

/** LoRa bandwidth enum (§10.1), in kHz. 10-13 are SX128x only. */
export const LORA_BANDWIDTHS_KHZ = [7.81, 10.42, 15.63, 20.83, 31.25, 41.67, 62.5, 125, 250, 500, 200, 400, 800, 1600]

/** LoRa coding-rate enum (§10.1). */
export const LORA_CODING_RATES = ['4/5', '4/6', '4/7', '4/8']

export const SetConfigResult = { Applied: 0, AlreadyMatched: 1, LockedMismatch: 2 } as const
export const SET_CONFIG_RESULT_NAMES = ['APPLIED', 'ALREADY_MATCHED', 'LOCKED_MISMATCH']
export const OWNER_NAMES = ['NONE', 'MINE', 'OTHER']

export const TxResult = { Transmitted: 0, ChannelBusy: 1, Cancelled: 2 } as const
export const TX_RESULT_NAMES = ['TRANSMITTED', 'CHANNEL_BUSY', 'CANCELLED']

/** The device drops to UNCONFIGURED after this long without a frame from the host (§3.4). */
export const INACTIVITY_TIMEOUT_MS = 1000

/** RX metadata ahead of the packet bytes (§6.9). */
export const RX_HEADER_LEN = 20

/** USB ids the firmware enumerates with (firmware/src/host/usb.rs). */
export const USB_VENDOR_ID = 0x1209
export const USB_PRODUCT_ID = 0x5741
