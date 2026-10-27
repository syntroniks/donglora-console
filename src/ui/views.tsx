import { useEffect, useMemo, useRef, useState } from 'react'
import { CAPABILITY_NAMES, MODULATION_NAMES, OWNER_NAMES, RADIO_CHIP_NAMES, SET_CONFIG_RESULT_NAMES } from '../protocol/codes.ts'
import { LINK_ERROR_NAMES } from '../protocol/client.ts'
import { bwKHz, mhz, supportedBws, supportedSfs } from '../protocol/lora.ts'
import { pluginById, stageLabel } from '../plugins/index.ts'
import { TX_POWER_MEANING_LABELS, txPowerMeaning } from '../radio/frontEnd.ts'
import { MEDIAN_WINDOW, NOISE_SOURCE_LABELS, NUM_NOISE_FLOOR_SAMPLES } from '../radio/noiseFloor.ts'
import { NoiseChart } from './NoiseChart.tsx'
import { configRows } from './configRows.ts'
import { Card, Empty, Rows } from './parts.tsx'
import { radioStatusAvailable, type RadioState } from './store.ts'
import { ago, coords, db, dbm, duration, level, plural, shortKey, time } from './format.ts'

/** re-render every second, for "x ago" and uptime */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const protocolName = (id: string) => pluginById(id)?.name ?? id

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
  const keepaliveCmd = h?.command ?? 'PING'
  const power = txPowerMeaning(info, state.radioStatus)
  // LoRa header errors the radio counted since this connection's first RADIO_STATUS (or a stats reset)
  const headerErrs = state.radioStatus && state.countersBase ? state.radioStatus.rxHeaderErr - state.countersBase.rxHeaderErr : undefined
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
              { label: 'TX power', value: `${info.txPowerMinDbm}…${info.txPowerMaxDbm} dBm${power === 'unknown' ? '' : ` (${TX_POWER_MEANING_LABELS[power]})`}` },
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
            { label: 'RSSI avg (range)', value: rssiAvg !== undefined ? `${Math.round(rssiAvg)} dBm (${st.rssiMin}…${st.rssiMax})` : '…', muted: rssiAvg === undefined },
            { label: 'SNR avg (range)', value: snrAvg !== undefined ? `${snrAvg.toFixed(0)} dB (${st.snrMin}…${st.snrMax})` : '…', muted: snrAvg === undefined },
          ]}
        />
        <p className="muted small">Averages and ranges count only packets with a good CRC.</p>
        {info && info.firmware.major === 1 && info.firmware.minor <= 5 && (
          <p className="note">
            DongLoRa {info.firmware.major}.{info.firmware.minor}.{info.firmware.patch} rounds RSSI and SNR to whole dB, always reports
            a frequency error of 0, and drops packets whose CRC fails before they reach the host (firmware/src/radio.rs), so
            “CRC fail” only shows up with other firmware or the demo radio.
          </p>
        )}
        {info && (info.firmware.major > 1 || info.firmware.minor >= 6) && (
          <p className="muted small">
            DongLoRa {info.firmware.major}.{info.firmware.minor}.{info.firmware.patch} delivers packets whose CRC failed (shown as CRC fail) and
            reports the SX126x frequency error in Hz. RSSI and SNR are still whole dB.
          </p>
        )}
      </Card>
      <CountersCard state={state} now={now} />
      <NoiseCard state={state} now={now} />
      <Card title="Decode results">
        <Rows
          rows={[
            { label: 'Decoded', value: <span className="ok">{st.status.decoded}</span> },
            { label: 'Partial', value: <span className={st.status.partial ? 'warn' : undefined}>{st.status.partial}</span> },
            { label: 'Undecodable', value: <span className={st.status.undecodable ? 'err' : undefined}>{st.status.undecodable}</span> },
            { label: 'No key', value: st.status['no-key'], muted: true },
            { label: 'No plugin for the config', value: st.status.unknown, muted: true },
            ...(headerErrs !== undefined
              ? [{ label: '  LoRa header (radio count, no bytes)', value: <span className={headerErrs ? 'err' : 'muted'}>{headerErrs}</span> }]
              : []),
            ...Object.entries(st.stages)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, n]) => ({ label: `  ${stageLabel(key)}`, value: <span className={n && !key.endsWith('/channel') ? 'err' : 'muted'}>{n ?? 0}</span> })),
          ]}
        />
        <p className="muted small">
          {failed} failed of {st.rx}; CRC-failed packets are decoded too, and counted here, by plugin and the stage they stopped at.
          {headerErrs !== undefined && ' LoRa header errors come from the radio’s counter (RADIO_STATUS, since connect): the header didn’t decode, so no bytes reach the host and they aren’t in the RX count.'}
        </p>
      </Card>
      <Card title={`Link errors (${st.linkTotal})`}>
        <Rows rows={Object.entries(LINK_ERROR_NAMES).map(([k, name]) => ({ label: name, value: <span className={st.link[k as keyof typeof st.link] ? 'err' : 'muted'}>{st.link[k as keyof typeof st.link] ?? 0}</span> }))} />
      </Card>
      <Card title="Keepalive">
        {h ? (
          <Rows
            rows={[
              { label: 'Health', value: keepaliveOk ? <span className="ok">ok</span> : <span className="err">no {keepaliveCmd} reply for {ago(h.lastOkAt, now)}</span> },
              { label: 'Keepalives', value: `${h.pings} ok, ${h.failures} failed · ${keepaliveCmd}` },
              { label: 'Round trip', value: h.lastRttMs !== undefined ? `${h.lastRttMs.toFixed(1)} ms (avg ${h.avgRttMs?.toFixed(1)})` : '…' },
              { label: 'Longest write gap', value: <span className={h.maxGapMs > 900 ? 'err' : undefined}>{h.maxGapMs} ms</span> },
              { label: 'Sessions lost', value: <span className={h.lostSessions ? 'warn' : undefined}>{h.lostSessions} ({h.recoveries} restored)</span> },
            ]}
          />
        ) : (
          <Empty>Starts once connected.</Empty>
        )}
        <p className="muted small">
          The dongle resets after 1000 ms without a frame. A keepalive goes every 400 ms from a Worker timer, so a background tab keeps it:
          RADIO_STATUS when the firmware has it (1.6.0), which also samples RSSI and the front end, otherwise PING.
        </p>
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
              <tr><th>Name</th><th>Protocol</th><th>Kind</th><th>Last heard</th><th>RSSI</th><th>SNR</th><th>Hops</th><th>Position</th><th>ID</th><th>Heard</th><th>Details</th></tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={`${n.protocol}:${n.id}`}>
                  <td>{n.name || <span className="muted">(no name)</span>}{n.shortName && <span className="muted"> · {n.shortName}</span>}</td>
                  <td className="muted">{protocolName(n.protocol)}</td>
                  <td>{n.kind ?? <span className="muted">—</span>}</td>
                  <td className="muted" title={`first heard ${new Date(n.firstHeard).toLocaleString()}`}>{ago(n.lastHeard, now)}</td>
                  <td>{level(n.rssi)}</td>
                  <td>{level(n.snr)}</td>
                  <td>{n.hops ?? <span className="muted">—</span>}</td>
                  <td>{n.lat !== undefined && n.lon !== undefined ? coords(n.lat, n.lon) : <span className="muted">—</span>}</td>
                  <td><code title={n.id}>{n.id.startsWith('!') ? n.id : shortKey(n.id)}</code></td>
                  <td>{n.sightings}</td>
                  <td className="muted small">{Object.entries(n.details).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nodes appear when a plugin learns about them from a packet with a good CRC: MeshCore from adverts with a valid signature, Meshtastic from any packet it can decrypt.</Empty>
      )}
    </Card>
  )
}

