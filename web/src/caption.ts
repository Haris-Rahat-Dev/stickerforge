// The caption is drawn here once, onto a transparent 512×512 canvas the size of the
// sticker. The editor shows that bitmap over the preview and the server lays the same
// PNG over every frame, so preview and encode cannot disagree about font or wrapping.

export type CaptionPos = 'top' | 'bottom'

export interface CaptionArt {
  text: string
  pos: CaptionPos
  /** PNG, base64 without the data: prefix — what the server stores. */
  png: string
  /** The same PNG as a data URL, for the preview <img>. */
  url: string
}

const SIZE = 512
/** WhatsApp's white border insets content to 460px: keep text inside it. */
const BORDER_PAD = 26
const MAX_FONT = 68
const MIN_FONT = 22
const FONT = (px: number): string => `${px}px Anton, Impact, 'Arial Narrow', sans-serif`

/** Greedy word wrap into at most two lines. Null when it can't fit at this size. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width <= width) { line = next; continue }
    if (!line || lines.length === 1) return null
    lines.push(line)
    line = w
    if (ctx.measureText(line).width > width) return null
  }
  lines.push(line)
  return lines.length <= 2 ? lines : null
}

export async function renderCaption(text: string, pos: CaptionPos, border: boolean): Promise<CaptionArt | null> {
  const clean = text.trim().toUpperCase()
  if (!clean) return null
  // Draw only once the display font is in: a fallback face would ship in the sticker.
  await document.fonts.load(FONT(MAX_FONT)).catch(() => {})
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const inset = border ? BORDER_PAD : 0
  const width = (SIZE - inset * 2) * 0.92

  let px = MAX_FONT
  let lines: string[] | null = null
  for (; px >= MIN_FONT; px -= 2) {
    ctx.font = FONT(px)
    lines = wrap(ctx, clean, width)
    if (lines) break
  }
  if (!lines) { px = MIN_FONT; ctx.font = FONT(px); lines = [clean] }

  const lineH = px * 1.08
  const margin = inset + px * 0.3
  const firstY = pos === 'top' ? margin + px * 0.92 : SIZE - margin - lineH * (lines.length - 1) - px * 0.08
  ctx.textAlign = 'center'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, px * 0.14)
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#fff'
  lines.forEach((l, i) => {
    const y = firstY + i * lineH
    ctx.strokeText(l, SIZE / 2, y, width)
    ctx.fillText(l, SIZE / 2, y, width)
  })
  const url = canvas.toDataURL('image/png')
  return { text: clean, pos, png: url.slice(url.indexOf(',') + 1), url }
}
