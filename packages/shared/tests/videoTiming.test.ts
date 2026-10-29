import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { calculateAnalysisCoverage, createVideoTimelineEvent, isImageFrame, summarizeVideoAnalysis } from '../src/index.ts'
import type { FrameAnalysisOutcome } from '../src/index.ts'
import { classMap, frame, observation, scope, video } from './m1Fixtures.ts'

const cases = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m3a-video-timing.json', import.meta.url), 'utf8')).cases
for (const c of cases) test(`M3A parity: ${c.id}`, () => {
  const session = { ...video(), contractVersion: c.version ?? 2, samplingIntervalMs: c.interval ?? 1000, videoDurationMs: c.duration ?? 4000 }
  const outcomes = c.samples.map(([planned, actual, id]: [number, number, string]) => ({
    ...scope(session), runId: c.runId ?? session.runId, videoId: session.videoId, frameId: id,
    videoTimestampMs: actual, status: 'analyzed', ...(c.omitPlanned ? {} : { plannedSampleTimestampMs: planned }),
  })) as FrameAnalysisOutcome[]
  let accepted = true
  try {
    for (const outcome of outcomes) {
      const image = { ...frame(session, outcome.frameId, outcome.videoTimestampMs), runId: outcome.runId,
        ...(c.omitPlanned ? {} : { plannedSampleTimestampMs: outcome.plannedSampleTimestampMs }) }
      if (!isImageFrame(image, session)) throw new TypeError('Invalid frame')
    }
    const result = calculateAnalysisCoverage(session, outcomes)
    assert.equal(result.analyzedFrames, new Set(c.samples.map((s: unknown[]) => s[0])).size)
  } catch { accepted = false }
  assert.equal(accepted, c.valid)
})

test('M3A actual PTS drives event while planned slot drives coverage, regardless of playback', () => {
  const session = { ...video(), contractVersion: 2 as const }
  const image = { ...frame(session, 'frame-1', 1001.001001001001), plannedSampleTimestampMs: 1000 }
  const obs = observation(session, image)
  const evidence = { frames: [image], observations: [obs], classMap }
  const event = createVideoTimelineEvent(session, 'event-1', [obs.observationId], evidence)
  const outcome: FrameAnalysisOutcome = { ...scope(session), videoId: session.videoId, frameId: image.frameId,
    plannedSampleTimestampMs: 1000, videoTimestampMs: image.capturedAt.valueMs, status: 'analyzed' }
  const summary = summarizeVideoAnalysis(session, [event], evidence, [outcome, { ...outcome }])
  assert.equal(summary.firstDamageTimestampMs, image.capturedAt.valueMs)
  assert.equal(summary.coverage.analyzedFrames, 1)
  assert.deepEqual(summary.coverage.coveredRanges, [{ startMs: 1000, endMs: 2000 }])
  assert.equal(summary.coverage.status, 'partial')
  assert.throws(() => summarizeVideoAnalysis(session, [event], evidence, [{ ...outcome, plannedSampleTimestampMs: 0 }]))
  assert.throws(() => calculateAnalysisCoverage(session, [outcome, { ...outcome, status: 'failed' }]))
  assert.throws(() => summarizeVideoAnalysis({ ...session, runId: 'seek-new-run' }, [event], evidence, [outcome]))
})
