import { useMemo, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { LINK_ERROR_NAMES } from '../protocol/client.ts'
import type { MeshDecode } from '../meshcore/decode.ts'
import { HexDump, type HexRegion } from './HexDump.tsx'
import { Button, Card, Empty, Rows, type Row } from './parts.tsx'
import type { LinkEntry, PacketEntry } from './store.ts'
import { coords, db, dbm, hz, level, time } from './format.ts'

type Filter = 'all' | 'decoded' | 'failed' | 'no-key' | 'crc'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'decoded', label: 'Decoded' },
  { id: 'failed', label: 'Failed' },
  { id: 'no-key', label: 'No key' },
  { id: 'crc', label: 'CRC fail' },
]

function matches(p: PacketEntry, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'decoded':
      return p.rx.crcValid && p.mesh.status === 'decoded'
    case 'failed':
      return p.mesh.status === 'partial' || p.mesh.status === 'undecodable'
    case 'no-key':
      return p.mesh.status === 'no-key'
    case 'crc':
      return !p.rx.crcValid
  }
}

const STATUS_LABEL = { decoded: 'decoded', partial: 'partial', undecodable: 'undecodable', 'no-key': 'no key' }

export function StatusBadges({ p }: { p: PacketEntry }) {
  return (
    <span className="badges">
      {!p.rx.crcValid && <span className="badge-s badge-crc" title="The radio's payload CRC failed: the bytes may be corrupt, so the decode is untrusted">CRC fail</span>}
      <span className={`badge-s badge-${p.mesh.status}${p.rx.crcValid ? '' : ' badge-untrusted'}`} title={p.mesh.failure ? `${p.mesh.failure.stage}: ${p.mesh.failure.reason}` : undefined}>
        {STATUS_LABEL[p.mesh.status]}
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
                <tr><th>Time</th><th>RSSI</th><th>SNR</th><th title="Noise under the packet: RSSI − 10·log10(1 + 10^(SNR/10)), whole dBm">Noise</th><th title="Frequency error the SX126x estimated for the packet (always 0 on firmware 1.5.2)">Freq err (Hz)</th><th>CRC</th><th>Len</th><th>Status</th><th>MeshCore</th></tr>
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
                    <td className={`summary ${p.mesh.failure && p.mesh.status !== 'no-key' ? 'err' : ''}`}>
                      {p.mesh.summary}
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

function regionsOf(m: MeshDecode, len: number): HexRegion[] {
  const out: HexRegion[] = [{ from: 0, to: 1, className: 'hx-header', label: 'header' }]
  let pos = 1
  if (m.transportCodes) {
    out.push({ from: 1, to: 5, className: 'hx-transport', label: 'transport codes' })
    pos = 5
  }
  if (m.hops !== undefined || m.failure?.stage === 'path') out.push({ from: pos, to: pos + 1, className: 'hx-pathlen', label: 'path len' })
  if (m.path) out.push({ from: pos + 1, to: pos + 1 + m.path.length / 2, className: 'hx-path', label: 'path' })
  if (m.payloadOffset !== undefined) out.push({ from: m.payloadOffset, to: len, className: 'hx-payload', label: 'payload' })
  return out
}

function PacketDetail({ p, onClose }: { p: PacketEntry; onClose: () => void }) {
  const m = p.mesh
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
  const decode: Row[] = [{ label: 'Status', value: <StatusBadges p={p} /> }]
  if (m.failure) {
    decode.push({
      label: m.status === 'no-key' ? 'Not decrypted' : 'Failed',
      value: <span className={m.status === 'no-key' ? 'muted' : 'err'}>{m.failure.stage} stage, byte {m.failure.offset}: {m.failure.reason}</span>,
    })
  }
  if (m.header) {
    decode.push({ label: 'Type', value: `${m.header.payloadName} (0x${m.header.payloadType.toString(16)}), payload v${m.header.version + 1}` })
    decode.push({ label: 'Route', value: m.header.routeName + (m.transportCodes ? ` · codes ${m.transportCodes.map((c) => c.toString(16).padStart(4, '0')).join(' ')}` : '') })
  }
  if (m.hops !== undefined) decode.push({ label: 'Path', value: m.hops ? `${m.hops} hop${m.hops === 1 ? '' : 's'} × ${m.hashSize} B: ${m.path ? m.path.match(new RegExp(`.{${m.hashSize! * 2}}`, 'g'))?.join(' ') ?? '' : '(not read)'}` : 'direct from the sender (0 hops)' })
  if (m.payloadLength !== undefined) decode.push({ label: 'Payload', value: `${m.payloadLength} bytes from byte ${m.payloadOffset}` })
  const a = m.advert
  if (a) {
    if (a.name !== undefined) decode.push({ label: 'Name', value: a.name || <span className="muted">(empty)</span> })
    if (a.typeName) decode.push({ label: 'Node type', value: a.typeName })
    if (a.publicKey) decode.push({ label: 'Public key', value: <code className="wrap">{a.publicKey}</code> })
    if (a.timestamp !== undefined) decode.push({ label: 'Advert time', value: new Date(a.timestamp * 1000).toLocaleString() })
    if (a.hasLocation) decode.push({ label: 'Position', value: coords(a.lat!, a.lon!) })
    if (a.signatureValid !== undefined) decode.push({ label: 'Signature', value: a.signatureValid ? <span className="ok">valid Ed25519</span> : <span className="err">invalid</span> })
  }
  const g = m.group
  if (g) {
    if (g.channelHash !== undefined) decode.push({ label: 'Channel hash', value: `0x${g.channelHash.toString(16).padStart(2, '0')}${g.channel ? ` (${g.channel})` : ''}` })
    if (g.mac) decode.push({ label: 'MAC', value: <code>{g.mac}</code> })
    if (g.sender !== undefined) decode.push({ label: 'Sender', value: g.sender || <span className="muted">(none)</span> })
    if (g.body !== undefined) decode.push({ label: 'Text', value: g.body })
    if (g.timestamp !== undefined) decode.push({ label: 'Sent', value: new Date(g.timestamp * 1000).toLocaleString() })
    if (g.data !== undefined) decode.push({ label: 'Data', value: <code className="wrap">type 0x{g.dataType!.toString(16)} · {g.data}</code> })
  }
  const d = m.addressed
  if (d) {
    decode.push({ label: 'Addressing', value: `0x${d.srcHash?.toString(16).padStart(2, '0') ?? '??'} → 0x${d.destHash?.toString(16).padStart(2, '0') ?? '??'}` })
    if (d.mac) decode.push({ label: 'MAC', value: <code>{d.mac}</code> })
    if (d.ciphertextLength !== undefined) decode.push({ label: 'Ciphertext', value: `${d.ciphertextLength} bytes (peer-to-peer, not decryptable here)` })
  }
  if (m.ackChecksum) decode.push({ label: 'Ack checksum', value: <code>{m.ackChecksum}</code> })

  return (
    <div className="detail">
      <Card title={`Packet #${p.id}`} actions={<Button kind="small" onClick={onClose}>close</Button>}>
        <Rows rows={radio} />
      </Card>
      <Card title="MeshCore decode">
        <Rows rows={decode} />
      </Card>
      <Card title="Bytes" actions={<Button kind="small" onClick={() => void navigator.clipboard?.writeText(toHex(p.rx.data))}>copy hex</Button>}>
        <HexDump bytes={p.rx.data} regions={regionsOf(m, p.rx.data.length)} mark={m.failure && m.status !== 'no-key' ? m.failure.offset : undefined} />
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
    status: p.mesh.status,
    failure: p.mesh.failure,
    summary: p.mesh.summary,
    meshcore: { ...p.mesh, summary: undefined, failure: undefined, status: undefined },
  }))
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
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
