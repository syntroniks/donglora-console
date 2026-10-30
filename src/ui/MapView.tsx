// Heard nodes that report a position, as pins on an OpenStreetMap map. MeshCore adverts carry one when
// the node has a location set; Meshtastic nodes send position packets. Names come off the air, so the
// popups are built as DOM text, never as HTML.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useRef } from 'react'
import { pluginById } from '../plugins/index.ts'
import { Button, Card, Empty } from './parts.tsx'
import type { HeardNode, RadioState } from './store.ts'
import { ago, coords, level, shortKey } from './format.ts'

/** 0, 0 is what a node without a location set sends */
export const hasPosition = (n: HeardNode): n is HeardNode & { lat: number; lon: number } =>
  n.lat !== undefined && n.lon !== undefined && (n.lat !== 0 || n.lon !== 0)

const KIND_COLORS: Record<string, string> = {
  repeater: '#e0605b',
  router: '#e0605b',
  'room server': '#d9a441',
  sensor: '#7a9be0',
}
const kindColor = (kind?: string) => (kind && KIND_COLORS[kind]) || '#4fb3a9'

const LEGEND = [
  { label: 'repeater / router', color: KIND_COLORS.repeater },
  { label: 'room server', color: KIND_COLORS['room server'] },
  { label: 'sensor', color: KIND_COLORS.sensor },
  { label: 'companion / client', color: kindColor() },
]

const nodeKey = (n: HeardNode) => `${n.protocol}:${n.id}`

function popup(n: HeardNode & { lat: number; lon: number }): HTMLElement {
  const el = document.createElement('div')
  el.className = 'map-popup'
  const line = (text: string, cls?: string) => {
    const d = document.createElement('div')
    if (cls) d.className = cls
    d.textContent = text
    el.append(d)
  }
  line(n.name || '(no name)', 'map-popup-name')
  line(`${pluginById(n.protocol)?.name ?? n.protocol} · ${n.kind ?? 'unknown kind'}`)
  line(`heard ${ago(n.lastHeard, Date.now())} · ${n.sightings}×`)
  line(`RSSI ${level(n.rssi)} · SNR ${level(n.snr)}${n.hops !== undefined ? ` · ${n.hops} hops` : ''}`)
  line(coords(n.lat, n.lon))
  line(n.id.startsWith('!') ? n.id : shortKey(n.id), 'map-popup-id')
  return el
}

export function MapView({ state }: { state: RadioState }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const pins = useRef(new Map<string, L.CircleMarker>())
  const fitted = useRef(false)
  const located = useMemo(() => Object.values(state.nodes).filter(hasPosition), [state.nodes])
  const unlocated = Object.keys(state.nodes).length - located.length

  useEffect(() => {
    const m = L.map(box.current!, { worldCopyJump: true }).setView([20, 0], 2)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    map.current = m
    const markers = pins.current
    return () => {
      m.remove()
      map.current = null
      markers.clear()
      fitted.current = false
    }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    const seen = new Set<string>()
    for (const n of located) {
      const key = nodeKey(n)
      seen.add(key)
      const color = kindColor(n.kind)
      const style = { color, fillColor: color, fillOpacity: 0.75, weight: 2, radius: n.kind === 'repeater' || n.kind === 'router' ? 8 : 6 }
      let pin = pins.current.get(key)
      if (pin) {
        pin.setLatLng([n.lat, n.lon]).setStyle(style).setRadius(style.radius)
      } else {
        pin = L.circleMarker([n.lat, n.lon], style).addTo(m)
        pins.current.set(key, pin)
      }
      pin.bindTooltip(n.name || shortKey(n.id), { direction: 'top', offset: [0, -6] })
      // rebinding replaces an open popup's content, so only refresh it when it's closed
      if (!pin.isPopupOpen()) pin.bindPopup(popup(n))
    }
    for (const [key, pin] of pins.current) {
      if (!seen.has(key)) {
        pin.remove()
        pins.current.delete(key)
      }
    }
    if (!fitted.current && located.length) {
      fitted.current = true
      fit()
    }
  }, [located])

  const fit = () => {
    const m = map.current
    if (!m || !located.length) return
    m.fitBounds(L.latLngBounds(located.map((n) => [n.lat, n.lon])), { padding: [40, 40], maxZoom: 13 })
  }

  return (
    <div className="map-view">
      <Card
        title={`Map (${located.length})`}
        actions={
          <>
            <span className="muted small">
              {unlocated ? `${unlocated} heard node${unlocated === 1 ? '' : 's'} without a position` : 'nodes that report a position'}
            </span>
            <Button kind="small" onClick={fit} disabled={!located.length}>fit all</Button>
          </>
        }
      >
        <div className="map-legend">
          {LEGEND.map((l) => (
            <span key={l.label}><i style={{ background: l.color }} />{l.label}</span>
          ))}
        </div>
        <div className="map-box">
          <div ref={box} className="map" />
          {!located.length && (
            <div className="map-empty">
              <Empty>Pins appear when a node reports where it is: MeshCore adverts from nodes with a location set, Meshtastic position packets.</Empty>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
