import { specLines, worstState } from '../budget.js'
import type { StickerSpec, StickerView } from '../types.js'

const SHORT = (s: StickerSpec): string =>
  `${s.width}×${s.height} · ${s.fps}fps · ${Math.round(s.sizeBytes / 1024)}KB`

/** One-line verdict for a tile. Renders nothing until the encode has been measured. */
export function SpecBadge({ spec }: { spec?: StickerSpec }) {
  if (!spec) return null
  const state = worstState(specLines(spec))
  return (
    <span className={`spec-badge spec-${state}`} title={
      specLines(spec).map(l => `${l.label} ${l.value}`).join('\n')
    }>{SHORT(spec)}</span>
  )
}

export function SpecTable({ spec }: { spec: StickerSpec }) {
  const lines = specLines(spec)
  return (
    <ul className="spec-list" data-state={worstState(lines)}>
      {lines.map(l => (
        <li key={l.label} className={`spec-${l.state}`}>
          <span className="spec-k">{l.label}</span>
          <b className="spec-v">{l.value}</b>
        </li>
      ))}
    </ul>
  )
}

/**
 * What WhatsApp will actually receive: the sum of the measured WebPs. Estimated
 * figures never appear here — a pack with an unmeasured sticker says so instead.
 */
export function PackVerdict({ stickers }: { stickers: StickerView[] }) {
  const measured = stickers.filter(s => s.spec)
  if (!measured.length) return null
  const totalKb = Math.round(measured.reduce((n, s) => n + (s.spec?.sizeBytes ?? 0), 0) / 1024)
  const unmeasured = stickers.length - measured.length
  const state = worstState(measured.flatMap(s => specLines(s.spec!)))
  return (
    <div className={`pack-verdict spec-${state}`}>
      <b>{measured.length}</b> measured · <b>{totalKb}KB</b> total
      {state === 'ok' ? ' · within WhatsApp limits' : state === 'warn' ? ' · inside the cap, tight' : ' · exceeds a WhatsApp limit'}
      {unmeasured > 0 && <span className="spec-unknown"> · {unmeasured} unmeasured</span>}
    </div>
  )
}
