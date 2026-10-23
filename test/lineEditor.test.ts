import { describe, expect, it } from 'vitest'
import { completeCommand, literalPrefix } from '../src/console/cliCommands.ts'
import { LineEditor } from '../src/console/lineEditor.ts'

function editor() {
  const submitted: string[] = []
  let out = ''
  const ed = new LineEditor({
    prompt: '$ ',
    write: (s) => (out += s),
    onSubmit: (l) => submitted.push(l),
    complete: completeCommand,
  })
  ed.showPrompt()
  return { ed, submitted, output: () => out }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'

describe('LineEditor', () => {
  it('submits typed text on Enter', () => {
    const { ed, submitted } = editor()
    ed.handleInput('/ping\r')
    expect(submitted).toEqual(['/ping'])
    expect(ed.line).toBe('')
  })

  it('edits at the cursor with backspace and arrows', () => {
    const { ed } = editor()
    ed.handleInput('get tz')
    ed.handleInput(LEFT)
    ed.handleInput('x')
    expect(ed.line).toBe('get txz')
    ed.handleInput('\x1b[F\x7f') // End, backspace
    expect(ed.line).toBe('get tx')
  })

  it('walks history and restores the unfinished line', () => {
    const { ed } = editor()
    ed.handleInput('ver\r')
    ed.handleInput('board\r')
    ed.handleInput('get n')
    ed.handleInput(UP)
    expect(ed.line).toBe('board')
    ed.handleInput(UP)
    expect(ed.line).toBe('ver')
    ed.handleInput(DOWN + DOWN)
    expect(ed.line).toBe('get n')
  })

  it('treats an emoji as one character', () => {
    const { ed } = editor()
    ed.handleInput('set name 🎅')
    ed.handleInput('\x7f')
    expect(ed.line).toBe('set name ')
  })

  it('completes a unique command, and shows choices when ambiguous', () => {
    const { ed, output } = editor()
    ed.handleInput('/fr\t')
    expect(ed.line).toBe('/frames ')
    ed.setLine('/p')
    ed.handleInput('\t')
    expect(output()).toContain('/ping')
    expect(output()).toContain('/preset')
  })

  it('drops the line on ctrl-c', () => {
    const { ed, submitted } = editor()
    ed.handleInput('/tx 01\x03')
    expect(ed.line).toBe('')
    expect(submitted).toEqual([])
  })
})

describe('command catalog', () => {
  it('reduces usages to the part that can be completed', () => {
    expect(literalPrefix('set tx <dBm>')).toBe('set tx ')
    expect(literalPrefix('set cad on|off')).toBe('set cad ')
    expect(literalPrefix('get radio')).toBe('get radio')
  })
})
