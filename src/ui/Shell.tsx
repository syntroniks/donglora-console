import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { completeCommand, LOCAL_COMMANDS } from '../console/cliCommands.ts'
import { LineEditor } from '../console/lineEditor.ts'
import { fromHex, toHex } from '../protocol/bytes.ts'
import { CAPABILITY_NAMES, MSG_TYPE_NAMES, MsgType, RADIO_CHIP_NAMES, TX_RESULT_NAMES } from '../protocol/codes.ts'
import { LINK_ERROR_NAMES } from '../protocol/client.ts'
import type { Frame } from '../protocol/framing.ts'
import { bwKHz, describeConfig, mhz, supportedBws, supportedSfs, syncWordHex } from '../protocol/lora.ts'
import { presetById, PRESETS } from '../meshcore/presets.ts'
import { store, type PacketEntry } from './store.ts'
import { ago, plural, time } from './format.ts'

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  accent: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

const PROMPT_IDLE = C.dim('offline') + ' $ '
const PROMPT_ON = C.accent('dongle') + ' $ '

/** One line per RX event; anything that didn't decode cleanly is red with its reason. */
function rxLine(p: PacketEntry): string {
  const meta = `${p.rx.rssi.toFixed(0)} dBm ${p.rx.snr.toFixed(1)} dB ${p.rx.data.length}B`
  const m = p.mesh
  const where = m.failure ? ` [${m.failure.stage} @${m.failure.offset}]` : ''
  if (!p.rx.crcValid) return C.err(`[rx] CRC FAIL ${meta}  (untrusted) ${m.status}${where}: ${m.failure ? m.failure.reason : m.summary}`)
  if (m.status === 'partial' || m.status === 'undecodable') return C.err(`[rx] ${m.status.toUpperCase()} ${meta}${where}: ${m.failure!.reason}  ${C.dim(toHex(p.rx.data).slice(0, 48))}`)
  if (m.status === 'no-key') return C.dim(`[rx] no key ${meta}  ${m.summary}`)
  return `${C.dim('[rx]')} ${C.dim(meta)}  ${m.summary}`
}

