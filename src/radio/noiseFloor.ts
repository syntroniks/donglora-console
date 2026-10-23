// Noise floor tracking. No DOM.
//
// Two inputs. Protocol v1.1's RADIO_STATUS (firmware 1.6.0) reads the SX126x instantaneous RSSI between
// packets, in 0.5 dB steps; the client polls it as its keepalive, and those samples are 'measured'.
// Without it (DongLoRa 1.5.2, protocol v1.0) the only input is per-packet: RSSI averaged over the packet
// (signal + noise) and SNR, both rounded to whole dB before scaling by 10 (firmware/src/radio.rs, lora-phy
// sx126x), so nothing here claims finer precision. The noise in a packet is RSSI minus the signal's share
// of the power:
//   N = RSSI − 10·log10(1 + 10^(SNR/10))
// which holds for negative SNR too (SNR −10 dB: N ≈ RSSI − 0.4).
//
// Samples carry their source; measured ones take over while they keep arriving, and packet estimates
// come back when they stop (eg. RX stopped: RADIO_STATUS reports no RSSI outside continuous RX).
//
// The floor itself copies MeshCore (src/helpers/radiolib/RadioLibWrappers.cpp loop()): start unset, add
// only samples below floor + 14 dB (any sample while unset), and after 64 of them set the floor to their
// integer average, clamped at −120 dBm, then start the next batch. With packet estimates that takes 64
// packets, so a rolling median over the last few estimates is kept as well.

export type NoiseSource = 'packet-estimate' | 'measured'

export const NOISE_SOURCE_LABELS: Record<NoiseSource, string> = {
  'packet-estimate': 'estimated from packets',
  measured: 'measured (RADIO_STATUS)',
}

export interface NoiseSample {
  at: number // Date.now()
  dbm: number
  source: NoiseSource
}

/** Noise power in dBm under a received packet. */
export function packetNoiseDbm(rssi: number, snr: number): number {
  return rssi - 10 * Math.log10(1 + 10 ** (snr / 10))
}

export const NUM_NOISE_FLOOR_SAMPLES = 64
export const SAMPLING_THRESHOLD_DB = 14
export const FLOOR_CLAMP_DBM = -120
export const MEDIAN_WINDOW = 15
/** measured samples count as live for this long; after that packet estimates take over again */
const MEASURED_STALE_MS = 10_000

export interface NoiseFloorState {
  source: NoiseSource // the source in use
  /** MeshCore-method floor, whole dBm; undefined until the first batch completes */
  floor?: number
  floorAt?: number
  /** samples accepted into the current batch, of NUM_NOISE_FLOOR_SAMPLES */
  pending: number
  /** median of the last MEDIAN_WINDOW samples, whole dBm */
  median?: number
  medianCount: number
  last?: NoiseSample
  accepted: number
  rejected: number // above floor + 14 dB
}

/** MeshCore's batch floor plus a rolling median, for one source. */
class SourceTracker {
  floor?: number
  floorAt?: number
  private sum = 0
  pending = 0
  accepted = 0
  rejected = 0
  recent: number[] = []
  last?: NoiseSample

  add(s: NoiseSample): void {
    this.last = s
    this.recent.push(s.dbm)
    if (this.recent.length > MEDIAN_WINDOW) this.recent.shift()
    const v = Math.round(s.dbm) // MeshCore sums int dBm
    if (this.floor !== undefined && v >= this.floor + SAMPLING_THRESHOLD_DB) {
      this.rejected++
      return
    }
    this.accepted++
    this.sum += v
    if (++this.pending >= NUM_NOISE_FLOOR_SAMPLES) {
      this.floor = Math.max(Math.trunc(this.sum / NUM_NOISE_FLOOR_SAMPLES), FLOOR_CLAMP_DBM)
      this.floorAt = s.at
      this.sum = 0
      this.pending = 0
    }
  }

  median(): number | undefined {
    if (!this.recent.length) return undefined
    const xs = [...this.recent].sort((a, b) => a - b)
    const m = xs.length >> 1
    return Math.round(xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2)
  }
}

export class NoiseFloorTracker {
  private readonly trackers: Record<NoiseSource, SourceTracker> = {
    'packet-estimate': new SourceTracker(),
    measured: new SourceTracker(),
  }

  add(sample: NoiseSample): void {
    if (!Number.isFinite(sample.dbm)) return
    this.trackers[sample.source].add(sample)
  }

  /** Per-packet estimate from a received packet; packets that failed CRC have no trustworthy SNR. */
  addPacket(rssi: number, snr: number, crcValid: boolean, at = Date.now()): number | undefined {
    if (!crcValid) return undefined
    const dbm = packetNoiseDbm(rssi, snr)
    this.add({ at, dbm, source: 'packet-estimate' })
    return dbm
  }

  source(now = Date.now()): NoiseSource {
    const m = this.trackers.measured.last
    return m && now - m.at < MEASURED_STALE_MS ? 'measured' : 'packet-estimate'
  }

  /** The source in use, or the one asked for. */
  snapshot(now = Date.now(), source = this.source(now)): NoiseFloorState {
    const t = this.trackers[source]
    return {
      source,
      floor: t.floor,
      floorAt: t.floorAt,
      pending: t.pending,
      median: t.median(),
      medianCount: t.recent.length,
      last: t.last,
      accepted: t.accepted,
      rejected: t.rejected,
    }
  }
}
