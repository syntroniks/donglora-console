import { useMemo, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { LINK_ERROR_NAMES } from '../protocol/client.ts'
import { pluginById, type ByteRegion, type DecodeField } from '../plugins/index.ts'
import { HexDump, type HexRegion } from './HexDump.tsx'
import { Button, Card, Empty, Rows, type Row } from './parts.tsx'
import type { LinkEntry, PacketEntry } from './store.ts'
import { db, dbm, hz, level, time } from './format.ts'

type Filter = 'all' | 'decoded' | 'failed' | 'no-key' | 'unknown' | 'crc'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'decoded', label: 'Decoded' },
  { id: 'failed', label: 'Failed' },
  { id: 'no-key', label: 'No key' },
  { id: 'unknown', label: 'No plugin' },
  { id: 'crc', label: 'CRC fail' },
]

export const protocolName = (id: string): string => pluginById(id)?.name ?? (id === 'unknown' ? 'no plugin' : id)

function matches(p: PacketEntry, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'decoded':
      return p.rx.crcValid && p.decode.status === 'decoded'
    case 'failed':
      return p.decode.status === 'partial' || p.decode.status === 'undecodable'
    case 'no-key':
      return p.decode.status === 'no-key'
    case 'unknown':
      return p.decode.status === 'unknown'
    case 'crc':
      return !p.rx.crcValid
  }
}

const STATUS_LABEL = { decoded: 'decoded', partial: 'partial', undecodable: 'undecodable', 'no-key': 'no key', unknown: 'no plugin' }

export function StatusBadges({ p }: { p: PacketEntry }) {
  return (
    <span className="badges">
      {!p.rx.crcValid && <span className="badge-s badge-crc" title="The radio's payload CRC failed: the bytes may be corrupt, so the decode is untrusted">CRC fail</span>}
      <span className={`badge-s badge-${p.decode.status}${p.rx.crcValid ? '' : ' badge-untrusted'}`} title={p.decode.failure ? `${p.decode.failure.stage}: ${p.decode.failure.reason}` : undefined}>
        {STATUS_LABEL[p.decode.status]}
      </span>
    </span>
  )
}

