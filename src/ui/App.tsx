import { useCallback, useState } from 'react'
import { RADIO_CHIP_NAMES } from '../protocol/codes.ts'
import { describeConfig } from '../protocol/lora.ts'
import { isWebSerialSupported } from '../protocol/transports/webserial.ts'
import { Button, ErrorBoundary } from './parts.tsx'
import { LinkErrors, Packets } from './PacketsView.tsx'
import { RadioView } from './RadioView.tsx'
import { Shell } from './Shell.tsx'
import { store } from './store.ts'
import { useRadio } from './useRadio.ts'
import { Channel, Nodes, Overview } from './views.tsx'

type Tab = 'overview' | 'radio' | 'packets' | 'link' | 'nodes' | 'channel'

const report = (p: Promise<unknown>) => void p.catch((err: unknown) => store.setError(err))

export function App() {
  const state = useRadio()
  const [tab, setTab] = useState<Tab>('overview')
  const [dockHeight, setDockHeight] = useState(260)
  const connected = state.status === 'connected'
  const webSerial = isWebSerialSupported()

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      const startY = e.clientY
      const startH = dockHeight
      const move = (ev: PointerEvent) => setDockHeight(Math.max(120, Math.min(window.innerHeight - 160, startH - (ev.clientY - startY))))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [dockHeight],
  )

  const st = state.stats
  const failed = st.status.partial + st.status.undecodable
  const tabs: { id: Tab; label: string; bad?: boolean }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'radio', label: state.txArmed ? 'Radio · TX ARMED' : 'Radio', bad: state.txArmed },
    { id: 'packets', label: `Packets${st.rx ? ` · ${st.rx}` : ''}${failed + st.crcFail ? ` (${failed} failed, ${st.crcFail} CRC)` : ''}` },
    { id: 'link', label: `Link errors${st.linkTotal ? ` · ${st.linkTotal}` : ''}`, bad: st.linkTotal > 0 },
    { id: 'nodes', label: `Heard nodes${Object.keys(state.nodes).length ? ` · ${Object.keys(state.nodes).length}` : ''}` },
    { id: 'channel', label: `Public channel${state.posts.length ? ` · ${state.posts.length}` : ''}` },
  ]
  const echo = state.applied?.lora

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DongLoRa Console</span>
        <span className={`status status-${state.status}`}>
          <span className="dot" />
          {connected ? `${state.demo ? 'demo dongle' : state.label}${state.rxOn ? ' · receiving' : ''}` : state.status}
        </span>
        {state.info && (
          <span className="muted">
            {RADIO_CHIP_NAMES[state.info.radioChipId]} · fw {state.info.firmware.major}.{state.info.firmware.minor}.{state.info.firmware.patch}
          </span>
        )}
        {echo && <span className="muted">{describeConfig(echo)}</span>}
        {state.txArmed && <span className="badge-s badge-crc">TX ARMED</span>}
        <span className="spacer" />
        {state.status === 'disconnected' ? (
          <>
            <Button kind="primary" onClick={() => report(store.connectSerial())} disabled={!webSerial} title={webSerial ? 'Pick the DongLoRa’s USB serial port' : 'WebSerial needs Chrome or Edge on desktop'}>
              Connect USB
            </Button>
            <Button onClick={() => report(store.connectDemo())}>Demo radio</Button>
          </>
        ) : (
          <Button onClick={() => report(store.disconnect())}>{state.status === 'connecting' ? 'Cancel' : 'Disconnect'}</Button>
        )}
      </header>

      {state.error && (
        <div className="banner banner-error">
          {state.error}
          <button className="banner-close" onClick={() => store.clearError()}>×</button>
        </div>
      )}

      <div className="workspace">
        {state.status === 'disconnected' && !state.info ? (
          <Welcome webSerial={webSerial} />
        ) : (
          <>
            <nav className="tabs">
              {tabs.map((t) => (
                <button key={t.id} className={`tab ${tab === t.id ? 'tab-active' : ''} ${t.bad ? 'tab-bad' : ''}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
              <span className="spacer" />
              <Button kind="small" onClick={() => store.resetStats()}>reset stats</Button>
            </nav>
            <main className="view">
              <ErrorBoundary key={tab}>
                {tab === 'overview' && <Overview state={state} />}
                {tab === 'radio' && <RadioView state={state} />}
                {tab === 'packets' && <Packets packets={state.packets} onClear={() => store.clearPackets()} />}
                {tab === 'link' && <LinkErrors errors={state.linkErrors} counts={st.link} total={st.linkTotal} onClear={() => store.clearLinkErrors()} />}
                {tab === 'nodes' && <Nodes state={state} />}
                {tab === 'channel' && <Channel state={state} />}
              </ErrorBoundary>
            </main>
          </>
        )}
      </div>

      <div className="dock" style={{ height: dockHeight }}>
        <div className="dock-handle" onPointerDown={startDrag} title="Drag to resize">
          <span>Shell</span>
          <span className="muted small">local commands · /help</span>
        </div>
        <ErrorBoundary>
          <Shell />
        </ErrorBoundary>
      </div>
    </div>
  )
}

function Welcome({ webSerial }: { webSerial: boolean }) {
  return (
    <div className="welcome">
      <h1>Connect a DongLoRa dongle</h1>
      <p className="muted">
        Plug the dongle in over USB and pick its serial port (USB id 1209:5741). The console reads its capabilities,
        configures it for the MeshCore USA/Canada preset and starts receiving. It never transmits unless you arm TX on
        the Radio tab and confirm each packet.
      </p>
      {!webSerial && <p className="banner banner-error">This browser has no WebSerial. Use Chrome or Edge on desktop.</p>}
      <div className="welcome-actions">
        <Button kind="primary" onClick={() => report(store.connectSerial())} disabled={!webSerial}>Connect USB</Button>
        <Button onClick={() => report(store.connectDemo())}>Try the demo radio</Button>
      </div>
      <p className="muted small">
        Only one program can hold the serial port: close other tabs, <code>pnpm probe</code> and flashing tools first.
        The demo radio is simulated in this page, including broken packets and link errors of every kind.
      </p>
    </div>
  )
}
