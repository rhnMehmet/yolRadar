import assert from 'node:assert/strict'
import test from 'node:test'
import { VideoAnalysisController } from '../src/features/video-analysis/videoAnalysisController.ts'
import type { ControllerDeps } from '../src/features/video-analysis/videoAnalysisController.ts'
import type { VideoApi } from '../src/features/video-analysis/videoApi.ts'
import type { Capture } from '../src/features/video-analysis/videoSampling.ts'
import { calculateAnalysisCoverage } from '../../../packages/shared/src/index.ts'
import { scope, video } from '../../../packages/shared/tests/m1Fixtures.ts'
import type { FrameAnalysisOutcome, VideoAnalysisSummary } from '../../../packages/shared/src/index.ts'

const info = { name: 'synthetic.mp4', bytes: 100, durationMs: 2100, width: 640, height: 360 }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(patches: Partial<ControllerDeps> = {}) {
  let createCalls = 0, cancels = 0, serial = 0
  const outcomes: FrameAnalysisOutcome[] = [], revoked: string[] = []
  const s = { ...video(), contractVersion: 2 as const, videoDurationMs: info.durationMs }
  let terminal: 'running' | 'completed' | 'partial' | 'cancelled' = 'running'
  const makeSummary = () => ({ ...scope(s), ...s.detector, videoId: s.videoId, resultLabel: 'TEST_SYNTHETIC', analysisStatus: terminal,
    coverage: calculateAnalysisCoverage(s, outcomes), totalEvents: 0, rawObservationCount: 0,
    events: [], classCounts: { pothole: 0, longitudinal_crack: 0, transverse_crack: 0, alligator_crack: 0, other: 0, unknown: 0 },
    firstDamageTimestampMs: null, lastDamageTimestampMs: null, deduplication: 'EXPLICIT_OBSERVATION_GROUPS' }) as VideoAnalysisSummary
  const api: VideoApi = { create: async () => { createCalls++; return s }, analyze: async (_s, frame) => { outcomes.push({ ...scope(s), videoId: s.videoId,
    frameId: frame.frameId, videoTimestampMs: frame.capturedAt.valueMs, plannedSampleTimestampMs: frame.plannedSampleTimestampMs, status: 'analyzed' }); return [] },
    summary: async () => makeSummary(), complete: async (_s, status) => { terminal = status }, cancel: async () => { cancels++; terminal = 'cancelled' } }
  const node = { currentTime: 0, paused: true, pause() { this.paused = true }, async play() { this.paused = false } } as HTMLVideoElement
  const capture = (_v: HTMLVideoElement, p: number) => Promise.resolve({ canvas: {} as HTMLCanvasElement, plannedMs: p, actualMs: p + 1, width: 640, height: 360 })
  const controller = new VideoAnalysisController({ api: () => api, capture, encode: async () => new Blob(['synthetic'], { type: 'image/jpeg' }),
    createUrl: () => 'blob:synthetic-' + ++serial, revokeUrl: u => revoked.push(u), ...patches })
  return { controller, node, api, revoked, outcomes, calls: () => ({ createCalls, cancels }) }
}
test('single serial operation, exact PTS, plan completion and URL cleanup', async () => {
  const x = setup(); const a = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); const b = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral')
  await Promise.all([a, b]); assert.equal(x.calls().createCalls, 1); assert.deepEqual(x.outcomes.map(o => [o.plannedSampleTimestampMs, o.videoTimestampMs]), [[0, 1], [1000, 1001], [2000, 2001]])
  assert.equal(x.controller.getSnapshot().phase, 'completed'); assert.equal(x.controller.getSnapshot().summary!.coverage.analyzedFrames, 3)
  assert.equal(x.revoked.length, 2); x.controller.dispose(); assert.equal(x.revoked.length, 3)
})
test('missing decoded sample is unanalysed gap and partial, never a fake skipped frame', async () => {
  const x = setup({ capture: async (_v, p) => p === 1000 ? null : { canvas: {} as HTMLCanvasElement, plannedMs: p, actualMs: p + 1, width: 1, height: 1 } })
  await x.controller.start(x.node, info, 'synthetic-video', 'ephemeral')
  assert.equal(x.controller.getSnapshot().phase, 'partial'); assert.equal(x.controller.getSnapshot().gaps, 1)
  assert.deepEqual(x.controller.getSnapshot().summary!.coverage.unanalysedRanges, [{ startMs: 1000, endMs: 2000 }]); assert.equal(x.outcomes.length, 2)
})
for (const reason of ['user', 'seek', 'replace', 'unmount']) test(`${reason}: late capture cannot upload or publish old frame`, async () => {
  const d = deferred<Capture | null>(), x = setup({ capture: () => d.promise })
  const run = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); await tick()
  if (reason === 'unmount') x.controller.dispose(); else if (reason === 'replace') x.controller.reset(); else x.controller.cancel(reason)
  d.resolve({ canvas: {} as HTMLCanvasElement, plannedMs: 0, actualMs: 1, width: 1, height: 1 }); await run
  assert.equal(x.outcomes.length, 0); assert.equal(x.calls().cancels, 1); assert.equal(x.controller.getSnapshot().frozen, null)
  if (reason !== 'user') assert.equal(x.controller.getSnapshot().summary, null)
})
test('late server create is compensated with cancel; new generation does not show old session', async () => {
  const x = setup(), d = deferred<Awaited<ReturnType<VideoApi['create']>>>()
  x.api.create = () => d.promise
  const run = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); x.controller.reset()
  d.resolve({ ...video(), contractVersion: 2 }); await run
  assert.equal(x.calls().cancels, 1); assert.equal(x.controller.getSnapshot().session, null)
})
test('pause does not cancel server; resume releases next sample', async () => {
  const x = setup(), d = deferred<void>(); const original = x.api.analyze
  x.api.analyze = async (...args) => { await d.promise; return original(...args) }
  const run = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); await tick(); x.controller.pause(); d.resolve(); await tick()
  assert.equal(x.outcomes.length, 1); assert.equal(x.controller.getSnapshot().paused, true); assert.equal(x.calls().cancels, 0)
  await x.controller.play(); await run; assert.equal(x.controller.getSnapshot().phase, 'completed')
})
test('completed report marker seek is actual time and does not start new analysis', async () => {
  const x = setup(); await x.controller.start(x.node, info, 'synthetic-video', 'ephemeral')
  const report = x.controller.getSnapshot().summary
  x.controller.seek(1.001, x.node, info.durationMs)
  assert.equal(x.node.currentTime, 1.001); assert.equal(x.calls().createCalls, 1); assert.equal(x.controller.getSnapshot().summary, report); assert.equal(x.controller.getSnapshot().frozen, null)
})
test('seek during active run cancels it and clears overlay/results', async () => {
  const x = setup(), d = deferred<Capture | null>(); const y = setup({ capture: () => d.promise })
  const run = y.controller.start(y.node, info, 'synthetic-video', 'ephemeral'); await tick(); y.controller.seek(1, y.node, info.durationMs)
  d.resolve(null); await run; assert.equal(y.node.currentTime, 1); assert.equal(y.controller.getSnapshot().summary, null); assert.equal(x.calls().createCalls, 0)
})
test('bad PTS and API failure do not report completed', async () => {
  const x = setup({ capture: async () => ({ canvas: {} as HTMLCanvasElement, plannedMs: 0, actualMs: 101, width: 1, height: 1 }) })
  await x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); assert.equal(x.outcomes.length, 0); assert.equal(x.controller.getSnapshot().phase, 'failed')
  const y = setup(); y.api.analyze = async () => { throw new Error('Synthetic API failure') }
  await y.controller.start(y.node, info, 'synthetic-video', 'ephemeral'); assert.equal(y.controller.getSnapshot().phase, 'failed'); assert.equal(y.calls().cancels, 1)
})
test('StrictMode cleanup/setup invalidates old generation and allows clean run', async () => {
  const x = setup(); x.controller.dispose(); x.controller.activate(); await x.controller.start(x.node, info, 'synthetic-video', 'ephemeral')
  assert.equal(x.controller.getSnapshot().phase, 'completed'); assert.equal(x.calls().createCalls, 1)
})
test('late upload/job response after cancellation never restores its overlay', async () => {
  const x = setup(), response = deferred<Awaited<ReturnType<VideoApi['analyze']>>>()
  x.api.analyze = () => response.promise
  const run = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); await tick()
  assert.ok(x.controller.getSnapshot().frozen)
  x.controller.cancel(); response.resolve([]); await run
  assert.equal(x.controller.getSnapshot().frozen, null); assert.equal(x.controller.getSnapshot().phase, 'cancelled'); assert.equal(x.calls().cancels, 1)
})
test('unmount during encode prevents subsequent upload and object URL allocation', async () => {
  const encoded = deferred<Blob>(), x = setup({ encode: () => encoded.promise })
  const run = x.controller.start(x.node, info, 'synthetic-video', 'ephemeral'); await tick(); x.controller.dispose()
  encoded.resolve(new Blob(['synthetic'])); await run
  assert.equal(x.outcomes.length, 0); assert.equal(x.controller.getSnapshot().frozen, null); assert.equal(x.revoked.length, 0); assert.equal(x.controller.getSnapshot().busy, false)
})
test('failed request clears pending preview and preserves root error if cancellation also fails', async () => {
  const x = setup(); x.api.analyze = async () => { throw new Error('API identity failure') }; x.api.cancel = async () => { throw new Error('offline') }
  await x.controller.start(x.node, info, 'synthetic-video', 'ephemeral')
  assert.equal(x.controller.getSnapshot().phase, 'failed'); assert.equal(x.controller.getSnapshot().frozen, null)
  assert.match(x.controller.getSnapshot().message, /API identity failure/); assert.match(x.controller.getSnapshot().message, /iptali\/özeti doğrulanamadı/)
})
