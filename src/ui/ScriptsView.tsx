import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EXAMPLES } from '../scripts/examples.ts'
import { Button, Card, Empty } from './parts.tsx'
import { scripts, type SavedScript } from './scripts.ts'
import { time } from './format.ts'

const useScripts = () => useSyncExternalStore(scripts.subscribe, scripts.getState)

const API = `radio.state()  info()  config()  setConfig('meshtastic-longfast-us' | { freqHz, sf, ... })
radio.rxStart()  rxStop()  ping()  status()        status() is RADIO_STATUS, firmware 1.6.0
radio.packets(20)  nodes()  messages(50)  plugins()
radio.tx(hexOrBytes)       only with "may transmit" ticked and TX armed on the Radio tab
radio.say(text, { channel, sender })   post a channel message, same rule; sender defaults to the Messages view's name
on('packet' | 'node' | 'message' | 'link-error' | 'log' | 'connected' | 'disconnected', fn) -> off()
every(ms, fn) -> cancel()  sleep(ms)  print(...)  warn(...)
storage.get(key)  storage.set(key, jsonValue)       kept for this script in this browser`

export function ScriptsView() {
  const st = useScripts()
  const [selected, setSelected] = useState<string | undefined>(st.scripts[0]?.id)
  const current = st.scripts.find((s) => s.id === selected) ?? st.scripts[0]
  const [error, setError] = useState<string>()

  const act = (fn: () => void) => {
    setError(undefined)
    try {
      fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="scripts">
      <div className="script-list">
        <Card
          title={`Scripts (${st.scripts.length})`}
          actions={<Button kind="small" onClick={() => setSelected(scripts.create().id)}>new</Button>}
        >
          {st.scripts.length ? (
            <ul className="script-items">
              {st.scripts.map((s) => (
                <li key={s.id} className={s.id === current?.id ? 'script-item script-item-active' : 'script-item'} onClick={() => setSelected(s.id)}>
                  <span className={`dot ${st.running.includes(s.id) ? 'dot-on' : ''}`} />
                  <span className="script-name">{s.name}</span>
                  {s.allowTx && <span className="badge-s badge-crc" title="may transmit">TX</span>}
                  {s.runOnConnect && <span className="muted small" title="starts when the console connects">auto</span>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No scripts yet. Start from an example below.</Empty>
          )}
        </Card>
        <Card title="Examples">
          <ul className="script-examples">
            {EXAMPLES.map((e) => (
              <li key={e.name}>
                <button className="link" onClick={() => setSelected(scripts.create(e).id)}>{e.name}</button>
                <span className="muted small"> {e.description}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="script-main">
        {current ? <Editor key={current.id} script={current} running={st.running.includes(current.id)} onError={setError} act={act} /> : <Card title="Script"><Empty>Pick or create a script.</Empty></Card>}
        {error && <div className="banner banner-error">{error}<button className="banner-close" onClick={() => setError(undefined)}>×</button></div>}
        {current && <Output id={current.id} lines={st.output[current.id] ?? []} />}
        <Card title="API">
          <pre className="script-api">{API}</pre>
          <p className="muted small">
            Each script runs in its own Web Worker and reaches the radio only through these calls. It keeps running while it has
            handlers or timers, until you stop it; an error in a handler is printed and doesn’t stop it. Output also goes to the
            shell. The console server runs scripts too: <code>pnpm server --script bot.js</code>.
          </p>
        </Card>
      </div>
    </div>
  )
}

function Editor({ script, running, act, onError }: { script: SavedScript; running: boolean; act: (fn: () => void) => void; onError: (e?: string) => void }) {
  const [draft, setDraft] = useState(script)
  const changed = (p: Partial<SavedScript>) => {
    const next = { ...draft, ...p }
    setDraft(next)
    scripts.save(next)
  }
  const confirmTx = (on: boolean) => {
    if (on && !window.confirm('Let this script transmit?\n\nIt can then send packets without asking each time, whenever TX is armed on the Radio tab. The firmware enforces no regulatory limits.')) return
    changed({ allowTx: on })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const t = e.currentTarget
    const { selectionStart: a, selectionEnd: b } = t
    const source = draft.source.slice(0, a) + '  ' + draft.source.slice(b)
    changed({ source })
    requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2))
  }
  return (
    <Card
      title="Script"
      actions={
        <>
          {running ? <Button onClick={() => act(() => scripts.stop(script.id))}>Stop</Button> : null}
          <Button kind="primary" onClick={() => act(() => scripts.run(script.id))}>{running ? 'Restart' : 'Run'}</Button>
          <Button
            kind="small"
            onClick={() => {
              if (window.confirm(`Delete “${draft.name}” and its stored data?`)) act(() => scripts.remove(script.id))
              onError(undefined)
            }}
          >
            delete
          </Button>
        </>
      }
    >
      <div className="script-head">
        <input className="server-url" value={draft.name} onChange={(e) => changed({ name: e.target.value })} aria-label="script name" spellCheck={false} />
        <label className="check"><input type="checkbox" checked={draft.runOnConnect} onChange={(e) => changed({ runOnConnect: e.target.checked })} /> run when connected</label>
        <label className="check"><input type="checkbox" checked={draft.allowTx} onChange={(e) => confirmTx(e.target.checked)} /> may transmit</label>
      </div>
      <textarea className="script-editor" value={draft.source} onChange={(e) => changed({ source: e.target.value })} onKeyDown={onKeyDown} spellCheck={false} />
      <p className="muted small">Saved as you type. Changes take effect the next time it runs{running ? ': Restart to apply them' : ''}.</p>
    </Card>
  )
}

function Output({ id, lines }: { id: string; lines: { at: number; level: string; text: string }[] }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])
  return (
    <Card title="Output" actions={<Button kind="small" onClick={() => scripts.clearOutput(id)}>clear</Button>}>
      <div className="script-output">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={i} className={l.level === 'info' ? undefined : l.level}>
              <span className="muted">{time(l.at)}</span> {l.text}
            </div>
          ))
        ) : (
          <span className="muted">Nothing printed yet.</span>
        )}
        <div ref={end} />
      </div>
    </Card>
  )
}
