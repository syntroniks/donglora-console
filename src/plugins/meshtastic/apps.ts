// The app payloads inside Data, by portnum (mesh.proto, telemetry.proto, neighborinfo.proto). Decoders throw
// ProtoError with offsets into the packet; writers build the same messages for tests and the simulated dongle.

import { enumName, HW_MODEL_NAMES, PortNum, ROLE_NAMES, ROUTING_ERROR_NAMES } from './codes.ts'
import { ProtoError, ProtoReader, ProtoWriter, WireType, type Tag } from './proto.ts'

export interface TextApp {
  kind: 'text'
  text: string
}

export interface PositionApp {
  kind: 'position'
  lat?: number
  lon?: number
  /** metres above MSL */
  altitude?: number
  /** unix seconds */
  time?: number
}

export interface UserApp {
  kind: 'nodeinfo'
  id?: string
  longName?: string
  shortName?: string
  hwModel: number
  hwModelName: string
  role: number
  roleName: string
  publicKey?: Uint8Array
}

export interface RouteDiscovery {
  route: number[]
  /** dB × 4 */
  snrTowards: number[]
  routeBack: number[]
  snrBack: number[]
}

export interface RoutingApp {
  kind: 'routing'
  variant: 'error' | 'route-request' | 'route-reply' | 'empty'
  errorReason?: number
  errorName?: string
  route?: RouteDiscovery
}

export interface DeviceMetrics {
  /** percent; over 100 means external power */
  batteryLevel?: number
  voltage?: number
  channelUtilization?: number
  airUtilTx?: number
  uptimeSeconds?: number
}

export interface EnvironmentMetrics {
  temperature?: number
  relativeHumidity?: number
  barometricPressure?: number
}

export interface TelemetryApp {
  kind: 'telemetry'
  time?: number
  /** field number of the oneof that was set, see TELEMETRY_VARIANT_NAMES */
  variant?: number
  device?: DeviceMetrics
  environment?: EnvironmentMetrics
}

export interface TracerouteApp extends RouteDiscovery {
  kind: 'traceroute'
}

export interface NeighborInfoApp {
  kind: 'neighborinfo'
  nodeId?: number
  neighbors: { nodeId?: number; snr?: number }[]
}

export interface OtherApp {
  kind: 'other'
  size: number
}

export type AppDecode = TextApp | PositionApp | UserApp | RoutingApp | TelemetryApp | TracerouteApp | NeighborInfoApp | OtherApp

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Per field number: the wire type it must arrive with (null: the handler checks), and what to do with it. */
type Schema = Record<number, [number | null, (t: Tag) => void]>

/** Reads a message by schema; fields it doesn't list are skipped, as protobuf requires. */
function read(r: ProtoReader, schema: Schema): void {
  for (let t = r.tag(); t; t = r.tag()) {
    const f = schema[t.field]
    if (!f) {
      r.skip(t.wire)
      continue
    }
    if (f[0] !== null) r.expect(t, f[0])
    f[1](t)
  }
}

const { Varint, Fixed32, Len } = WireType

/** `at` is where the payload starts in the packet, so errors point at the right byte. */
export function decodeApp(portnum: number, payload: Uint8Array, at: number): AppDecode {
  const r = new ProtoReader(payload, at)
  switch (portnum) {
    case PortNum.Text:
      try {
        return { kind: 'text', text: utf8.decode(payload) }
      } catch {
        throw new ProtoError('text is not valid UTF-8', at)
      }
    case PortNum.Position:
      return position(r)
    case PortNum.NodeInfo:
      return user(r)
    case PortNum.Routing:
      return routing(r)
    case PortNum.Telemetry:
      return telemetry(r)
    case PortNum.Traceroute:
      return { kind: 'traceroute', ...routeDiscovery(r) }
    case PortNum.NeighborInfo:
      return neighborInfo(r)
    default:
      return { kind: 'other', size: payload.length }
  }
}

function position(r: ProtoReader): PositionApp {
  const p: PositionApp = { kind: 'position' }
  read(r, {
    1: [Fixed32, () => { p.lat = r.sfixed32() / 1e7 }],
    2: [Fixed32, () => { p.lon = r.sfixed32() / 1e7 }],
    3: [Varint, () => { p.altitude = r.int32() }],
    4: [Fixed32, () => { p.time = r.fixed32() }],
  })
  return p
}

function user(r: ProtoReader): UserApp {
  // proto3 leaves zero enums off the wire, so a missing role is CLIENT and a missing model UNSET
  const u: UserApp = { kind: 'nodeinfo', hwModel: 0, hwModelName: '', role: 0, roleName: '' }
  read(r, {
    1: [Len, () => { u.id = r.string() }],
    2: [Len, () => { u.longName = r.string() }],
    3: [Len, () => { u.shortName = r.string() }],
    5: [Varint, () => { u.hwModel = r.int32() }],
    7: [Varint, () => { u.role = r.int32() }],
    8: [Len, () => { u.publicKey = r.bytes().slice() }],
  })
  u.hwModelName = enumName(HW_MODEL_NAMES, u.hwModel)
  u.roleName = enumName(ROLE_NAMES, u.role)
  return u
}

function routing(r: ProtoReader): RoutingApp {
  const out: RoutingApp = { kind: 'routing', variant: 'empty' }
  read(r, {
    1: [Len, () => {
      out.variant = 'route-request'
      out.route = routeDiscovery(r.message())
    }],
    2: [Len, () => {
      out.variant = 'route-reply'
      out.route = routeDiscovery(r.message())
    }],
    3: [Varint, () => {
      out.variant = 'error'
      out.errorReason = r.int32()
      out.errorName = enumName(ROUTING_ERROR_NAMES, out.errorReason)
    }],
  })
  return out
}

