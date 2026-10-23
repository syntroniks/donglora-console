import { useEffect, useMemo, useRef, useState } from 'react'
import { CAPABILITY_NAMES, MODULATION_NAMES, OWNER_NAMES, RADIO_CHIP_NAMES, SET_CONFIG_RESULT_NAMES } from '../protocol/codes.ts'
import { LINK_ERROR_NAMES } from '../protocol/client.ts'
import { bwKHz, mhz, supportedBws, supportedSfs } from '../protocol/lora.ts'
import type { DecodeStage } from '../meshcore/decode.ts'
import { configRows } from './configRows.ts'
import { Card, Empty, Rows } from './parts.tsx'
import type { RadioState } from './store.ts'
import { ago, coords, db, dbm, duration, plural, shortKey, time } from './format.ts'

/** re-render every second, for "x ago" and uptime */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const STAGES: { stage: DecodeStage; label: string }[] = [
  { stage: 'header', label: 'Header (truncated, unknown version)' },
  { stage: 'path', label: 'Path (truncated, reserved hash size, too long)' },
  { stage: 'payload', label: 'Payload (truncated, unknown type)' },
  { stage: 'advert', label: 'Advert fields' },
  { stage: 'signature', label: 'Advert signature' },
  { stage: 'mac', label: 'Channel MAC' },
  { stage: 'decrypt', label: 'Decrypt / plaintext' },
]

