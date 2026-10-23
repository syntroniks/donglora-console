import { useState, type ReactNode } from 'react'

export function Card({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export interface EditSpec {
  type: 'text' | 'number' | 'select' | 'flags'
  /** starting value; for 'flags', the selected option values joined with ',' */
  value: string
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  hint?: string
  /** return an error message to refuse the value before anything is sent */
  validate?: (value: string) => string | undefined
  save: (value: string) => Promise<void>
}

export interface Row {
  label: string
  value: ReactNode
  muted?: boolean
  action?: ReactNode
  edit?: EditSpec
}

export function Rows({ rows }: { rows: Row[] }) {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <dl className="rows">
      {rows.map((r) =>
        editing === r.label && r.edit ? (
          <div className="row row-editing" key={r.label}>
            <dt>{r.label}</dt>
            <Editor spec={r.edit} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <div className="row" key={r.label}>
            <dt>{r.label}</dt>
            <dd className={r.muted ? 'muted' : undefined}>{r.value}</dd>
            <div className="row-action">
              {r.action}
              {r.edit && (
                <Button kind="small" onClick={() => setEditing(r.label)}>
                  edit
                </Button>
              )}
            </div>
          </div>
        ),
      )}
    </dl>
  )
}

function Editor({ spec, onDone }: { spec: EditSpec; onDone: () => void }) {
  const [value, setValue] = useState(spec.value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const save = async () => {
    const problem = spec.validate?.(value)
    if (problem) return setError(problem)
    setSaving(true)
    setError(undefined)
    try {
      await spec.save(value)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void save()
    if (e.key === 'Escape') onDone()
  }

  let input: ReactNode
  if (spec.type === 'select') {
    input = (
      <select autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={keys} disabled={saving}>
        {spec.options?.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    )
  } else if (spec.type === 'flags') {
    const selected = new Set(value.split(',').filter(Boolean))
    const toggle = (v: string) => {
      const next = new Set(selected)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      setValue([...next].join(','))
    }
    input = (
      <div className="flags">
        {spec.options?.map((o) => (
          <label key={o.value}>
            <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} disabled={saving} /> {o.label}
          </label>
        ))}
      </div>
    )
  } else {
    input = (
      <input
        autoFocus
        type={spec.type === 'number' ? 'number' : 'text'}
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        disabled={saving}
      />
    )
  }

  return (
    <dd className="editor">
      <div className="editor-line">
        {input}
        <Button kind="small" onClick={() => void save()} disabled={saving}>{saving ? 'saving…' : 'save'}</Button>
        <Button kind="small" onClick={onDone} disabled={saving}>cancel</Button>
      </div>
      {spec.hint && <div className="muted small">{spec.hint}</div>}
      {error && <div className="editor-error">{error}</div>}
    </dd>
  )
}

export function Button({ children, onClick, kind = 'plain', disabled, title }: {
  children: ReactNode
  onClick?: () => void
  kind?: 'plain' | 'primary' | 'small'
  disabled?: boolean
  title?: string
}) {
  return (
    <button className={`btn btn-${kind}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}