export function Messages({ state }: { state: RadioState }) {
  const end = useRef<HTMLDivElement>(null)
  // braces matter: Chrome's scrollIntoView now returns a Promise, which React would take as a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [state.messages.length])
  return (
    <div className="channel">
      <div className="thread-head">
        <span className="thread-title">Messages</span>
        <span className="muted small">read-only · channel text the plugins could decrypt (MeshCore Public, Meshtastic default channels) · senders are unverified</span>
      </div>
      <div className="thread-list">
        {state.messages.length ? (
          state.messages.map((m) => (
            <div key={m.id} className="bubble bubble-in">
              <div className="bubble-from">{m.sender || <span className="muted">(no sender)</span>} <span className="muted">· {m.channel || '?'} · {protocolName(m.protocol)}</span></div>
              <div className="bubble-text">{m.text}</div>
              <div className="bubble-meta">
                <span>{new Date(m.sentAt ? m.sentAt * 1000 : m.at).toLocaleTimeString([], { hour12: false })}</span>
                {m.hops !== undefined && <span>{plural(m.hops, 'hop')}</span>}
                <span>{level(m.rssi)} dBm · SNR {level(m.snr)}</span>
              </div>
            </div>
          ))
        ) : (
          <Empty>Channel messages show up here as they’re heard.</Empty>
        )}
        <div ref={end} />
      </div>
    </div>
  )
}

/** Device counter with how far it moved since this connection's first RADIO_STATUS (or a stats reset). */
function counter(value: number, base: number | undefined, bad = false) {
  return (
    <span className={bad && value ? 'err' : undefined}>
      {value}
      {base !== undefined && <span className="muted"> (+{value - base})</span>}
    </span>
  )
}

