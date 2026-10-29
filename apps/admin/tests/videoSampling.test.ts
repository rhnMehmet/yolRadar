import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsPTS, captureSample, containRect, encodeFrame, frameSize, markerPercent, validateFile, validateMetadata, VIDEO_LIMITS } from '../src/features/video-analysis/videoSampling.ts'

const info = { name: 'synthetic.mp4', bytes: 100, durationMs: 3000, width: 1920, height: 1080 }
test('MP4 and MOV are candidates, not codec guarantees; wrong type/extension/size rejected', () => {
  for (const [name, type] of [['synthetic.mp4', 'video/mp4'], ['synthetic.MOV', 'video/quicktime']]) assert.doesNotThrow(() => validateFile({ name, type, size: 1 }))
  for (const value of [{ name: 'bad.exe', type: 'video/mp4', size: 1 }, { name: 'bad.mp4', type: 'text/plain', size: 1 },
    { name: 'empty.mp4', type: '', size: 0 }, { name: 'large.mp4', type: '', size: VIDEO_LIMITS.maxBytes + 1 }]) assert.throws(() => validateFile(value))
})
for (const patch of [{ durationMs: Infinity }, { durationMs: NaN }, { durationMs: 0 }, { durationMs: 600001 }, { width: 0 }, { width: 1.5 }, { width: 100000 }]) test(`invalid metadata ${JSON.stringify(patch)}`, () => assert.throws(() => validateMetadata({ ...info, ...patch })))
test('valid metadata and central inclusive limits', () => { validateMetadata(info); validateMetadata({ ...info, durationMs: 600000 }); validateFile({ name: info.name, type: '', size: VIDEO_LIMITS.maxBytes }) })
test('actual fractional PTS and v2 tolerance remain distinct from slot', () => {
  for (const pts of [1000, 1001, 1001.001001001001, 1100]) assert.equal(acceptsPTS(pts, 1000, 4000), true)
  for (const pts of [999.999, 1100.001, Infinity, NaN]) assert.equal(acceptsPTS(pts, 1000, 4000), false)
  assert.equal(acceptsPTS(1000, 1000, 1000), false)
  assert.equal(acceptsPTS(1001, 1000.1, 4000), false)
})
test('resize preserves aspect with bounded pixels; contain has correct letterbox offsets', () => {
  assert.deepEqual(frameSize(1920, 1080), { width: 1280, height: 720 })
  assert.deepEqual(frameSize(1080, 1920), { width: 720, height: 1280 })
  assert.deepEqual(containRect(400, 400, 1920, 1080), { x: 0, y: 87.5, width: 400, height: 225 })
  assert.deepEqual(containRect(400, 400, 1080, 1920), { x: 87.5, y: 0, width: 225, height: 400 })
})
test('timeline positioning uses actual PTS and rejects invalid bounds', () => {
  assert.equal(markerPercent(1001, 4000), 25.025)
  for (const time of [-1, 4000, NaN]) assert.throws(() => markerPercent(time, 4000))
})
function fakeVideo() {
  let sequence = 0
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  const video = Object.assign(new EventTarget(), { paused: true, videoWidth: 1920, videoHeight: 1080,
    play: async () => { video.paused = false }, requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => { callbacks.set(++sequence, cb); return sequence },
    cancelVideoFrameCallback: (id: number) => callbacks.delete(id),
    fire: (pts: number) => { const [id, cb] = [...callbacks][0]; callbacks.delete(id); cb(5, { mediaTime: pts / 1000 } as VideoFrameCallbackMetadata) }, callbacks })
  return video
}
test('rVFC copies synchronously with mediaTime; early frame waits, fractional PTS is not rounded', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document'); let draws = 0
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({ drawImage: () => draws++ }) }) } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document') })
  const video = fakeVideo(), signal = new AbortController().signal
  const result = captureSample(video as unknown as HTMLVideoElement, 1000, 4000, signal)
  video.fire(999); assert.equal(draws, 0)
  video.fire(1001.001001001001); assert.equal(draws, 1)
  const frame = await result
  assert.equal(frame!.actualMs, (1001.001001001001 / 1000) * 1000); assert.notEqual(frame!.actualMs, 1000); assert.equal(frame!.plannedMs, 1000); assert.equal(video.callbacks.size, 0)
})
test('out-of-window frame leaves a gap rather than faking metadata', async () => {
  const video = fakeVideo(), result = captureSample(video as unknown as HTMLVideoElement, 1000, 4000, new AbortController().signal)
  video.fire(1101); assert.equal(await result, null)
})
test('abort and video end remove pending callbacks', async () => {
  const video = fakeVideo(), abort = new AbortController()
  const result = captureSample(video as unknown as HTMLVideoElement, 1000, 4000, abort.signal)
  abort.abort(); await assert.rejects(result, { name: 'AbortError' }); assert.equal(video.callbacks.size, 0)
  const ended = captureSample(video as unknown as HTMLVideoElement, 1000, 4000, new AbortController().signal)
  video.dispatchEvent(new Event('ended')); assert.equal(await ended, null); assert.equal(video.callbacks.size, 0)
})
test('unsupported rVFC is explicit; JPEG encoding enforces 4 MiB and abort', async () => {
  await assert.rejects(captureSample({} as HTMLVideoElement, 0, 4000, new AbortController().signal), /desteklemiyor/)
  const sample = { actualMs: 1, plannedMs: 0, width: 1, height: 1, canvas: { toBlob: (cb: BlobCallback) => cb(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/jpeg' })) } as HTMLCanvasElement }
  await assert.rejects(encodeFrame(sample, new AbortController().signal), /4 MiB/)
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(encodeFrame(sample, aborted.signal), { name: 'AbortError' })
})