export function Shell() {
  const host = useRef<HTMLDivElement>(null)

  // terminal, line editor and store subscriptions, created once per mount
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      theme: { background: '#0b0e12', foreground: '#d6dde6', cursor: '#4fb3a9' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(host.current!)

    const flags = { rx: false, frames: 'off' as 'off' | 'on' | 'all', confirmTx: '', confirmAt: 0 }
    let running: { cancelled: boolean } | null = null
    const pingTags = new Set<number>()

    const editor = new LineEditor({
      prompt: store.getState().status === 'connected' ? PROMPT_ON : PROMPT_IDLE,
      write: (s) => term.write(s),
      complete: completeCommand,
      onSubmit: (line) => void runLine(line),
    })
    term.onData((d) => {
      if (!running) return editor.handleInput(d)
      if (d === '\x03') {
        // Ctrl-C: stop waiting for the command (the frame may still get its reply)
        running.cancelled = true
        running = null
        term.write(C.dim('^C') + '\r\n')
        editor.showPrompt()
      }
    })
    term.writeln(C.accent('DongLoRa Console') + C.dim(' — /help for commands, Tab completes, Ctrl-C stops waiting'))
    editor.showPrompt()

    const out = (s: string) => editor.print(s)

    async function runLine(raw: string) {
      const line = raw.trim()
      if (!line) return editor.showPrompt()
      const job = { cancelled: false }
      running = job
      const say = (s: string) => !job.cancelled && out(s)
      try {
        await run(line, say)
      } catch (err) {
        say(C.err(err instanceof Error ? err.message : String(err)))
      } finally {
        if (!job.cancelled) {
          running = null
          editor.showPrompt()
        }
      }
    }

    async function run(line: string, say: (s: string) => void) {
      const [cmd, ...args] = line.replace(/^\//, '').split(/\s+/)
      const arg = args[0]
      const s = store.getState()
      switch (cmd) {
        case 'help': {
          say(C.accent('Commands') + C.dim(' (all local; DongLoRa has no CLI)'))
          for (const h of LOCAL_COMMANDS) say(`  ${h.usage.padEnd(24)}${C.dim(h.summary)}`)
          return
        }
        case 'clear':
          term.clear()
          return
        case 'info': {
          const i = await store.refreshInfo()
          const caps = Object.entries(CAPABILITY_NAMES).filter(([b]) => ((i.capabilities >> BigInt(b)) & 1n) === 1n).map(([, n]) => n)
          say(`${C.accent(`DongLoRa ${i.firmware.major}.${i.firmware.minor}.${i.firmware.patch}`)} protocol ${i.protocol.major}.${i.protocol.minor}, radio ${RADIO_CHIP_NAMES[i.radioChipId] ?? 'unknown'}`)
          say(`capabilities ${caps.join(', ')} (0x${i.capabilities.toString(16)})`)
          say(`${mhz(i.freqMinHz)}–${mhz(i.freqMaxHz)} MHz, ${i.txPowerMinDbm}…${i.txPowerMaxDbm} dBm, SF ${supportedSfs(i).join(',')}, BW ${supportedBws(i).map(bwKHz).join(', ')} kHz`)
          say(`max payload ${i.maxPayloadBytes} B, RX queue ${i.rxQueueCapacity}, TX queue ${i.txQueueCapacity}, MCU UID ${i.mcuUid || '-'}, radio UID ${i.radioUid || '-'}`)
          return
        }
        case 'ping':
          say(`${C.ok('OK')} in ${(await store.ping()).toFixed(1)} ms`)
          return
        case 'config': {
          const r = s.requested
          say(`requested  ${describeConfig(r)} · preamble ${r.preambleLen} · sync ${syncWordHex(r.syncWord)} · ${r.txPowerDbm} dBm`)
          const e = s.applied?.lora
          say(e ? `device     ${describeConfig(e)} · preamble ${e.preambleLen} · sync ${syncWordHex(e.syncWord)} · ${e.txPowerDbm} dBm` : C.dim('device     (no SET_CONFIG yet)'))
          say(`RX ${s.rxOn ? C.ok('on') : 'off'}, TX ${s.txArmed ? C.err('ARMED') : 'disarmed'}`)
          return
        }
        case 'preset': {
          const p = arg ? presetById(arg) : undefined
          if (!p) return say(C.err(`presets: ${PRESETS.map((x) => x.id.replace('meshcore-', '')).join(', ')}`))
          await store.applyConfig({ ...p.config, txPowerDbm: s.requested.txPowerDbm })
          say(`${C.ok('applied')} ${p.name}: ${describeConfig(p.config)}`)
          return
        }
        case 'rx': {
          if (arg === 'start') {
            await store.startRx()
            return say(C.ok('receiving'))
          }
          if (arg === 'stop') {
            await store.stopRx()
            return say('RX stopped')
          }
          flags.rx = arg === undefined ? !flags.rx : arg === 'on'
          say(`printing packets ${flags.rx ? C.ok('on') : 'off'}${flags.rx && !s.rxOn ? C.warn(' (the radio is not receiving: /rx start)') : ''}`)
          return
        }
        case 'frames':
          flags.frames = arg === 'all' ? 'all' : arg === 'off' ? 'off' : arg === 'on' ? 'on' : flags.frames === 'off' ? 'on' : 'off'
          say(`frames ${flags.frames === 'off' ? 'off' : C.ok(flags.frames)}`)
          return
        case 'stats': {
          const st = s.stats
          say(`RX ${st.rx}: ${C.ok(`${st.status.decoded} decoded`)}, ${st.status.partial} partial, ${st.status.undecodable} undecodable, ${st.status['no-key']} no key; ${st.crcFail ? C.err(`${st.crcFail} CRC fail`) : '0 CRC fail'}; ${st.dropped} dropped by device`)
          const stages = Object.entries(st.stages).map(([k, v]) => `${k} ${v}`).join(', ')
          if (stages) say(`decode failures by stage: ${stages}`)
          const link = Object.entries(st.link).map(([k, v]) => `${LINK_ERROR_NAMES[k as keyof typeof LINK_ERROR_NAMES]} ${v}`).join(', ')
          say(`link errors ${st.linkTotal}${link ? `: ${link}` : ''}`)
          if (st.good) say(`RSSI avg ${(st.rssiSum / st.good).toFixed(1)} dBm (${st.rssiMin}…${st.rssiMax}), SNR avg ${(st.snrSum / st.good).toFixed(1)} dB (${st.snrMin}…${st.snrMax})`)
          const h = s.health
          if (h) say(`keepalive ${h.pings} PINGs, ${h.failures} failed, rtt ${h.lastRttMs?.toFixed(1) ?? '-'} ms, longest gap ${h.maxGapMs} ms, sessions lost ${h.lostSessions} (${h.recoveries} restored)`)
          return
        }
        case 'errors': {
          if (!s.linkErrors.length) return say(C.dim('no link errors'))
          for (const e of s.linkErrors.slice(0, 15).reverse()) say(C.err(`${time(e.at)} ${LINK_ERROR_NAMES[e.kind]}: ${e.reason}`) + C.dim(`  ${toHex(e.bytes.subarray(0, 24), ' ')}`))
          return
        }
        case 'nodes': {
          const nodes = Object.values(s.nodes).sort((a, b) => b.lastHeard - a.lastHeard)
          if (!nodes.length) return say(C.dim('no adverts heard yet'))
          for (const n of nodes) say(`  ${(n.name || '(no name)').padEnd(22)} ${n.typeName.padEnd(12)} ${plural(n.hops, 'hop').padEnd(7)} ${n.rssi.toFixed(0)} dBm ${C.dim(`${ago(n.lastHeard)} · ${n.publicKey.slice(0, 8)}`)}`)
          return
        }
        case 'tx': {
          if (!s.txArmed) return say(C.err('TX is not armed. Arm it on the Radio tab first.'))
          const hex = args.join('')
          let bytes: Uint8Array
          try {
            bytes = fromHex(hex)
          } catch {
            return say(C.err('usage: /tx <hex bytes>'))
          }
          if (!bytes.length) return say(C.err('usage: /tx <hex bytes>'))
          const c = s.applied?.lora
          if (!c) return say(C.err('no config applied'))
          if (flags.confirmTx !== line || Date.now() - flags.confirmAt > 30000) {
            flags.confirmTx = line
            flags.confirmAt = Date.now()
            return say(C.warn(`This transmits ${bytes.length} B on ${mhz(c.freqHz)} MHz at ${c.txPowerDbm} dBm (SX1262 setting). Enter the same command again within 30 s to send.`))
          }
          flags.confirmTx = ''
          const done = await store.transmit(bytes)
          say(`${done.result === 0 ? C.ok('TX_DONE') : C.warn('TX_DONE')} ${TX_RESULT_NAMES[done.result] ?? done.result}${done.airtimeUs ? `, ${(done.airtimeUs / 1000).toFixed(1)} ms on air` : ''}`)
          return
        }
        default:
          say(C.err(`unknown command '${line}' (try /help)`))
      }
    }

    const frameText = (f: Frame) => `${MSG_TYPE_NAMES[f.type] ?? `0x${f.type.toString(16)}`} tag ${f.tag.toString(16).padStart(4, '0')} ${toHex(f.payload, ' ')}`
    const offs = [
      store.subscribe(() => {
        const connected = store.getState().status === 'connected'
        const next = connected ? PROMPT_ON : PROMPT_IDLE
        if (editor.prompt !== next) {
          editor.prompt = next
          if (!running) editor.showPrompt()
        }
      }),
      store.on('packet', (p) => flags.rx && out(rxLine(p))),
      store.on('linkError', (e) => out(C.err(`[link] ${LINK_ERROR_NAMES[e.kind]}: ${e.reason}`) + C.dim(`  ${toHex(e.bytes.subarray(0, 24), ' ')}${e.bytes.length > 24 ? ' …' : ''}`))),
      store.on('log', (e) => out(e.level === 'info' ? C.dim(`[session] ${e.text}`) : e.level === 'warn' ? C.warn(`[session] ${e.text}`) : C.err(`[session] ${e.text}`))),
      store.on('frameOut', (f) => {
        if (f.type === MsgType.Ping) pingTags.add(f.tag)
        if (flags.frames === 'all' || (flags.frames === 'on' && f.type !== MsgType.Ping)) out(C.dim(`-> ${frameText(f)}`))
      }),
      store.on('frameIn', (f) => {
        const keepalive = f.type === MsgType.Ok && pingTags.delete(f.tag)
        if (flags.frames === 'all' || (flags.frames === 'on' && !keepalive)) out(C.dim(`<- ${frameText(f)}`))
      }),
    ]

    return () => {
      offs.forEach((off) => off())
      observer.disconnect()
      term.dispose()
    }
  }, [])

  return <div className="shell" ref={host} />
}
