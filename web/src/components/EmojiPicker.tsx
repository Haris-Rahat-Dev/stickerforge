import { useState } from 'react'

const PALETTE = ['😂', '🔥', '💀', '🤣', '👀', '😭', '🫡', '❤️', '👍', '🤔', '🙃', '😎', '🥲', '😡', '🙏', '🎉', '😴', '🤡']
const MAX = 3
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

/** Split typed text into emoji graphemes, dropping anything that isn't one. */
function emojisIn(text: string): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return [...seg.segment(text)].map(s => s.segment).filter(g => EMOJI.test(g))
}

/**
 * Up to three emojis per sticker — WhatsApp's limit, and what its keyboard searches
 * stickers by. Tap to toggle; type or paste anything else.
 */
export default function EmojiPicker({ value, onChange }: { value: string[]; onChange: (emojis: string[]) => void }) {
  const [typed, setTyped] = useState('')
  const toggle = (e: string): void => {
    if (value.includes(e)) onChange(value.filter(x => x !== e))
    else if (value.length < MAX) onChange([...value, e])
  }
  const options = [...new Set([...value, ...PALETTE])]
  return (
    <div className="emoji-field">
      <div className="emoji-picker">
        {options.map(e => (
          <button
            key={e}
            type="button"
            className="emoji-opt"
            aria-pressed={value.includes(e)}
            aria-current={value.includes(e) ? 'true' : undefined}
            disabled={!value.includes(e) && value.length >= MAX}
            onClick={() => toggle(e)}
          >{e}</button>
        ))}
        <input
          className="emoji-typed"
          aria-label="Type or paste an emoji"
          placeholder="＋"
          value={typed}
          disabled={value.length >= MAX}
          onChange={ev => {
            const found = emojisIn(ev.target.value).filter(e => !value.includes(e))
            if (found.length) { onChange([...value, ...found].slice(0, MAX)); setTyped('') }
            else setTyped(ev.target.value.slice(-8))
          }}
        />
      </div>
      <span className="emoji-count">{value.length}/{MAX} · WhatsApp searches stickers by these</span>
    </div>
  )
}
