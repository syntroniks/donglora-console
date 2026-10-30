import { describe, expect, it } from 'vitest'
import type { RadioDiag, RadioStatus } from '../src/protocol/messages.ts'
import { buildLabel, radioWedged, wedgeUpdate } from '../src/radio/wedge.ts'

const diag = (over: Partial<RadioDiag> = {}): RadioDiag => ({
  buildId: 0x5f87827e,
  buildDirty: false,
  spiCancels: 0,
  spiZeroReads: 0,
  wedgeRecoveries: 0,
  wedgeStage: 0,
  ...over,
})
const status = (over: Partial<RadioStatus> = {}): RadioStatus => ({ rssiInst: -110, rxGain: 0, femType: 0xff, femFlags: 0, rxOk: 0, rxCrcErr: 0, rxHeaderErr: 0, ...over })

describe('wedgeUpdate', () => {
  it('says nothing while the counters stand still', () => {
    expect(wedgeUpdate(diag(), diag())).toBeUndefined()
    expect(wedgeUpdate(undefined, diag())).toBeUndefined()
    expect(wedgeUpdate(diag(), undefined)).toBeUndefined()
  })

  it('reports a bus reset without reconfiguring: the radio chip was left alone', () => {
    const u = wedgeUpdate(diag(), diag({ wedgeRecoveries: 1, wedgeStage: 1, spiZeroReads: 3 }))
    expect(u?.message).toMatch(/SPI peripheral reset/)
    expect(u?.reconfigure).toBe(false)
  })

  it.each([2, 3])('sends the config again after step %i, which resets the radio chip', (stage) => {
    const u = wedgeUpdate(diag({ wedgeRecoveries: stage - 1, wedgeStage: stage - 1 }), diag({ wedgeRecoveries: stage, wedgeStage: stage }))
    expect(u?.reconfigure).toBe(true)
    expect(u?.message).toMatch(/sending the config again/)
  })

  it('counts several steps taken between two polls, and the u16 counter wrapping', () => {
    expect(wedgeUpdate(diag(), diag({ wedgeRecoveries: 2, wedgeStage: 2 }))?.message).toMatch(/2 recovery steps/)
    expect(wedgeUpdate(diag({ wedgeRecoveries: 0xffff }), diag({ wedgeRecoveries: 0, wedgeStage: 1 }))?.message).toMatch(/a recovery step/)
  })

  it('treats counters that went backwards as a dongle restart, not a wedge', () => {
    expect(wedgeUpdate(diag({ wedgeRecoveries: 9, wedgeStage: 3 }), diag({ wedgeRecoveries: 0 }))).toBeUndefined()
  })

  it('mentions a wedge already underway when the connection starts', () => {
    expect(wedgeUpdate(undefined, diag({ wedgeStage: 2, wedgeRecoveries: 2 }))?.reconfigure).toBe(false)
    expect(wedgeUpdate(undefined, diag({ wedgeStage: 2, wedgeRecoveries: 2 }))?.message).toMatch(/radio reset/)
  })
})

describe('radioWedged', () => {
  it('uses the firmware stage when there is one, and the zero RSSI on older firmware', () => {
    expect(radioWedged(status({ rssiInst: 0 }))).toBe(true)
    expect(radioWedged(status({ rssiInst: null, diag: diag({ wedgeStage: 1 }) }))).toBe(true)
    expect(radioWedged(status({ diag: diag() }))).toBe(false)
    expect(radioWedged(status())).toBe(false)
    expect(radioWedged(undefined)).toBe(false)
  })
})

describe('buildLabel', () => {
  it('shows the commit as 8 hex digits and flags a dirty tree', () => {
    expect(buildLabel(diag())).toBe('5f87827e')
    expect(buildLabel(diag({ buildId: 0x00ab12cd, buildDirty: true }))).toBe('00ab12cd (uncommitted changes)')
    expect(buildLabel(diag({ buildId: 0 }))).toBe('unknown')
  })
})
