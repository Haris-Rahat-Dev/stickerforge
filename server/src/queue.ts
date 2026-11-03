// Tiny in-process concurrency limiter — caps how many heavy encodes run at once
// so parallel img2webp encodes don't thrash the CPU (and starve each other).
// No Redis/BullMQ: this is a single-process local tool. Graduate to a real queue
// only when the API is hosted with multiple workers.
type Task<T> = () => Promise<T>

export function createLimiter(max: number) {
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => { active--; waiting.shift()?.() }

  return {
    get active() { return active },
    get queued() { return waiting.length },
    async run<T>(task: Task<T>): Promise<T> {
      if (active >= max) await new Promise<void>(resolve => waiting.push(resolve))
      active++
      try {
        return await task()
      } finally {
        release()
      }
    }
  }
}
