/**
 * Test signals at 32 kHz — high enough that the top of the hearing range is in
 * the picture, low enough to stay quick. The voice is borrowed from the FLAC
 * exhibit (16 kHz) and upsampled; the rest are made here.
 */

import { seeded } from '../../lib/samples'
import { synth as flacSynth } from '../flac/flac'

export const FS = 32000
export const SECONDS = 2.5

export type SignalId = 'masking' | 'chord' | 'voice' | 'drums' | 'pluck' | 'noise'

export const SIGNALS: { id: SignalId; label: string; note: string }[] = [
  { id: 'masking', label: 'Masking demo', note: 'a loud 1 kHz tone, with quiet beeps at 1.1 kHz and 6 kHz' },
  { id: 'chord', label: 'Piano chord', note: 'harmonics up to 8 kHz, decaying' },
  { id: 'voice', label: 'Voice-ish', note: 'a buzz through vowel formants' },
  { id: 'drums', label: 'Drums', note: 'sharp attacks: where pre-echo lives' },
  { id: 'pluck', label: 'Plucked string', note: 'Karplus–Strong' },
  { id: 'noise', label: 'Noise', note: 'nothing tonal to hide behind' },
]

const TAU = 2 * Math.PI

export function synth(id: SignalId): Float64Array {
  const n = Math.round(FS * SECONDS)
  const out = new Float64Array(n)
  const rnd = seeded(id.length * 104729 + 3)
  if (id === 'masking') {
    for (let i = 0; i < n; i++) {
      const t = i / FS
      const fade = Math.min(1, t / 0.02, (SECONDS - t) / 0.02)
      // Quiet beeps 40 dB down, on for 0.25 s of every 0.5 s, alternating.
      const slot = Math.floor(t / 0.5)
      const inSlot = (t % 0.5) / 0.25
      const env = inSlot < 1 ? Math.sin(Math.PI * inSlot) ** 2 : 0
      const near = slot % 2 === 0 ? env : 0
      const far = slot % 2 === 1 ? env : 0
      out[i] = fade * (12000 * Math.sin(TAU * 1000 * t) + 120 * near * Math.sin(TAU * 1100 * t) + 120 * far * Math.sin(TAU * 6000 * t))
    }
  } else if (id === 'chord') {
    const notes = [261.63, 329.63, 392.0, 523.25]
    for (let i = 0; i < n; i++) {
      const t = i / FS
      let v = 0
      notes.forEach((f0, j) => {
        const start = j * 0.12
        if (t < start) return
        const tt = t - start
        for (let h = 1; h * f0 < 8000; h++) {
          const f = f0 * h * Math.sqrt(1 + 0.0004 * h * h) // a little piano-string stretch
          v += (Math.sin(TAU * f * tt) / h) * Math.exp(-tt * (0.8 + 0.6 * h))
        }
      })
      out[i] = v * 5000 * Math.min(1, t / 0.004)
    }
  } else if (id === 'voice') {
    const v16 = flacSynth('voice', SECONDS)
    for (let i = 0; i < n; i++) {
      const p = i / 2
      const a = Math.floor(p)
      const w = p - a
      out[i] = (v16[Math.min(a, v16.length - 1)] ?? 0) * (1 - w) + (v16[Math.min(a + 1, v16.length - 1)] ?? 0) * w
    }
  } else if (id === 'drums') {
    const beat = 0.3125
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / FS
      const b = Math.floor(t / beat)
      const tb = t - b * beat
      let v = 0
      if (b % 2 === 0) {
        const f = 50 + 90 * Math.exp(-tb * 35)
        v += Math.sin(TAU * f * tb) * Math.exp(-tb * 10) * 0.9
      } else {
        v += (Math.sin(TAU * 190 * tb) * 0.35 + (rnd() * 2 - 1) * 0.65) * Math.exp(-tb * 25)
      }
      // Hi-hat: high-passed noise, a sharp click every half beat.
      const th = t % (beat / 2)
      const noise = rnd() * 2 - 1
      lp = 0.5 * lp + 0.5 * noise
      v += (noise - lp) * 0.4 * Math.exp(-th * 80)
      out[i] = v * 14000 * (b === 0 && tb < 0.0005 ? tb / 0.0005 : 1)
    }
    // Start in silence so the first attack shows pre-echo.
    const lead = Math.round(0.2 * FS)
    out.copyWithin(lead, 0, n - lead)
    out.fill(0, 0, lead)
  } else if (id === 'pluck') {
    const notes = [196, 246.94, 293.66, 392, 329.63]
    const per = Math.floor(n / notes.length)
    for (let k = 0; k < notes.length; k++) {
      const L = Math.round(FS / notes[k])
      const buf = new Float64Array(L)
      for (let j = 0; j < L; j++) buf[j] = rnd() * 2 - 1
      let p = 0
      for (let i = 0; i < per; i++) {
        const next = (p + 1) % L
        const v = buf[p]
        buf[p] = 0.997 * 0.5 * (buf[p] + buf[next])
        p = next
        out[k * per + i] = v * 14000
      }
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 6000
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, out[i]))
  return out
}
