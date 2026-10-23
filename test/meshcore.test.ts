import { describe, expect, it } from 'vitest'
import { DongLoRaClient, type LinkError } from '../src/protocol/client.ts'
import type { RxPacket } from '../src/protocol/messages.ts'
import { FAILURE_KINDS, GOOD_KINDS, LINK_FAULT_KINDS, MockDongLoRaTransport, type PacketKind } from '../src/protocol/transports/mock.ts'
import { groupTextPacket } from '../src/meshcore/build.ts'
import { makeChannel, PUBLIC_CHANNEL } from '../src/meshcore/crypto.ts'
import { decodeMeshCore } from '../src/meshcore/decode.ts'
import { DEFAULT_PRESET } from '../src/meshcore/presets.ts'

// what each packet kind the mock can hear must decode to: [status, failed stage, reason]
const EXPECT: Record<PacketKind, [string, string?, RegExp?]> = {
  advert: ['decoded'],
  'group-text': ['decoded'],
  text: ['decoded'],
  ack: ['decoded'],
  path: ['decoded'],
  'crc-fail': ['any'], // corrupt bytes: any outcome, but always delivered
  truncated: ['undecodable', 'path', /^truncated: path needs 5 bytes/],
  'reserved-hash': ['undecodable', 'path', /^reserved hash-size code 3/],
  'long-path': ['undecodable', 'path', /path is 80 bytes \(40 hops × 2\), over the 64-byte limit/],
  'bad-version': ['undecodable', 'header', /unknown payload version 2/],
  'unknown-type': ['partial', 'payload', /unknown payload type 0x0d/],
  'advert-truncated': ['partial', 'advert', /^truncated: advert is \d+ bytes, key \+ timestamp \+ signature need 100/],
  'bad-signature': ['partial', 'signature', /signature doesn't match/],
  'no-key': ['no-key', 'channel', /^no key for channel hash 0x/],
  'bad-mac': ['partial', 'mac', /^MAC [0-9a-f]{4} doesn't match the Public/],
  'bad-decrypt': ['partial', 'decrypt', /ciphertext is \d+ bytes, not a multiple of 16/],
}

describe('every packet kind, through the mock, the client and the decoder', async () => {
  const mock = new MockDongLoRaTransport()
  const client = new DongLoRaClient(mock, { ticker: () => ({ stop() {} }) })
  const heard: RxPacket[] = []
  const linkErrors: LinkError[] = []
  client.on('rx', (p) => heard.push(p))
  client.on('linkError', (e) => linkErrors.push(e))
  await client.connect()
  await client.setConfig(DEFAULT_PRESET.config)
  await client.rxStart()
  const next = (fn: () => void) => {
    const n = heard.length + linkErrors.length
    fn()
    return new Promise<void>((r) => setTimeout(r, 0)).then(() => expect(heard.length + linkErrors.length).toBe(n + 1))
  }

  it.each([...GOOD_KINDS, ...FAILURE_KINDS])('%s', async (kind) => {
    await next(() => mock.inject(kind))
    const rx = heard[heard.length - 1]
    expect(rx.crcValid).toBe(kind !== 'crc-fail')
    const d = decodeMeshCore(rx.data)
    const [status, stage, reason] = EXPECT[kind]
    if (status === 'any') return
    expect(d.status).toBe(status)
    expect(d.failure?.stage).toBe(stage)
    if (reason) expect(d.failure!.reason).toMatch(reason)
    if (d.failure) expect(d.failure.offset).toBeLessThanOrEqual(rx.data.length)
    expect(d.header).toBeDefined() // even failures keep what parsed
  })

  it.each(LINK_FAULT_KINDS)('link fault %s', async (kind) => {
    await next(() => mock.linkFault(kind))
    expect(linkErrors[linkErrors.length - 1].kind).toBe(kind === 'async-err' ? 'async-err' : kind)
  })
})

describe('decoder edge cases', () => {
  it('keeps the parsed fields of a packet that fails later', () => {
    const d = decodeMeshCore(Uint8Array.of(0x11, 0x02, 0xaa, 0xbb, 0x01, 0x02)) // advert, 2 hops, 2-byte payload
    expect(d).toMatchObject({ status: 'partial', hops: 2, path: 'aabb', payloadOffset: 4, advert: {} })
    expect(d.failure).toMatchObject({ stage: 'advert', offset: 6 })
  })

  it('reports an empty packet and missing transport codes', () => {
    expect(decodeMeshCore(new Uint8Array(0)).failure).toMatchObject({ stage: 'header', reason: 'empty packet' })
    expect(decodeMeshCore(Uint8Array.of(0x14, 1)).failure).toMatchObject({ stage: 'header', offset: 2 })
  })

  it('decrypts Public channel text and tells channels apart by key', () => {
    expect(PUBLIC_CHANNEL.hash).toBe(0x11)
    const pkt = groupTextPacket(PUBLIC_CHANNEL, 1_760_000_000, 'Maya: hello mesh')
    expect(decodeMeshCore(pkt).group).toMatchObject({ channel: 'Public', sender: 'Maya', body: 'hello mesh', timestamp: 1_760_000_000 })
    const other = makeChannel('#test', '00112233445566778899aabbccddeeff')
    expect(decodeMeshCore(pkt, { channels: [other] }).status).toBe(other.hash === 0x11 ? 'partial' : 'no-key')
    expect(decodeMeshCore(groupTextPacket(other, 1, 'x: y'), { channels: [PUBLIC_CHANNEL, other] }).group?.channel).toBe('#test')
  })
})