export function Packets({ packets, onClear }: { packets: PacketEntry[]; onClear: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [paused, setPaused] = useState<PacketEntry[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const shown = paused ?? packets
  const rows = useMemo(() => shown.filter((p) => matches(p, filter)), [shown, filter])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, packets.filter((p) => matches(p, f.id)).length])), [packets])
  const sel = shown.find((p) => p.id === selected) ?? packets.find((p) => p.id === selected)
  const fresh = paused ? packets.length - paused.length : 0

  return (
    <div className={`split ${sel ? 'split-open' : ''}`}>
      <Card
        title={`Received packets (${packets.length})`}
        actions={
          <>
            <div className="pills">
              {FILTERS.map((f) => (
                <button key={f.id} className={`pill ${filter === f.id ? 'pill-active' : ''} ${f.id === 'crc' || f.id === 'failed' ? 'pill-bad' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="pill-count">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <Button kind="small" onClick={() => setPaused(paused ? null : packets)}>{paused ? `resume${fresh > 0 ? ` (${fresh} new)` : ''}` : 'pause'}</Button>
            <Button kind="small" onClick={() => exportJson(rows, filter)} disabled={!rows.length}>export JSON</Button>
            <Button kind="small" onClick={() => { onClear(); setPaused(null); setSelected(null) }}>clear</Button>
          </>
        }
      >
        {rows.length ? (
          <div className="table-wrap">
            <table className="table packets">
              <thead>
                <tr><th>Time</th><th>RSSI</th><th>SNR</th><th title="Noise under the packet: RSSI − 10·log10(1 + 10^(SNR/10)), whole dBm">Noise</th><th title="Frequency error the SX126x estimated for the packet (always 0 on firmware 1.5.2)">Freq err (Hz)</th><th>CRC</th><th>Len</th><th>Status</th><th>Protocol</th><th>Decode</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={`${p.rx.crcValid ? '' : 'row-crc'} ${p.id === selected ? 'row-selected' : ''}`} onClick={() => setSelected(p.id === selected ? null : p.id)}>
                    <td className="muted">{time(p.at)}</td>
                    <td>{level(p.rx.rssi)}</td>
                    <td>{level(p.rx.snr)}</td>
                    <td className="muted">{p.noise !== undefined ? Math.round(p.noise) : '—'}</td>
                    <td className="muted">{p.rx.freqErr > 0 ? '+' : ''}{p.rx.freqErr}</td>
                    <td>{p.rx.crcValid ? <span className="ok">ok</span> : <span className="err">FAIL</span>}</td>
                    <td>{p.rx.data.length}</td>
                    <td><StatusBadges p={p} /></td>
                    <td className="muted">{protocolName(p.decode.protocol)}</td>
                    <td className={`summary ${p.decode.failure && p.decode.status !== 'no-key' ? 'err' : ''}`}>
                      {p.decode.summary}
                      {p.rx.packetsDropped > 0 && <span className="warn"> · {p.rx.packetsDropped} dropped before</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{packets.length ? 'No packets match this filter.' : 'Every RX event the dongle reports shows up here, including ones with a failed CRC or that don’t decode. Nothing yet.'}</Empty>
        )}
      </Card>
      {sel && <PacketDetail p={sel} onClose={() => setSelected(null)} />}
    </div>
  )
}

const hexRegions = (regions: ByteRegion[]): HexRegion[] => regions.map((r) => ({ from: r.from, to: r.to, className: `hx-${r.kind}`, label: r.label }))

function fieldRow(f: DecodeField): Row {
  const cls = f.tone && f.tone !== 'muted' ? f.tone : undefined
  const value = f.mono ? <code className={`wrap ${cls ?? ''}`}>{f.value}</code> : cls ? <span className={cls}>{f.value}</span> : f.value
  return { label: f.label, value, muted: f.tone === 'muted' }
}

function PacketDetail({ p, onClose }: { p: PacketEntry; onClose: () => void }) {
  const radio: Row[] = [
    { label: 'Received', value: new Date(p.at).toLocaleString() },
    { label: 'RSSI / SNR', value: `${dbm(p.rx.rssi)} · ${db(p.rx.snr)}${p.rx.crcValid ? '' : ' (may be meaningless)'}` },
    { label: 'Noise under packet', value: p.noise !== undefined ? `≈ ${Math.round(p.noise)} dBm (from RSSI and SNR)` : 'not estimated: the CRC failed, so the SNR is unreliable', muted: p.noise === undefined },
    { label: 'Frequency error', value: hz(p.rx.freqErr) },
    { label: 'Device time', value: `${(p.rx.timestampUs / 1e6).toFixed(3)} s since boot` },
    { label: 'Radio CRC', value: p.rx.crcValid ? <span className="ok">passed</span> : <span className="err">failed: the bytes may be corrupt; the decode below is untrusted</span> },
    { label: 'Dropped before', value: p.rx.packetsDropped, muted: !p.rx.packetsDropped },
    { label: 'Length', value: `${p.rx.data.length} bytes` },
  ]
  const d = p.decode
  const decode: Row[] = [{ label: 'Status', value: <StatusBadges p={p} /> }]
  if (d.failure) {
    decode.push({
      label: d.status === 'no-key' ? 'Not decrypted' : 'Failed',
      value: <span className={d.status === 'no-key' ? 'muted' : 'err'}>{d.failure.stage} stage, byte {d.failure.offset}: {d.failure.reason}</span>,
    })
  }
  decode.push(...d.fields.map(fieldRow))

  return (
    <div className="detail">
      <Card title={`Packet #${p.id}`} actions={<Button kind="small" onClick={onClose}>close</Button>}>
        <Rows rows={radio} />
      </Card>
      <Card title={`${protocolName(d.protocol)} decode`}>
        <Rows rows={decode} />
      </Card>
      <Card title="Bytes" actions={<Button kind="small" onClick={() => void navigator.clipboard?.writeText(toHex(p.rx.data))}>copy hex</Button>}>
        <HexDump bytes={p.rx.data} regions={hexRegions(d.regions)} mark={d.failure && d.status !== 'no-key' ? d.failure.offset : undefined} />
      </Card>
    </div>
  )
}

function exportJson(rows: PacketEntry[], filter: Filter): void {
  const data = rows.map((p) => ({
    receivedAt: new Date(p.at).toISOString(),
    rssi: p.rx.rssi,
    snr: p.rx.snr,
    freqErr: p.rx.freqErr,
    timestampUs: p.rx.timestampUs,
    crcValid: p.rx.crcValid,
    packetsDropped: p.rx.packetsDropped,
    hex: toHex(p.rx.data),
    protocol: p.decode.protocol,
    status: p.decode.status,
    failure: p.decode.failure,
    summary: p.decode.summary,
    decode: p.decode.data,
  }))
  // plugin decodes may hold bytes and 64-bit values, which JSON has no form for
  const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v instanceof Uint8Array ? toHex(v) : v)
  const blob = new Blob([JSON.stringify(data, replacer, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `donglora-packets-${filter}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function LinkErrors({ errors, counts, total, onClear }: { errors: LinkEntry[]; counts: Partial<Record<string, number>>; total: number; onClear: () => void }) {
  const [selected, setSelected] = useState<number | null>(null)
  const sel = errors.find((e) => e.id === selected)
  return (
    <div className={`split ${sel ? 'split-open' : ''}`}>
      <Card title={`Link errors (${total})`} actions={<Button kind="small" onClick={() => { onClear(); setSelected(null) }}>clear list</Button>}>
        <p className="muted small">
          Frames from the dongle that failed COBS, length or CRC checks, frame types this console doesn’t know, async ERR
          events, and replies nobody was waiting for. None are dropped quietly.
        </p>
        <div className="kind-counts">
          {Object.entries(LINK_ERROR_NAMES).map(([k, name]) => (
            <span key={k} className={counts[k] ? 'err' : 'muted'}>{name} {counts[k] ?? 0}</span>
          ))}
        </div>
        {errors.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Time</th><th>Kind</th><th>Reason</th><th>Bytes</th></tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <tr key={e.id} className={e.id === selected ? 'row-selected' : ''} onClick={() => setSelected(e.id === selected ? null : e.id)}>
                    <td className="muted">{time(e.at)}</td>
                    <td><span className="badge-s badge-undecodable">{LINK_ERROR_NAMES[e.kind]}</span></td>
                    <td className="err">{e.reason}</td>
                    <td><code className="raw">{toHex(e.bytes.subarray(0, 12), ' ')}{e.bytes.length > 12 ? ' …' : ''}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No link errors.</Empty>
        )}
      </Card>
      {sel && (
        <div className="detail">
          <Card title={`${LINK_ERROR_NAMES[sel.kind]} · ${time(sel.at)}`} actions={<Button kind="small" onClick={() => setSelected(null)}>close</Button>}>
            <p className="err">{sel.reason}</p>
            <p className="muted small">
              {sel.kind === 'cobs' || sel.kind === 'overflow' ? 'Wire bytes as received (COBS-encoded, without the 0x00 delimiter).' : sel.bytes.length ? 'The frame after COBS decoding: type, tag, payload, CRC.' : 'No bytes: the serial port reported the error.'}
              {sel.offset !== undefined && ` Failed at byte ${sel.offset}.`}
            </p>
            {sel.bytes.length > 0 && <HexDump bytes={sel.bytes} mark={sel.offset} />}
          </Card>
        </div>
      )}
    </div>
  )
}