function CountersCard({ state, now }: { state: RadioState; now: number }) {
  const s = state.radioStatus
  const b = state.countersBase
  const total = s ? s.rxOk + s.rxCrcErr : 0
  let empty = 'Starts once connected.'
  if (state.radioStatusRefused) empty = 'The device advertises RADIO_STATUS but answered EUNKNOWN_CMD, so there are no device counters.'
  else if (state.info && !radioStatusAvailable(state)) empty = 'This firmware has no RADIO_STATUS (DongLoRa 1.6.0, protocol v1.1, adds it), so there are no device counters.'
  else if (state.info) empty = 'Waiting for the first RADIO_STATUS reply.'
  return (
    <Card title="Radio counters (device, since boot)">
      {s ? (
        <>
          <Rows
            rows={[
              { label: 'Good CRC', value: counter(s.rxOk, b?.rxOk) },
              {
                label: 'CRC errors',
                value: (
                  <>
                    {counter(s.rxCrcErr, b?.rxCrcErr, true)}
                    {total ? <span className="muted"> · {((s.rxCrcErr / total) * 100).toFixed(1)}% of packets</span> : null}
                  </>
                ),
              },
              { label: 'Header errors', value: counter(s.rxHeaderErr, b?.rxHeaderErr, true) },
              { label: 'Updated', value: ago(state.radioStatusAt, now) },
            ]}
          />
          <p className="muted small">
            Counted by the dongle since it booted, not by this console; (+n) is since this connection’s first RADIO_STATUS or the last stats reset.
            CRC errors also arrive as RX events with crc_valid = 0 and are in the console’s counts. Header errors are packets that failed to decode
            at the LoRa header: they never reach the host, so there are no bytes to show.
          </p>
        </>
      ) : (
        <Empty>{empty}</Empty>
      )}
    </Card>
  )
}

function NoiseCard({ state, now }: { state: RadioState; now: number }) {
  const n = state.noise
  const measured = n.source === 'measured'
  const available = radioStatusAvailable(state)
  const rs = state.radioStatus
  const badge = <span className={`badge-s ${measured ? 'badge-measured' : 'badge-source'}`}>{NOISE_SOURCE_LABELS[n.source]}</span>
  return (
    <div className="card-span">
      <Card title="Noise floor" actions={badge}>
        <Rows
          rows={[
            {
              label: 'Floor (MeshCore)',
              value: n.floor !== undefined ? `${n.floor} dBm` : `pending: ${n.pending} of ${NUM_NOISE_FLOOR_SAMPLES} samples`,
              muted: n.floor === undefined,
            },
            { label: `Median, last ${MEDIAN_WINDOW}`, value: n.median !== undefined ? `${n.median} dBm (${n.medianCount} sample${n.medianCount === 1 ? '' : 's'})` : '…', muted: n.median === undefined },
            { label: 'Last update', value: n.last ? `${measured ? level(n.last.dbm) : Math.round(n.last.dbm)} dBm · ${ago(n.last.at, now)}` : 'no samples yet', muted: !n.last },
            { label: 'Samples', value: `${n.accepted} used, ${n.rejected} over floor + 14 dB` },
            ...(available
              ? [{
                  label: 'RSSI now (RADIO_STATUS)',
                  value: rs ? (rs.rssiInst !== null ? `${level(rs.rssiInst)} dBm` : 'none: the radio isn’t in continuous RX') : 'no reply yet',
                  muted: !rs || rs.rssiInst === null,
                }]
              : []),
          ]}
        />
        <NoiseChart points={state.noiseHistory} measured={state.measuredHistory} />
        {measured ? (
          <p className="note">
            RADIO_STATUS reads the SX1262’s instantaneous RSSI with every keepalive, about twice a second, in 0.5 dB steps. The floor uses
            MeshCore’s method: 64 samples under floor + 14 dB, averaged, clamped at −120 dBm, so readings taken during a packet are left out once
            there is a floor. The Packets table still shows each packet’s own estimate.
          </p>
        ) : (
          <p className="note">
            {available
              ? 'RADIO_STATUS only reads RSSI while the radio is in continuous RX, so for now each packet’s noise is estimated instead'
              : 'This firmware has no RADIO_STATUS (DongLoRa 1.6.0 adds it), so each packet’s noise is estimated'}{' '}
            as RSSI − 10·log10(1 + 10^(SNR/10)), from whole-dB values (±1 dB at best). The floor uses MeshCore’s method: 64 samples under
            floor + 14 dB, averaged, clamped at −120 dBm. Packets with a failed CRC are left out.
          </p>
        )}
      </Card>
    </div>
  )
}