export function Overview({ state }: { state: RadioState }) {
  const now = useNow()
  const { info, applied, stats: st, health: h } = state
  const avg = (sum: number) => (st.good ? sum / st.good : undefined)
  const rssiAvg = avg(st.rssiSum)
  const snrAvg = avg(st.snrSum)
  const caps = info
    ? Object.entries(CAPABILITY_NAMES)
        .filter(([bit]) => ((info.capabilities >> BigInt(bit)) & 1n) === 1n)
        .map(([, name]) => name)
    : []
  const failed = st.status.partial + st.status.undecodable
  const keepaliveOk = h && h.lastOkAt && now - h.lastOkAt < 2000
  return (
    <div className="grid">
      <Card title="Connection">
        <Rows
          rows={[
            { label: 'Status', value: <span className={state.status === 'connected' ? 'ok' : 'muted'}>{state.status}{state.demo ? ' (demo)' : ''}</span> },
            { label: 'Port', value: state.label ?? '…', muted: !state.label },
            { label: 'Connected', value: state.connectedAt ? `${duration((now - state.connectedAt) / 1000)}` : '…', muted: !state.connectedAt },
            { label: 'Receiving', value: state.rxOn ? <span className="ok">yes</span> : 'no' },
            { label: 'TX', value: state.txArmed ? <span className="err">ARMED</span> : 'disarmed' },
          ]}
        />
      </Card>
      <Card title="Device (GET_INFO)">
        {info ? (
          <Rows
            rows={[
              { label: 'Firmware', value: `DongLoRa ${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}, protocol ${info.protocol.major}.${info.protocol.minor}` },
              { label: 'Radio', value: `${RADIO_CHIP_NAMES[info.radioChipId] ?? 'unknown'} (0x${info.radioChipId.toString(16).padStart(4, '0')})` },
              { label: 'Capabilities', value: `${caps.join(', ')} (0x${info.capabilities.toString(16)})` },
              { label: 'Frequency', value: `${mhz(info.freqMinHz)}–${mhz(info.freqMaxHz)} MHz` },
              { label: 'TX power', value: `${info.txPowerMinDbm}…${info.txPowerMaxDbm} dBm` },
              { label: 'SF', value: supportedSfs(info).map((s) => `SF${s}`).join(' ') },
              { label: 'Bandwidth', value: `${supportedBws(info).map(bwKHz).join(', ')} kHz` },
              { label: 'Max payload', value: `${info.maxPayloadBytes} bytes` },
              { label: 'Queues', value: `RX ${info.rxQueueCapacity} · TX ${info.txQueueCapacity}` },
              { label: 'MCU UID', value: <code>{info.mcuUid || '(none)'}</code> },
              { label: 'Radio UID', value: <code>{info.radioUid || '(none)'}</code>, muted: !info.radioUid },
            ]}
          />
        ) : (
          <Empty>Not read yet.</Empty>
        )}
      </Card>
      <Card title="Applied config (device echo)">
        {applied ? (
          <>
            <Rows
              rows={[
                { label: 'Result', value: `${SET_CONFIG_RESULT_NAMES[applied.result] ?? applied.result} · owner ${OWNER_NAMES[applied.owner] ?? applied.owner}` },
                { label: 'Modulation', value: MODULATION_NAMES[applied.modulation] ?? `0x${applied.modulation.toString(16)}` },
                ...(applied.lora ? configRows(applied.lora) : []),
              ]}
            />
          </>
        ) : (
          <Empty>No SET_CONFIG yet.</Empty>
        )}
      </Card>
      <Card title="Live stats">
        <Rows
          rows={[
            { label: 'RX events', value: st.rx },
            { label: 'CRC failures', value: <span className={st.crcFail ? 'err' : undefined}>{st.crcFail}{st.rx ? ` (${((st.crcFail / st.rx) * 100).toFixed(0)}%)` : ''}</span> },
            { label: 'Dropped by device', value: <span className={st.dropped ? 'warn' : undefined}>{st.dropped}</span> },
            { label: 'Last packet', value: st.last ? `${dbm(st.last.rssi)} · ${db(st.last.snr)} · ${ago(st.last.at, now)}` : '…', muted: !st.last },
            { label: 'RSSI avg (range)', value: rssiAvg !== undefined ? `${dbm(rssiAvg)} (${st.rssiMin}…${st.rssiMax})` : '…', muted: rssiAvg === undefined },
            { label: 'SNR avg (range)', value: snrAvg !== undefined ? `${db(snrAvg)} (${st.snrMin}…${st.snrMax})` : '…', muted: snrAvg === undefined },
          ]}
        />
        <p className="muted small">Averages and ranges count only packets with a good CRC.</p>
      </Card>
      <Card title="Decode results">
        <Rows
          rows={[
            { label: 'Decoded', value: <span className="ok">{st.status.decoded}</span> },
            { label: 'Partial', value: <span className={st.status.partial ? 'warn' : undefined}>{st.status.partial}</span> },
            { label: 'Undecodable', value: <span className={st.status.undecodable ? 'err' : undefined}>{st.status.undecodable}</span> },
            { label: 'No key', value: st.status['no-key'], muted: true },
            ...STAGES.map((s) => ({ label: `  ${s.label}`, value: <span className={st.stages[s.stage] ? 'err' : 'muted'}>{st.stages[s.stage] ?? 0}</span> })),
          ]}
        />
        <p className="muted small">{failed} failed of {st.rx}; CRC-failed packets are decoded too, and counted here.</p>
      </Card>
      <Card title={`Link errors (${st.linkTotal})`}>
        <Rows rows={Object.entries(LINK_ERROR_NAMES).map(([k, name]) => ({ label: name, value: <span className={st.link[k as keyof typeof st.link] ? 'err' : 'muted'}>{st.link[k as keyof typeof st.link] ?? 0}</span> }))} />
      </Card>
      <Card title="Keepalive">
        {h ? (
          <Rows
            rows={[
              { label: 'Health', value: keepaliveOk ? <span className="ok">ok</span> : <span className="err">no PING reply for {ago(h.lastOkAt, now)}</span> },
              { label: 'PINGs', value: `${h.pings} ok, ${h.failures} failed` },
              { label: 'Round trip', value: h.lastRttMs !== undefined ? `${h.lastRttMs.toFixed(1)} ms (avg ${h.avgRttMs?.toFixed(1)})` : '…' },
              { label: 'Longest write gap', value: <span className={h.maxGapMs > 900 ? 'err' : undefined}>{h.maxGapMs} ms</span> },
              { label: 'Sessions lost', value: <span className={h.lostSessions ? 'warn' : undefined}>{h.lostSessions} ({h.recoveries} restored)</span> },
            ]}
          />
        ) : (
          <Empty>Starts once connected.</Empty>
        )}
        <p className="muted small">The dongle resets after 1000 ms without a frame. PINGs go every 400 ms from a Worker timer, so a background tab keeps them.</p>
      </Card>
      <Card title="Session log">
        {state.log.length ? (
          <ul className="mini-log">
            {state.log.slice(0, 12).map((e, i) => (
              <li key={`${e.at}-${i}`} className={e.level === 'info' ? undefined : e.level}>
                <span className="muted">{time(e.at)}</span> {e.text}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing yet.</Empty>
        )}
      </Card>
    </div>
  )
}

export function Nodes({ state }: { state: RadioState }) {
  const now = useNow(5000)
  const nodes = useMemo(() => Object.values(state.nodes).sort((a, b) => b.lastHeard - a.lastHeard), [state.nodes])
  return (
    <Card title={`Heard nodes (${nodes.length})`}>
      {nodes.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Last heard</th><th>RSSI</th><th>SNR</th><th>Hops</th><th>Position</th><th>Key</th><th>Adverts</th></tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.publicKey}>
                  <td>{n.name || <span className="muted">(no name)</span>}</td>
                  <td>{n.typeName}</td>
                  <td className="muted" title={`advert timestamp ${new Date(n.advertTimestamp * 1000).toLocaleString()}`}>{ago(n.lastHeard, now)}</td>
                  <td>{n.rssi.toFixed(1)}</td>
                  <td>{n.snr.toFixed(1)}</td>
                  <td>{n.hops}</td>
                  <td>{n.lat !== undefined && n.lon !== undefined ? coords(n.lat, n.lon) : <span className="muted">—</span>}</td>
                  <td><code title={n.publicKey}>{shortKey(n.publicKey)}</code></td>
                  <td>{n.adverts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nodes appear when their advert arrives with a good CRC and a valid signature.</Empty>
      )}
    </Card>
  )
}

export function Channel({ state }: { state: RadioState }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [state.posts.length])
  return (
    <div className="channel">
      <div className="thread-head">
        <span className="thread-title">Public</span>
        <span className="muted small">read-only · decrypted with the default Public key · senders are unverified</span>
      </div>
      <div className="thread-list">
        {state.posts.length ? (
          state.posts.map((p) => (
            <div key={p.id} className="bubble bubble-in">
              {p.sender && <div className="bubble-from">{p.sender}</div>}
              <div className="bubble-text">{p.body}</div>
              <div className="bubble-meta">
                <span>{new Date(p.timestamp * 1000).toLocaleTimeString([], { hour12: false })}</span>
                <span>{plural(p.hops, 'hop')}</span>
                <span>{p.rssi.toFixed(0)} dBm · SNR {p.snr.toFixed(1)}</span>
              </div>
            </div>
          ))
        ) : (
          <Empty>Public channel posts show up here as they’re heard.</Empty>
        )}
        <div ref={end} />
      </div>
    </div>
  )
}
