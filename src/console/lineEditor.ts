// Terminal line editing for the shell: input arrives as xterm onData strings, output goes out as
// ANSI text. Kept free of xterm so it can be tested on its own.

export interface LineEditorOptions {
  prompt: string
  write: (ansi: string) => void
  onSubmit: (line: string) => void
  complete?: (line: string) => string[]
}

const ESC = '\x1b'
const CSI = `${ESC}[`

export class LineEditor {
  private readonly opts: LineEditorOptions
  private chars: string[] = [] // code points, so the cursor never splits an emoji
  private cursor = 0
  private history: string[] = []
  private historyIndex = 0 // == history.length while editing a new line
  private draft = ''
  private promptShown = false
  prompt: string

  constructor(opts: LineEditorOptions) {
    this.opts = opts
    this.prompt = opts.prompt
  }

  get line(): string {
    return this.chars.join('')
  }

  /** Show the prompt (again) with the current line. */
  showPrompt(): void {
    this.promptShown = true
    this.render()
  }

  hidePrompt(): void {
    if (this.promptShown) this.opts.write(`\r${CSI}2K`)
    this.promptShown = false
  }

  /** Print text above the prompt without disturbing the line being typed. */
  print(text: string): void {
    const wasShown = this.promptShown
    this.hidePrompt()
    this.opts.write(text.replace(/\r?\n/g, '\r\n') + '\r\n')
    if (wasShown) this.showPrompt()
  }

  setLine(text: string): void {
    this.chars = Array.from(text)
    this.cursor = this.chars.length
    if (this.promptShown) this.render()
  }

  handleInput(data: string): void {
    let i = 0
    while (i < data.length) {
      const seq = matchEscape(data, i)
      if (seq) {
        this.handleEscape(seq)
        i += seq.length
        continue
      }
      const ch = String.fromCodePoint(data.codePointAt(i)!) // whole emoji, not half a surrogate pair
      this.handleChar(ch)
      i += ch.length
    }
  }

  private handleEscape(seq: string): void {
    switch (seq) {
      case `${CSI}A`:
        return this.historyStep(-1)
      case `${CSI}B`:
        return this.historyStep(1)
      case `${CSI}C`:
        return this.moveCursor(this.cursor + 1)
      case `${CSI}D`:
        return this.moveCursor(this.cursor - 1)
      case `${CSI}H`:
      case `${ESC}OH`:
      case `${CSI}1~`:
        return this.moveCursor(0)
      case `${CSI}F`:
      case `${ESC}OF`:
      case `${CSI}4~`:
        return this.moveCursor(this.chars.length)
      case `${CSI}3~`: // delete
        if (this.cursor < this.chars.length) {
          this.chars.splice(this.cursor, 1)
          this.render()
        }
        return
      default:
        return // ignore other sequences (function keys, etc.)
    }
  }

  private handleChar(ch: string): void {
    switch (ch) {
      case '\r':
      case '\n':
        return this.submit()
      case '\x7f':
      case '\b':
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1)
          this.cursor--
          this.render()
        }
        return
      case '\x03': // ctrl-c: drop the line
        this.opts.write('^C\r\n')
        this.chars = []
        this.cursor = 0
        this.historyIndex = this.history.length
        return this.render()
      case '\x01': // ctrl-a
        return this.moveCursor(0)
      case '\x05': // ctrl-e
        return this.moveCursor(this.chars.length)
      case '\x15': // ctrl-u: clear to start
        this.chars = this.chars.slice(this.cursor)
        this.cursor = 0
        return this.render()
      case '\x0c': // ctrl-l
        this.opts.write(`${CSI}2J${CSI}H`)
        return this.render()
      case '\t':
        return this.completeLine()
      default:
        if (ch < ' ') return // other control chars
        this.chars.splice(this.cursor, 0, ch)
        this.cursor++
        this.render()
    }
  }

  private submit(): void {
    const line = this.line
    this.opts.write('\r\n')
    this.promptShown = false
    if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line)
    this.historyIndex = this.history.length
    this.chars = []
    this.cursor = 0
    this.draft = ''
    this.opts.onSubmit(line)
  }

  private historyStep(dir: number): void {
    const next = this.historyIndex + dir
    if (next < 0 || next > this.history.length) return
    if (this.historyIndex === this.history.length) this.draft = this.line
    this.historyIndex = next
    this.chars = Array.from(next === this.history.length ? this.draft : this.history[next])
    this.cursor = this.chars.length
    this.render()
  }

  private completeLine(): void {
    const line = this.line
    const options = this.opts.complete?.(line) ?? []
    if (options.length === 0) return
    if (options.length === 1) return this.setLine(options[0])
    const common = commonPrefix(options)
    if (common.length > line.length) return this.setLine(common)
    this.print(options.join('   '))
  }

  private moveCursor(pos: number): void {
    const clamped = Math.max(0, Math.min(this.chars.length, pos))
    if (clamped === this.cursor) return
    this.cursor = clamped
    this.render()
  }

  private render(): void {
    if (!this.promptShown) return
    const back = this.chars.length - this.cursor
    this.opts.write(`\r${CSI}2K${this.prompt}${this.line}${back ? `${CSI}${back}D` : ''}`)
  }
}

/** An ANSI escape sequence starting at data[i], or null. */
function matchEscape(data: string, i: number): string | null {
  if (data[i] !== ESC) return null
  // oxlint-disable-next-line no-control-regex -- matching ANSI escapes is the point
  const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i))
  return m ? m[0] : ESC
}

function commonPrefix(items: string[]): string {
  let p = items[0]
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1)
  return p
}
