import { useLayoutEffect, useRef, type RefObject } from 'react'

const FLIP_MS = 180
const FLIP_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const tilesOf = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'))

const animationNameOf = (a: Animation): string => (a as CSSAnimation).animationName ?? ''

/** The die-cut entrance owns this tile's transform until it is done. */
const isEntering = (el: HTMLElement): boolean =>
  el.getAnimations().some(a =>
    animationNameOf(a) === 'sf-diecut' && a.playState !== 'finished' && a.playState !== 'idle')

/**
 * Reordering moves the keyed nodes, which restarts their CSS animation and replays
 * the die-cut wipe on top of the slide.
 */
const cancelEntrance = (el: HTMLElement): void => {
  for (const a of el.getAnimations()) if (animationNameOf(a) === 'sf-diecut') a.cancel()
}

/**
 * FLIP for a keyed grid whose order changes asynchronously: capture runs while the
 * old order is on screen, and the animation plays from the layout effect once the
 * new order has committed — a server round trip later.
 *
 * A view transition cannot be used here: it captures the "after" state as soon as its
 * update callback settles, but the reordered DOM only exists after that round trip,
 * which routinely outlasts any sane hold. It would cross-fade identical content and
 * then apply the real change unanimated.
 */
export function useReorderFlip(container: RefObject<HTMLElement | null>, order: string): () => void {
  const first = useRef<Map<string, DOMRect> | null>(null)
  const running = useRef<Animation[]>([])

  useLayoutEffect(() => {
    const rects = first.current
    first.current = null
    const root = container.current
    if (!rects || !root) return

    const tiles = tilesOf(root).filter(el => rects.has(el.dataset.flipKey ?? ''))
    tiles.forEach(cancelEntrance)
    running.current.forEach(a => a.cancel())
    running.current = []

    for (const el of tiles) {
      const from = rects.get(el.dataset.flipKey ?? '')
      if (!from) continue
      const to = el.getBoundingClientRect()
      const dx = from.left - to.left
      const dy = from.top - to.top
      if (dx === 0 && dy === 0) continue
      running.current.push(el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: FLIP_MS, easing: FLIP_EASE },
      ))
    }
  }, [order, container])

  return () => {
    first.current = null
    const root = container.current
    if (!root || reducedMotion()) return
    const settled = tilesOf(root).filter(el => !isEntering(el))
    if (settled.length < 2) return
    first.current = new Map(settled.map(el => [el.dataset.flipKey ?? '', el.getBoundingClientRect()]))
  }
}
