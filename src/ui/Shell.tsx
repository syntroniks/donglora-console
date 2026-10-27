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
import { matchPreset, pluginById, PLUGINS, presetById, PRESETS } from '../plugins/index.ts'
import { FRONT_END_ROWS, FRONT_END_SOURCE_LABELS, frontEndFor, TX_POWER_MEANING_LABELS, txPowerMeaning } from '../radio/frontEnd.ts'
import { MEDIAN_WINDOW, NOISE_SOURCE_LABELS, NUM_NOISE_FLOOR_SAMPLES } from '../radio/noiseFloor.ts'
import { scripts } from './scripts.ts'
import { radioStatusAvailable, store, type PacketEntry } from './store.ts'
import { ago, level, plural, time } from './format.ts'

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
  const meta = `${level(p.rx.rssi)} dBm ${level(p.rx.snr)} dB${p.noise !== undefined ? ` noise ${Math.round(p.noise)}` : ''} ${p.rx.data.length}B`
  const m = p.decode
  const proto = pluginById(m.protocol)?.name ?? 'no plugin'
  const where = m.failure ? ` [${m.failure.stage} @${m.failure.offset}]` : ''
  if (!p.rx.crcValid) return C.err(`[rx] CRC FAIL ${meta}  (untrusted) ${proto} ${m.status}${where}: ${m.failure ? m.failure.reason : m.summary}`)
  if (m.status === 'partial' || m.status === 'undecodable') return C.err(`[rx] ${proto} ${m.status.toUpperCase()} ${meta}${where}: ${m.failure!.reason}  ${C.dim(toHex(p.rx.data).slice(0, 48))}`)
  if (m.status === 'no-key' || m.status === 'unknown') return C.dim(`[rx] ${m.status === 'unknown' ? 'no plugin' : `${proto} no key`} ${meta}  ${m.summary}`)
  return `${C.dim(`[rx] ${proto}`)} ${C.dim(meta)}  ${m.summary}`
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
    const keepaliveTags = new Set<number>()

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
          if (!p) return say(C.err(`presets: ${PRESETS.map((x) => x.id).join(', ')} (or a unique suffix, eg. us)`))
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
          say(`RX ${st.rx}: ${C.ok(`${st.status.decoded} decoded`)}, ${st.status.partial} partial, ${st.status.undecodable} undecodable, ${st.status['no-key']} no key, ${st.status.unknown} no plugin; ${st.crcFail ? C.err(`${st.crcFail} CRC fail`) : '0 CRC fail'}; ${st.dropped} dropped by device`)
          const stages = Object.entries(st.stages).map(([k, v]) => `${k} ${v}`).join(', ')
          if (stages) say(`decode failures by stage: ${stages}`)
          const link = Object.entries(st.link).map(([k, v]) => `${LINK_ERROR_NAMES[k as keyof typeof LINK_ERROR_NAMES]} ${v}`).join(', ')
          say(`link errors ${st.linkTotal}${link ? `: ${link}` : ''}`)
          if (st.good) say(`RSSI avg ${(st.rssiSum / st.good).toFixed(1)} dBm (${st.rssiMin}…${st.rssiMax}), SNR avg ${(st.snrSum / st.good).toFixed(1)} dB (${st.snrMin}…${st.snrMax})`)
          const r = s.radioStatus
          if (r) {
            const b = s.countersBase ?? r
            say(`radio counters since boot ${C.dim('(RADIO_STATUS, +since connect)')}: ${r.rxOk} good CRC (+${r.rxOk - b.rxOk}), ${r.rxCrcErr ? C.err(`${r.rxCrcErr} CRC error`) : '0 CRC error'} (+${r.rxCrcErr - b.rxCrcErr}), ${r.rxHeaderErr ? C.err(`${r.rxHeaderErr} header error`) : '0 header error'} (+${r.rxHeaderErr - b.rxHeaderErr}, no bytes)`)
          }
          const h = s.health
          if (h) say(`keepalive ${h.pings} ${h.command ?? 'PING'} ok, ${h.failures} failed, rtt ${h.lastRttMs?.toFixed(1) ?? '-'} ms, longest gap ${h.maxGapMs} ms, sessions lost ${h.lostSessions} (${h.recoveries} restored)`)
          return
        }
        case 'noise': {
          const n = s.noise
          say(`noise floor ${C.dim(`(${NOISE_SOURCE_LABELS[n.source]})`)}`)
          say(`  MeshCore method  ${n.floor !== undefined ? `${n.floor} dBm, set ${ago(n.floorAt)}` : C.dim(`pending, ${n.pending}/${NUM_NOISE_FLOOR_SAMPLES} samples`)}`)
          say(`  median last ${MEDIAN_WINDOW}   ${n.median !== undefined ? `${n.median} dBm over ${n.medianCount}` : C.dim('no samples')}`)
          say(`  last sample      ${n.last ? `${n.source === 'measured' ? level(n.last.dbm) : Math.round(n.last.dbm)} dBm, ${ago(n.last.at)}` : C.dim('none')}  (${n.accepted} used, ${n.rejected} over floor + 14 dB)`)
          if (radioStatusAvailable(s)) {
            const r = s.radioStatus
            say(`  RSSI now         ${!r ? C.dim('no RADIO_STATUS reply yet') : r.rssiInst !== null ? `${level(r.rssiInst)} dBm ${C.dim('(RADIO_STATUS)')}` : C.dim('none: the radio is not in continuous RX')}`)
          } else if (s.info) say(C.dim('  this firmware has no RADIO_STATUS, so the floor is estimated from packets'))
          const recent = s.packets.filter((p) => p.noise !== undefined).slice(0, 8)
          if (recent.length) say(`  recent packets   ${recent.map((p) => `${level(p.rx.rssi)}/${level(p.rx.snr)}→${Math.round(p.noise!)}`).join('  ')} ${C.dim('(RSSI/SNR→noise)')}`)
          return
        }
        case 'agc': {
          const fe = frontEndFor(s.info, s.radioStatus)
          say(`receiver front end, firmware ${fe.firmware}, board ${fe.board}${fe.boardAssumed ? C.dim(' (assumed)') : ''}`)
          for (const { key, label } of FRONT_END_ROWS) say(`  ${label.padEnd(14)} ${fe[key].value} ${C.dim(`[${FRONT_END_SOURCE_LABELS[fe[key].source]}]`)}`)
          return
        }
        case 'errors': {
          if (!s.linkErrors.length) return say(C.dim('no link errors'))
          for (const e of s.linkErrors.slice(0, 15).reverse()) say(C.err(`${time(e.at)} ${LINK_ERROR_NAMES[e.kind]}: ${e.reason}`) + C.dim(`  ${toHex(e.bytes.subarray(0, 24), ' ')}`))
          return
        }
        case 'nodes': {
          const nodes = Object.values(s.nodes).sort((a, b) => b.lastHeard - a.lastHeard)
          if (!nodes.length) return say(C.dim('no nodes heard yet'))
          for (const n of nodes) {
            const hops = n.hops !== undefined ? plural(n.hops, 'hop') : '?'
            say(`  ${(n.name || '(no name)').padEnd(22)} ${(pluginById(n.protocol)?.name ?? n.protocol).padEnd(11)} ${(n.kind ?? '').padEnd(12)} ${hops.padEnd(7)} ${level(n.rssi)} dBm ${C.dim(`${ago(n.lastHeard)} · ${n.id.slice(0, 9)}`)}`)
          }
          return
        }
        case 'plugins': {
          const active = matchPreset(s.applied?.lora ?? s.requested)
          for (const p of PLUGINS) {
            const claims = p.claims(s.applied?.lora ?? s.requested)
            say(`${C.accent(p.name.padEnd(11))} ${p.description}${claims ? C.ok('  (decoding)') : ''}`)
            say(C.dim(`  presets: ${p.presets.map((x) => (x.id === active?.id ? C.ok(x.id) + '\x1b[90m' : x.id)).join(', ')}`))
          }
          return
        }
        case 'scripts': {
          const st = scripts.getState()
          if (!st.scripts.length) return say(C.dim('no scripts yet: the Scripts tab has examples'))
          for (const x of st.scripts) say(`  ${st.running.includes(x.id) ? C.ok('running') : C.dim('stopped')} ${x.name}${x.allowTx ? C.warn(' (may transmit)') : ''}${x.runOnConnect ? C.dim(' · runs when connected') : ''}`)
          return
        }
        case 'run':
        case 'stop': {
          const name = args.join(' ')
          if (cmd === 'stop' && name === 'all') {
            for (const id of scripts.getState().running) scripts.stop(id)
            return
          }
          const x = name ? scripts.byName(name) : undefined
          if (!x) return say(C.err(`no script '${name}'; /scripts lists them`))
          if (cmd === 'run') scripts.run(x.id)
          else scripts.stop(x.id)
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
            return say(C.warn(`This transmits ${bytes.length} B on ${mhz(c.freqHz)} MHz at ${c.txPowerDbm} dBm (${TX_POWER_MEANING_LABELS[txPowerMeaning(s.info, s.radioStatus)]}). Enter the same command again within 30 s to send.`))
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
      scripts.onLine((spec, l) => out((l.level === 'err' ? C.err : l.level === 'warn' ? C.warn : (t: string) => t)(`${C.accent(`[${spec.name}]`)} ${l.text}`))),
      store.on('linkError', (e) => out(C.err(`[link] ${LINK_ERROR_NAMES[e.kind]}: ${e.reason}`) + C.dim(`  ${toHex(e.bytes.subarray(0, 24), ' ')}${e.bytes.length > 24 ? ' …' : ''}`))),
      store.on('log', (e) => out(e.level === 'info' ? C.dim(`[session] ${e.text}`) : e.level === 'warn' ? C.warn(`[session] ${e.text}`) : C.err(`[session] ${e.text}`))),
      store.on('frameOut', (f) => {
        // RADIO_STATUS is the keepalive on firmware that has it; a manual /ping is filtered with them
        const keepalive = f.type === MsgType.Ping || f.type === MsgType.RadioStatus
        if (keepalive) keepaliveTags.add(f.tag)
        if (flags.frames === 'all' || (flags.frames === 'on' && !keepalive)) out(C.dim(`-> ${frameText(f)}`))
      }),
      store.on('frameIn', (f) => {
        // forget the tag on either reply, but still print an ERR (eg. EUNKNOWN_CMD to RADIO_STATUS)
        const keepalive = (f.type === MsgType.Ok || f.type === MsgType.Err) && keepaliveTags.delete(f.tag) && f.type === MsgType.Ok
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
