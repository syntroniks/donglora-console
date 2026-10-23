import { describe, expect, it } from 'vitest'
import { MOCK_INFO } from '../src/protocol/transports/mock.ts'
import { deviceReported, frontEndFor } from '../src/radio/frontEnd.ts'
import { NoiseFloorTracker, packetNoiseDbm } from '../src/radio/noiseFloor.ts'

describe('per-packet noise', () => {
  it('subtracts the signal share, including at negative SNR', () => {
    expect(packetNoiseDbm(-90, 10)).toBeCloseTo(-100.41, 2)
    expect(packetNoiseDbm(-110, 0)).toBeCloseTo(-113.01, 2)
    expect(packetNoiseDbm(-112, -10)).toBeCloseTo(-112.41, 2)
  })
})

describe('NoiseFloorTracker', () => {
  const feed = (t: NoiseFloorTracker, values: number[], source: 'packet-estimate' | 'measured' = 'packet-estimate', at = 1000) =>
    values.forEach((dbm) => t.add({ at, dbm, source }))

  it('sets the floor after 64 samples, MeshCore style, with a median before that', () => {
    const t = new NoiseFloorTracker()
    t.addPacket(-100, 5, false, 1000) // CRC failed: ignored
    feed(t, Array(63).fill(-110))
    expect(t.snapshot(1000)).toMatchObject({ floor: undefined, pending: 63, median: -110, accepted: 63 })
    feed(t, [-111])
    expect(t.snapshot(1000)).toMatchObject({ floor: -110, pending: 0 }) // trunc(-7041 / 64) = -110
  })

  it('only accepts samples under floor + 14 dB, and clamps at -120', () => {
    const t = new NoiseFloorTracker()
    feed(t, Array(64).fill(-130))
    expect(t.snapshot(1000).floor).toBe(-120)
    feed(t, [-107, -106]) // cut-off is -120 + 14 = -106, exclusive
    expect(t.snapshot(1000)).toMatchObject({ pending: 1, rejected: 1 })
  })

  it('prefers measured samples while they are fresh', () => {
    const t = new NoiseFloorTracker()
    feed(t, [-108])
    feed(t, [-117], 'measured', 5000)
    expect(t.snapshot(6000)).toMatchObject({ source: 'measured', median: -117 })
    expect(t.snapshot(20_000)).toMatchObject({ source: 'packet-estimate', median: -108 })
  })
})

describe('receiver front end', () => {
  it('knows 1.5.2 on an SX1262, says unknown otherwise, and takes device-reported values', () => {
    const fe = frontEndFor(MOCK_INFO)
    expect(fe.rxGain).toMatchObject({ source: 'firmware-default' })
    expect(fe.rxGain.value).toMatch(/^power saving \(0x94/)
    expect(frontEndFor({ ...MOCK_INFO, firmware: { major: 1, minor: 6, patch: 0 } }).rxGain.source).toBe('unknown')
    expect(deviceReported(fe, { rxGain: 'boosted (0x96)' }).rxGain).toEqual({ value: 'boosted (0x96)', source: 'device-reported' })
  })
})
