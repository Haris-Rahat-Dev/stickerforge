import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displaySize, displayRotation, frameRate, modalCrop } from '../src/probe.ts'

// Shape captured verbatim from a real Redmi camera clip: coded 1920×1080 with a
// -90° display matrix, so every player and every decoded frame is 1080×1920.
const PORTRAIT_PHONE = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920, height: 1080,
  r_frame_rate: '90000/3751', avg_frame_rate: '90000/3751',
  side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
}

test('a -90 display matrix swaps dimensions to what the encoder sees', () => {
  assert.equal(displayRotation(PORTRAIT_PHONE), -90)
  assert.deepEqual(displaySize(PORTRAIT_PHONE), { width: 1080, height: 1920 })
})

test('90 and 270 swap; 0 and 180 do not', () => {
  const withRot = (rotation: number) => ({
    codec_type: 'video', width: 1920, height: 1080,
    side_data_list: [{ side_data_type: 'Display Matrix', rotation }],
  })
  assert.deepEqual(displaySize(withRot(90)), { width: 1080, height: 1920 })
  assert.deepEqual(displaySize(withRot(270)), { width: 1080, height: 1920 })
  assert.deepEqual(displaySize(withRot(0)), { width: 1920, height: 1080 })
  assert.deepEqual(displaySize(withRot(180)), { width: 1920, height: 1080 })
})

test('no side data means no rotation', () => {
  const s = { codec_type: 'video', width: 640, height: 360 }
  assert.equal(displayRotation(s), 0)
  assert.deepEqual(displaySize(s), { width: 640, height: 360 })
})

test('frame rate prefers the real average over the base timebase', () => {
  // Screen recordings and forwarded memes routinely report an absurd r_frame_rate
  // while avg_frame_rate holds the truth.
  assert.equal(frameRate({ codec_type: 'video', r_frame_rate: '1000/1', avg_frame_rate: '25/1' }), 25)
  assert.equal(frameRate(PORTRAIT_PHONE), 23.99)
  assert.equal(frameRate({ codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '30/1' }), 30)
  // Unknowable frame rate reports 0 and lets capFps decide, rather than inventing 30
  // here where assessQuality would read it as "choppy source" and warn the user.
  assert.equal(frameRate({ codec_type: 'video', avg_frame_rate: '0/0' }), 0)
  assert.equal(frameRate({ codec_type: 'video', avg_frame_rate: '2400/1' }), 0)
})

test('cropdetect takes the modal rect, not the final frame', () => {
  const stable = ['1080:1920:0:0', '1080:1920:0:0', '1080:1920:0:0', '1074:1912:3:4']
  assert.deepEqual(modalCrop(stable), { w: 1080, h: 1920, x: 0, y: 0 })

  // One black-frame scene change at the end used to set the crop for the whole clip.
  const flipFlop = ['1080:1920:0:0', '1080:1920:0:0', '1080:1920:0:0',
                    '1080:1600:0:160', '1080:1600:0:160']
  assert.deepEqual(modalCrop(flipFlop), { w: 1080, h: 1920, x: 0, y: 0 })
})

test('modalCrop rejects degenerate detections', () => {
  assert.equal(modalCrop([]), null)
  assert.equal(modalCrop(['8:8:0:0']), null)
  assert.deepEqual(modalCrop(['1080:1920:420:0']), { w: 1080, h: 1920, x: 420, y: 0 })
})
