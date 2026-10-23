// MeshCore over-the-air constants (MeshCore src/MeshCore.h, src/Packet.h, docs/packet_format.md).

export const ROUTE_TYPE_NAMES = ['transport-flood', 'flood', 'direct', 'transport-direct'] as const

export const PayloadType = {
  Request: 0x00,
  Response: 0x01,
  Text: 0x02,
  Ack: 0x03,
  Advert: 0x04,
  GroupText: 0x05,
  GroupData: 0x06,
  AnonRequest: 0x07,
  Path: 0x08,
  Trace: 0x09,
  Multipart: 0x0a,
  Control: 0x0b,
  RawCustom: 0x0f,
} as const

export const PAYLOAD_TYPE_NAMES: Record<number, string> = {
  0x00: 'request',
  0x01: 'response',
  0x02: 'text',
  0x03: 'ack',
  0x04: 'advert',
  0x05: 'group-text',
  0x06: 'group-data',
  0x07: 'anon-request',
  0x08: 'path',
  0x09: 'trace',
  0x0a: 'multipart',
  0x0b: 'control',
  0x0f: 'raw-custom',
}

export const ADV_TYPE_NAMES: Record<number, string> = {
  0: 'none',
  1: 'companion',
  2: 'repeater',
  3: 'room server',
  4: 'sensor',
}

/** Only payload version 1 (0b00 in the header) exists so far. */
export const PAYLOAD_VERSION_1 = 0

export const PUB_KEY_SIZE = 32
export const SIGNATURE_SIZE = 64
export const CIPHER_MAC_SIZE = 2
export const CIPHER_BLOCK_SIZE = 16
export const MAX_PATH_SIZE = 64
export const MAX_PACKET_PAYLOAD = 184

/** Longest message text, in bytes (BaseChatMesh.h). Channel posts also spend "<name>: " of it. */
export const MAX_TEXT_LEN = 160

/** Advert appdata flag bits (helpers/AdvertDataHelpers.h). */
export const AdvFlag = { TypeMask: 0x0f, LatLon: 0x10, Feat1: 0x20, Feat2: 0x40, Name: 0x80 } as const
