import { useState } from 'react'
import { fromHex } from '../protocol/bytes.ts'
import { LORA_BANDWIDTHS_KHZ, LORA_CODING_RATES, TX_RESULT_NAMES } from '../protocol/codes.ts'
import { describeConfig, mhz, supportedBws, supportedSfs, syncWordHex, validateConfig } from '../protocol/lora.ts'
import type { LoRaConfig } from '../protocol/messages.ts'
import { matchPreset, PRESETS } from '../meshcore/presets.ts'
import { FRONT_END_ROWS, FRONT_END_SOURCE_LABELS, frontEndFor } from '../radio/frontEnd.ts'
import { configRows } from './configRows.ts'
import { Button, Card, Empty, Rows } from './parts.tsx'
import { store, type RadioState } from './store.ts'

interface Form {
  freqMHz: string
  sf: string
  bw: string
  cr: string
  preambleLen: string
  syncWord: string
  txPowerDbm: string
  implicitHeader: boolean
  payloadCrc: boolean
  iqInvert: boolean
}

const toForm = (c: LoRaConfig): Form => ({
  freqMHz: mhz(c.freqHz),
  sf: String(c.sf),
  bw: String(c.bw),
  cr: String(c.cr),
  preambleLen: String(c.preambleLen),
  syncWord: syncWordHex(c.syncWord),
  txPowerDbm: String(c.txPowerDbm),
  implicitHeader: c.implicitHeader,
  payloadCrc: c.payloadCrc,
  iqInvert: c.iqInvert,
})

const fromForm = (f: Form): LoRaConfig => ({
  freqHz: Math.round(Number(f.freqMHz) * 1e6),
  sf: Number(f.sf),
  bw: Number(f.bw),
  cr: Number(f.cr),
  preambleLen: Number(f.preambleLen),
  syncWord: /^(0x)?[0-9a-f]{1,4}$/i.test(f.syncWord.trim()) ? parseInt(f.syncWord.trim().replace(/^0x/i, ''), 16) : NaN,
  txPowerDbm: Number(f.txPowerDbm),
  implicitHeader: f.implicitHeader,
  payloadCrc: f.payloadCrc,
  iqInvert: f.iqInvert,
})

export function FemCaveat() {
  return (
    <p className="caveat">
      <strong>Heltec V4:</strong> the board has an external front-end module (GC1109 or KCT8103L PA/LNA). DongLoRa 1.5.2
      never drives its control pins (GPIO7 LDO, GPIO2 CSD, GPIO46 CPS / GPIO5 CTX), unlike MeshCore. The dBm value is the
      SX1262’s own setting, not antenna output, and receive sensitivity may be lower than under MeshCore firmware.
    </p>
  )
}

