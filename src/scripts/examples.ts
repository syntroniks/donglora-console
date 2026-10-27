// Starter scripts offered in the Scripts tab. None of them transmits.

export interface ScriptExample {
  name: string
  description: string
  source: string
}

export const EXAMPLES: ScriptExample[] = [
  {
    name: 'Packet log',
    description: 'one line per received packet, with its protocol and decode',
    source: `// One line per packet: protocol, signal and what the plugin made of it.
on('packet', (p) => {
  const crc = p.rx.crcValid ? '' : ' CRC FAIL'
  print(\`\${p.decode.protocol} \${p.rx.rssi} dBm \${p.rx.snr} dB\${crc} \${p.decode.status}: \${p.decode.summary}\`)
})
print('listening; the radio config decides which plugin decodes')
`,
  },
  {
    name: 'New nodes',
    description: 'announce each node the first time it is heard this session',
    source: `// Nodes come from plugins: MeshCore from signed adverts, Meshtastic from packets it can decrypt.
on('node', (n) => {
  if (!n.isNew) return
  const where = n.lat !== undefined ? \` at \${n.lat.toFixed(4)}, \${n.lon.toFixed(4)}\` : ''
  print(\`new \${n.protocol} node: \${n.name || n.id}\${n.kind ? \` (\${n.kind})\` : ''}, \${n.rssi} dBm\${where}\`)
})
`,
  },
  {
    name: 'Noise watch',
    description: 'every 10 s, instantaneous RSSI (firmware 1.6.0) and the noise floor',
    source: `// RADIO_STATUS needs DongLoRa 1.6.0 (protocol v1.1); without it status() gives undefined.
every(10_000, async () => {
  const s = await radio.status()
  const { noise } = await radio.state()
  print(\`RSSI \${s?.rssiInst ?? 'n/a'} dBm, floor \${noise.floor ?? 'pending'} dBm, median \${noise.median ?? '-'} dBm\`)
})
`,
  },
  {
    name: 'Protocol hopper',
    description: 'alternate between MeshCore and Meshtastic every 5 minutes, to hear both on one radio',
    source: `// One radio listens to one protocol at a time. Switch presets on a timer.
// Through a console server, mux keeps the config of whichever client set it first.
const presets = ['meshcore-us', 'meshtastic-longfast-us']
let i = 0
async function hop() {
  const id = presets[i++ % presets.length]
  await radio.setConfig(id)
  print(\`listening on \${id}\`)
}
await hop()
every(5 * 60_000, hop)
`,
  },
  {
    name: 'Message tally',
    description: 'print channel messages and count them per channel across sessions',
    source: `// storage keeps JSON values per script (in this browser, or in the server's memory).
on('message', async (m) => {
  const key = \`\${m.protocol}:\${m.channel}\`
  const n = ((await storage.get(key)) ?? 0) + 1
  await storage.set(key, n)
  print(\`[\${key} #\${n}] \${m.sender}: \${m.text}\`)
})
`,
  },
]
