import { afterEach, describe, expect, it } from 'vitest'
import { groupTextPacket } from '../src/meshcore/build.ts'
import { PUBLIC_CHANNEL } from '../src/meshcore/crypto.ts'
import { decodePacket, DEFAULT_PRESET, matchPreset, PLUGINS, presetById, PRESETS } from '../src/plugins/index.ts'
import type { RxPacket } from '../src/protocol/messages.ts'
import { MOCK_INFO_1_6, MockDongLoRaTransport } from '../src/protocol/transports/mock.ts'
import { RadioStore } from '../src/radio/store.ts'
import { configFromInput } from '../src/radio/summary.ts'

const rx = (data: Uint8Array): RxPacket => ({ rssi: -90, snr: 8, freqErr: 0, timestampUs: 0, crcValid: true, packetsDropped: 0, origin: 0, data })
const preset = (id: string) => presetById(id)!

describe('plugin registry', () => {
  it('ships MeshCore and Meshtastic with unique preset ids', () => {
    expect(PLUGINS.map((p) => p.id)).toEqual(['meshcore', 'meshtastic'])
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length)
    expect(DEFAULT_PRESET.id).toBe('meshcore-us')
  })

  it('finds presets by id or by the id without the plugin prefix, first plugin first', () => {
    expect(presetById('meshtastic-longfast-us')?.plugin).toBe('meshtastic')
    expect(presetById('us')?.id).toBe('meshcore-us')
    expect(presetById('longfast-us')?.id).toBe('meshtastic-longfast-us')
    expect(presetById('nope')).toBeUndefined()
    expect(matchPreset({ ...preset('meshtastic-longfast-us').config, txPowerDbm: 20 })?.id).toBe('meshtastic-longfast-us')
  })

  it('decodes with the plugin that claims the radio config', () => {
    const bytes = groupTextPacket(PUBLIC_CHANNEL, 1_700_000_000, 'alice: hi')
    expect(decodePacket(bytes, rx(bytes), preset('meshcore-us').config)).toMatchObject({ protocol: 'meshcore', status: 'decoded' })
    // the same bytes heard on a Meshtastic config are Meshtastic's to fail on
    expect(decodePacket(bytes, rx(bytes), preset('meshtastic-longfast-us').config).protocol).toBe('meshtastic')
    const lorawan = { ...preset('meshcore-us').config, syncWord: 0x3444 }
    expect(decodePacket(bytes, rx(bytes), lorawan)).toMatchObject({ protocol: 'unknown', status: 'unknown' })
    expect(decodePacket(bytes, rx(bytes), undefined).status).toBe('unknown')
  })

  it('takes config input as a preset id, { preset }, or fields', () => {
    const base = { ...DEFAULT_PRESET.config, txPowerDbm: 17 }
    expect(configFromInput('longfast-us', base)).toEqual({ ...preset('meshtastic-longfast-us').config, txPowerDbm: 17 })
    expect(configFromInput({ preset: 'eu' }, base).freqHz).toBe(preset('meshcore-eu').config.freqHz)
    expect(configFromInput({ sf: 8 }, base)).toEqual({ ...base, sf: 8 })
    expect(() => configFromInput({ sf: '8' }, base)).toThrow(/must be a number/)
    expect(() => configFromInput({ spreading: 8 }, base)).toThrow(/unknown field/)
    expect(() => configFromInput('nope', base)).toThrow(/unknown preset/)
  })
})

describe('plugins through the radio store', () => {
  let store: RadioStore | undefined
  afterEach(async () => {
    await store?.disconnect()
    store = undefined
  })

  async function listen(presetId: string, until: (s: RadioStore) => boolean): Promise<RadioStore> {
    store = new RadioStore()
    store.setRequested(preset(presetId).config)
    await store.connectTransport(new MockDongLoRaTransport({ traffic: true, intervalMs: [10, 20], info: MOCK_INFO_1_6 }), true)
    const end = Date.now() + 5000
    while (!until(store)) {
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(store.getState().stats.status)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    return store
  }

  it('MeshCore: nodes from signed adverts, Public channel posts', async () => {
    const s = await listen('meshcore-us', (x) => Object.keys(x.getState().nodes).length >= 2 && x.getState().messages.length >= 1)
    const st = s.getState()
    for (const n of Object.values(st.nodes)) expect(n).toMatchObject({ protocol: 'meshcore', id: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(st.messages[0]).toMatchObject({ protocol: 'meshcore', channel: 'Public' })
    expect(st.packets.every((p) => p.decode.protocol === 'meshcore')).toBe(true)
  })

  it('Meshtastic: decrypts LongFast, learns names, positions and battery, and text', async () => {
    const s = await listen('meshtastic-longfast-us', (x) => {
      const nodes = Object.values(x.getState().nodes)
      return nodes.some((n) => n.name) && nodes.some((n) => n.lat !== undefined) && nodes.some((n) => n.details.battery) && x.getState().messages.length > 0
    })
    const st = s.getState()
    expect(st.stats.status.decoded).toBe(st.stats.rx)
    const named = Object.values(st.nodes).find((n) => n.name)!
    expect(named).toMatchObject({ protocol: 'meshtastic', id: expect.stringMatching(/^![0-9a-f]{8}$/) })
    const placed = Object.values(st.nodes).find((n) => n.lat !== undefined)!
    expect(placed.lat).toBeGreaterThan(30)
    expect(placed.lon).toBeLessThan(-97)
    expect(st.messages[0]).toMatchObject({ protocol: 'meshtastic', channel: 'LongFast', sender: expect.stringMatching(/^!/) })
  })
})
