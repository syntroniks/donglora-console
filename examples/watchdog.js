// Soak watchdog for `pnpm server --script examples/watchdog.js`, or paste it into the Scripts tab.
// Once a minute: packets and bad CRCs in that minute, RSSI now, the noise floor and the device counters.
// Warns when the radio looks deaf: RSSI reading exactly 0 dBm, or no packets for 10 minutes.

let packets = 0
let crcBad = 0
let quiet = 0
on('packet', (p) => {
  packets++
  if (!p.rx.crcValid) crcBad++
})
on('node', (n) => n.isNew && print(`new ${n.protocol} node: ${n.name || n.id}${n.kind ? ` (${n.kind})` : ''}`))
on('message', (m) => print(`[${m.protocol} ${m.channel}] ${m.sender}: ${m.text}`))
on('disconnected', (e) => warn(`disconnected${e.error ? `: ${e.error}` : ''}`))
on('connected', () => print('connected'))

every(60_000, async () => {
  const s = await radio.status()
  const { noise } = await radio.state()
  const rssi = s?.rssiInst
  print(`1 min: ${packets} packets (${crcBad} bad CRC), RSSI ${rssi ?? 'n/a'} dBm, floor ${noise.floor ?? 'pending'} dBm, device rx_ok ${s?.rxOk ?? '-'} crc_err ${s?.rxCrcErr ?? '-'} header_err ${s?.rxHeaderErr ?? '-'}`)
  if (rssi === 0) warn('RSSI reads exactly 0 dBm: radio reads look dead')
  quiet = packets ? 0 : quiet + 1
  if (quiet >= 10) warn(`no packets for ${quiet} minutes`)
  packets = 0
  crcBad = 0
})
print(`watchdog up on ${(await radio.state()).preset ?? 'a custom config'}`)