export function RadioView({ state }: { state: RadioState }) {
  const [form, setForm] = useState<Form>(() => toForm(state.requested))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const connected = state.status === 'connected'
  const info = state.info
  const config = fromForm(form)
  const problems = validateConfig(config, info)
  const preset = matchPreset(config)
  const sfs = info ? supportedSfs(info) : [5, 6, 7, 8, 9, 10, 11, 12]
  const bws = info ? supportedBws(info) : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }))

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const echo = state.applied?.lora
  const diff = echo ? (Object.keys(config) as (keyof LoRaConfig)[]).filter((k) => echo[k] !== state.requested[k]) : []

  return (
    <div className="grid grid-wide">
      <Card
        title="Radio config"
        actions={
          <Button kind="primary" disabled={!connected || busy || problems.length > 0} onClick={() => void run(() => store.applyConfig(config))}>
            {busy ? 'applying…' : 'Apply (SET_CONFIG)'}
          </Button>
        }
      >
        <div className="form">
          <label className="field field-wide">
            <span>Preset</span>
            <select value={preset?.id ?? 'custom'} onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)
              if (p) setForm(toForm({ ...p.config, txPowerDbm: config.txPowerDbm }))
            }}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {describeConfig(p.config)}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="field">
            <span>Frequency (MHz)</span>
            <input type="number" step="0.001" value={form.freqMHz} onChange={(e) => set({ freqMHz: e.target.value })} />
          </label>
          <label className="field">
            <span>Spreading factor</span>
            <select value={form.sf} onChange={(e) => set({ sf: e.target.value })}>
              {sfs.map((s) => <option key={s} value={s}>SF{s}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Bandwidth</span>
            <select value={form.bw} onChange={(e) => set({ bw: e.target.value })}>
              {bws.map((b) => <option key={b} value={b}>{LORA_BANDWIDTHS_KHZ[b]} kHz</option>)}
            </select>
          </label>
          <label className="field">
            <span>Coding rate</span>
            <select value={form.cr} onChange={(e) => set({ cr: e.target.value })}>
              {LORA_CODING_RATES.map((c, i) => <option key={c} value={i}>{c}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Preamble (symbols)</span>
            <input type="number" min={1} value={form.preambleLen} onChange={(e) => set({ preambleLen: e.target.value })} />
          </label>
          <label className="field">
            <span>Sync word</span>
            <input type="text" value={form.syncWord} onChange={(e) => set({ syncWord: e.target.value })} />
          </label>
          <label className="field">
            <span>TX power (dBm)</span>
            <input type="number" min={info?.txPowerMinDbm} max={info?.txPowerMaxDbm} value={form.txPowerDbm} onChange={(e) => set({ txPowerDbm: e.target.value })} />
          </label>
          <div className="field field-wide flags">
            <label><input type="checkbox" checked={form.implicitHeader} onChange={(e) => set({ implicitHeader: e.target.checked })} /> implicit header</label>
            <label><input type="checkbox" checked={form.payloadCrc} onChange={(e) => set({ payloadCrc: e.target.checked })} /> payload CRC</label>
            <label><input type="checkbox" checked={form.iqInvert} onChange={(e) => set({ iqInvert: e.target.checked })} /> invert IQ</label>
          </div>
        </div>
        <p className="muted small">
          MeshCore uses a 32-symbol preamble up to SF8 and 16 above it, sync word 0x1424 (RadioLib private 0x12),
          explicit header, CRC on, normal IQ. TX power only matters when transmitting, but SET_CONFIG needs a value.
          {!info && ' Connect to check against what this radio supports.'}
        </p>
        <FemCaveat />
        {problems.length > 0 && <ul className="problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {error && <p className="editor-error">{error}</p>}
      </Card>

      <Card
        title="Device echo"
        actions={
          <>
            <span className={`muted small ${state.rxOn ? 'ok' : ''}`}>{state.rxOn ? 'receiving' : 'idle'}</span>
            <Button kind="small" disabled={!connected || busy || state.rxOn} onClick={() => void run(() => store.startRx())}>RX start</Button>
            <Button kind="small" disabled={!connected || busy || !state.rxOn} onClick={() => void run(() => store.stopRx())}>RX stop</Button>
          </>
        }
      >
        {echo ? (
          <>
            <Rows rows={configRows(echo)} />
            {diff.length ? (
              <p className="err small">The device is running something other than what was asked for: {diff.join(', ')}.</p>
            ) : (
              <p className="ok small">Matches what was requested.</p>
            )}
          </>
        ) : (
          <Empty>SET_CONFIG’s reply shows what the radio is actually running. Nothing applied yet.</Empty>
        )}
      </Card>

      <FrontEndCard state={state} />
      <TxCard state={state} />
    </div>
  )
}

function FrontEndCard({ state }: { state: RadioState }) {
  const fe = frontEndFor(state.info)
  return (
    <Card title="Receiver front end">
      <Rows
        rows={FRONT_END_ROWS.map(({ key, label }) => ({
          label,
          value: (
            <span title={fe[key].note}>
              {fe[key].value}{' '}
              <span className={`badge-s ${fe[key].source === 'device-reported' ? 'badge-measured' : 'badge-source'}`}>{FRONT_END_SOURCE_LABELS[fe[key].source]}</span>
            </span>
          ),
          muted: fe[key].source === 'unknown',
        }))}
      />
      <p className="note">
        {state.info ? `Firmware ${fe.firmware}, board ${fe.board}${fe.boardAssumed ? ' (assumed: GET_INFO doesn’t name the board)' : ''}. ` : 'Connect to look up this firmware. '}
        No DongLoRa firmware reports these yet; the values come from reading its source. Hover a value for where.
      </p>
    </Card>
  )
}

function TxCard({ state }: { state: RadioState }) {
  const [hex, setHex] = useState('')
  const [result, setResult] = useState<string>()
  const [error, setError] = useState<string>()
  const connected = state.status === 'connected'
  const c = state.applied?.lora
  let bytes: Uint8Array | null = null
  try {
    bytes = hex.trim() ? fromHex(hex) : null
  } catch {
    bytes = null
  }

  const arm = (on: boolean) => {
    setError(undefined)
    try {
      store.armTx(on)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const send = async () => {
    if (!bytes || !c) return
    const ok = window.confirm(
      `Transmit ${bytes.length} bytes on ${mhz(c.freqHz)} MHz, SF${c.sf}, at ${c.txPowerDbm} dBm (SX1262 setting)?\n\n` +
        'The firmware enforces no regulatory limits. You are responsible for being allowed to transmit on this frequency.',
    )
    if (!ok) return
    setError(undefined)
    setResult('sending…')
    try {
      const done = await store.transmit(bytes)
      setResult(`${TX_RESULT_NAMES[done.result] ?? done.result}${done.airtimeUs ? `, ${(done.airtimeUs / 1000).toFixed(1)} ms on air` : ''}`)
    } catch (err) {
      setResult(undefined)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card title="Transmit" actions={state.txArmed ? <span className="badge-s badge-crc">ARMED</span> : <span className="muted small">off</span>}>
      <label className={`arm ${state.txArmed ? 'arm-on' : ''}`}>
        <input type="checkbox" checked={state.txArmed} disabled={!connected} onChange={(e) => arm(e.target.checked)} />
        <span>
          Enable TX{c ? ` on ${mhz(c.freqHz)} MHz at ${c.txPowerDbm} dBm (chip setting)` : ''}
        </span>
      </label>
      <FemCaveat />
      <p className="muted small">Off by default and on every new connection. Each send asks again.</p>
      <div className="editor-line">
        <input className="hex-input" placeholder="packet bytes in hex" value={hex} onChange={(e) => setHex(e.target.value)} disabled={!state.txArmed} />
        <Button kind="small" disabled={!state.txArmed || !bytes || !c} onClick={() => void send()}>send…</Button>
      </div>
      {hex.trim() && !bytes && <p className="editor-error">not valid hex</p>}
      {result && <p className="small">{result}</p>}
      {error && <p className="editor-error">{error}</p>}
    </Card>
  )
}