function routeDiscovery(r: ProtoReader): RouteDiscovery {
  const d: RouteDiscovery = { route: [], snrTowards: [], routeBack: [], snrBack: [] }
  read(r, {
    1: [null, (t) => r.repeated(t, Fixed32, (x) => x.fixed32(), d.route)],
    2: [null, (t) => r.repeated(t, Varint, (x) => x.int32(), d.snrTowards)],
    3: [null, (t) => r.repeated(t, Fixed32, (x) => x.fixed32(), d.routeBack)],
    4: [null, (t) => r.repeated(t, Varint, (x) => x.int32(), d.snrBack)],
  })
  return d
}

function telemetry(r: ProtoReader): TelemetryApp {
  const out: TelemetryApp = { kind: 'telemetry' }
  // the oneof: only device and environment metrics are decoded, the rest are named
  const variant = (t: Tag) => {
    out.variant = t.field
    if (t.field === 2) out.device = deviceMetrics(r.message())
    else if (t.field === 3) out.environment = environmentMetrics(r.message())
    else r.skip(t.wire)
  }
  read(r, {
    1: [Fixed32, () => { out.time = r.fixed32() }],
    2: [Len, variant],
    3: [Len, variant],
    4: [Len, variant],
    5: [Len, variant],
    6: [Len, variant],
    7: [Len, variant],
    8: [Len, variant],
  })
  return out
}

function deviceMetrics(r: ProtoReader): DeviceMetrics {
  const m: DeviceMetrics = {}
  read(r, {
    1: [Varint, () => { m.batteryLevel = r.uint32() }],
    2: [Fixed32, () => { m.voltage = r.float() }],
    3: [Fixed32, () => { m.channelUtilization = r.float() }],
    4: [Fixed32, () => { m.airUtilTx = r.float() }],
    5: [Varint, () => { m.uptimeSeconds = r.uint32() }],
  })
  return m
}

function environmentMetrics(r: ProtoReader): EnvironmentMetrics {
  const m: EnvironmentMetrics = {}
  read(r, {
    1: [Fixed32, () => { m.temperature = r.float() }],
    2: [Fixed32, () => { m.relativeHumidity = r.float() }],
    3: [Fixed32, () => { m.barometricPressure = r.float() }],
  })
  return m
}

function neighborInfo(r: ProtoReader): NeighborInfoApp {
  const out: NeighborInfoApp = { kind: 'neighborinfo', neighbors: [] }
  read(r, {
    1: [Varint, () => { out.nodeId = r.uint32() }],
    4: [Len, () => {
      const n: { nodeId?: number; snr?: number } = {}
      const inner = r.message()
      read(inner, {
        1: [Varint, () => { n.nodeId = inner.uint32() }],
        2: [Fixed32, () => { n.snr = inner.float() }],
      })
      out.neighbors.push(n)
    }],
  })
  return out
}

// ---- writers ----

export const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text)

export function encodePosition(p: { lat: number; lon: number; altitude?: number; time?: number }): Uint8Array {
  const w = new ProtoWriter().fixed32(1, Math.round(p.lat * 1e7)).fixed32(2, Math.round(p.lon * 1e7))
  if (p.altitude !== undefined) w.varint(3, p.altitude)
  if (p.time !== undefined) w.fixed32(4, p.time)
  return w.toBytes()
}

export function encodeUser(u: { id: string; longName: string; shortName: string; hwModel?: number; role?: number; publicKey?: Uint8Array }): Uint8Array {
  const w = new ProtoWriter().string(1, u.id).string(2, u.longName).string(3, u.shortName)
  if (u.hwModel) w.varint(5, u.hwModel)
  if (u.role) w.varint(7, u.role)
  if (u.publicKey) w.bytes(8, u.publicKey)
  return w.toBytes()
}

export function encodeTelemetry(t: { time?: number; device?: DeviceMetrics; environment?: EnvironmentMetrics }): Uint8Array {
  const w = new ProtoWriter()
  if (t.time !== undefined) w.fixed32(1, t.time)
  if (t.device) {
    const d = t.device
    const m = new ProtoWriter()
    if (d.batteryLevel !== undefined) m.varint(1, d.batteryLevel)
    if (d.voltage !== undefined) m.float(2, d.voltage)
    if (d.channelUtilization !== undefined) m.float(3, d.channelUtilization)
    if (d.airUtilTx !== undefined) m.float(4, d.airUtilTx)
    if (d.uptimeSeconds !== undefined) m.varint(5, d.uptimeSeconds)
    w.bytes(2, m.toBytes())
  }
  if (t.environment) {
    const e = t.environment
    const m = new ProtoWriter()
    if (e.temperature !== undefined) m.float(1, e.temperature)
    if (e.relativeHumidity !== undefined) m.float(2, e.relativeHumidity)
    if (e.barometricPressure !== undefined) m.float(3, e.barometricPressure)
    w.bytes(3, m.toBytes())
  }
  return w.toBytes()
}

/** An ack is a routing packet with error NONE and the acked packet's id as the Data's requestId. */
export const encodeRoutingError = (errorReason: number): Uint8Array => new ProtoWriter().varint(3, errorReason).toBytes()

export function encodeRouteDiscovery(d: Partial<RouteDiscovery>): Uint8Array {
  const w = new ProtoWriter()
  if (d.route?.length) w.packedFixed32(1, d.route)
  if (d.routeBack?.length) w.packedFixed32(3, d.routeBack)
  return w.toBytes()
}
