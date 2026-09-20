import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe, publish, listenerCount, type JobEvent } from '../src/jobfeed.ts'

const ev = (over: Partial<JobEvent> = {}): JobEvent =>
  ({ jobId: 'j1', status: 'running', progress: 0.5, stage: 'pass 1', ...over })

test('a subscriber receives events for its job', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  publish(ev())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].progress, 0.5)
  off()
})

test('a subscriber never receives another job’s events', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  publish(ev({ jobId: 'j2' }))
  assert.equal(seen.length, 0)
  off()
})

test('unsubscribing stops delivery and releases the slot', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  assert.equal(listenerCount('j1'), 1)
  off()
  assert.equal(listenerCount('j1'), 0)
  publish(ev())
  assert.equal(seen.length, 0)
})

test('several subscribers on one job all receive it', () => {
  let a = 0, b = 0
  const offA = subscribe('j1', () => a++)
  const offB = subscribe('j1', () => b++)
  publish(ev())
  assert.equal(a, 1)
  assert.equal(b, 1)
  offA()
  offB()
})

test('publishing with no listeners is harmless', () => {
  assert.doesNotThrow(() => publish(ev({ jobId: 'nobody' })))
  assert.equal(listenerCount('nobody'), 0)
})

test('a throwing subscriber does not block the others', () => {
  let reached = 0
  const offA = subscribe('j1', () => { throw new Error('boom') })
  const offB = subscribe('j1', () => { reached++ })
  publish(ev())
  assert.equal(reached, 1, 'the second subscriber must still run')
  offA()
  offB()
})
