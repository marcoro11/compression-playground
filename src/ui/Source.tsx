import { useMemo, useState } from 'react'
import { SAMPLES, sampleBytes } from '../lib/samples'
import { utf8 } from '../lib/text'
import { Help } from './Controls'

/**
 * The input every lossless exhibit starts from: a sample preset or your own
 * text. Binary samples (random bytes) cannot be shown in a textarea, so while
 * one is selected the box is replaced by a note; typing anything switches back.
 */
export interface SourceState {
  bytes: Uint8Array
  text: string
  sampleId: string | null
  setText(t: string): void
  setSample(id: string): void
  /** Changes whenever the input does — handy as a stepper resetKey. */
  key: string
}

export function useSource(initial = 'tobe', maxBytes = 4096): SourceState {
  const [sampleId, setSampleId] = useState<string | null>(initial)
  const [text, setTextRaw] = useState(() => SAMPLES.find((s) => s.id === initial)?.text ?? '')
  const bytes = useMemo(() => {
    const s = SAMPLES.find((x) => x.id === sampleId)
    const b = s?.bytes ? sampleBytes(s) : utf8(text)
    return b.length > maxBytes ? b.subarray(0, maxBytes) : b
  }, [sampleId, text, maxBytes])
  return {
    bytes,
    text,
    sampleId,
    setText(t) {
      setTextRaw(t)
      setSampleId(SAMPLES.find((s) => s.text === t)?.id ?? null)
    },
    setSample(id) {
      const s = SAMPLES.find((x) => x.id === id)
      if (!s) return
      setSampleId(id)
      if (s.text !== undefined) setTextRaw(s.text)
    },
    key: (sampleId ?? '') + '\u0000' + text,
  }
}

export function SourceInput({
  src,
  samples,
  maxBytes = 4096,
  rows = 3,
  help,
}: {
  src: SourceState
  /** Restrict the preset list to these ids (in this order). Defaults to all. */
  samples?: string[]
  maxBytes?: number
  rows?: number
  help?: string
}) {
  const list = samples ? samples.map((id) => SAMPLES.find((s) => s.id === id)!).filter(Boolean) : SAMPLES
  const current = SAMPLES.find((s) => s.id === src.sampleId)
  const binary = current?.bytes !== undefined
  const over = utf8(src.text).length > maxBytes
  return (
    <div className="source">
      <div className="source-head">
        <span className="ctl-label">
          Input
          {help && <Help text={help} />}
        </span>
        <span className="source-count">
          {src.bytes.length} byte{src.bytes.length === 1 ? '' : 's'}
          {over && <em> (first {maxBytes})</em>}
        </span>
      </div>
      {binary ? (
        <div className="source-binary" onClick={() => src.setText('')}>
          {src.bytes.length} pseudo-random bytes. <u>Type your own instead</u>
        </div>
      ) : (
        <textarea rows={rows} value={src.text} spellCheck={false} onChange={(e) => src.setText(e.target.value)} />
      )}
      <div className="chips">
        {list.map((s) => (
          <button key={s.id} type="button" className={'chip' + (s.id === src.sampleId ? ' on' : '')} onClick={() => src.setSample(s.id)} title={s.note}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
