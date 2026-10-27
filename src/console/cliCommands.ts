// The console's own shell commands. Nothing typed here goes to the dongle as text: DongLoRa has no CLI,
// so every command maps onto protocol frames (or on to console state).

export interface CommandHelp {
  usage: string
  summary: string
}

export const LOCAL_COMMANDS: CommandHelp[] = [
  { usage: '/help', summary: 'this list' },
  { usage: '/clear', summary: 'clear the terminal' },
  { usage: '/info', summary: 'GET_INFO: firmware, radio, capabilities, limits' },
  { usage: '/ping', summary: 'PING round trip' },
  { usage: '/config', summary: 'requested config and what the dongle echoed back' },
  { usage: '/preset <id>', summary: 'SET_CONFIG with a plugin preset, eg. meshcore-us, meshtastic-longfast-us (RX restarts if it was on)' },
  { usage: '/plugins', summary: 'protocol plugins, their presets, and which one decodes the current config' },
  { usage: '/rx on|off', summary: 'print received packets, failures included, as they arrive' },
  { usage: '/rx start|stop', summary: 'RX_START / RX_STOP on the radio' },
  { usage: '/frames on|all|off', summary: 'hex of frames to and from the dongle (all = with keepalive PING / RADIO_STATUS)' },
  { usage: '/stats', summary: 'packet, failure and link error counts, device RX counters, keepalive health' },
  { usage: '/noise', summary: 'noise floor, its source (RADIO_STATUS or packets), RSSI now and per-packet values' },
  { usage: '/agc', summary: 'receiver front end: RX gain, AGC reset, FEM, LNA, PA (device-reported where it can be)' },
  { usage: '/errors', summary: 'the last link errors' },
  { usage: '/nodes', summary: 'nodes the plugins learned about, every protocol' },
  { usage: '/scripts', summary: 'saved scripts and which are running (edit them on the Scripts tab)' },
  { usage: '/run <script>', summary: 'start a script by name' },
  { usage: '/stop <script>', summary: 'stop a script by name, or all of them with /stop all' },
  { usage: '/tx <hex>', summary: 'transmit raw bytes; needs TX armed on the Radio tab, asks to confirm' },
]

/** The literal part of a usage string: '/tx <hex>' -> '/tx ', '/rx on|off' -> '/rx '. */
export function literalPrefix(usage: string): string {
  const words = usage.split(' ')
  const out: string[] = []
  for (const w of words) {
    if (w.startsWith('<') || w.includes('|')) return out.join(' ') + ' '
    out.push(w)
  }
  return out.join(' ')
}

/** Every literal word choice, so '/rx s' completes to '/rx start'. */
function expand(usage: string): string[] {
  const words = usage.split(' ')
  const i = words.findIndex((w) => w.includes('|'))
  if (i < 0) return [literalPrefix(usage)]
  const head = words.slice(0, i).join(' ')
  return words[i].split('|').map((choice) => `${head} ${choice}`)
}

const COMPLETIONS = [...new Set(LOCAL_COMMANDS.flatMap((c) => [literalPrefix(c.usage), ...expand(c.usage)]))]

export function completeCommand(line: string): string[] {
  return COMPLETIONS.filter((c) => c.startsWith(line) && c !== line)
}
