import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptVideoTimelineEvent, calculateAnalysisCoverage, createVideoTimelineEvent,
  isVideoTimelineEvent, summarizeVideoAnalysis,
} from '../src/index.ts'
import { evidence, observation, outcomes, video } from './m1Fixtures.ts'

test('M1 video: observations across frames form one marker with source video time, max score and references', () => {
  const session = video()
  const source = evidence(session)
  source.observations = source.observations.map((obs, i) => ({ ...obs, confidence: 0.5 + i * 0.1 }))
  const event = createVideoTimelineEvent(session, 'event-0', ['observation-1', 'observation-0'], source)
  assert.equal(event.videoTimestampMs, 0)
  assert.equal(event.lastVideoTimestampMs, 1_000)
  assert.equal(event.confidence, 0.6)
  assert.deepEqual(event.observationIds, ['observation-0', 'observation-1'])
  assert.equal(isVideoTimelineEvent({ ...event, videoTimestampMs: 1_799_999_999_999 }, session, source), false)
})

test('M1 video: separate hazards, including same-class boxes in one frame, stay separate', () => {
  const session = video()
  const source = evidence(session)
  source.observations = [...source.observations, observation(session, source.frames[0], 'second-pothole')]
  assert.throws(() => createVideoTimelineEvent(session, 'merged', ['observation-0', 'second-pothole'], source), /Ambiguous/)
  const a = createVideoTimelineEvent(session, 'hazard-a', ['observation-0', 'observation-1'], source)
  const b = createVideoTimelineEvent(session, 'hazard-b', ['second-pothole'], source)
  assert.equal(acceptVideoTimelineEvent(b, session, source, [a]).status, 'accepted')
  const summary = summarizeVideoAnalysis(session, [b, a], source, outcomes(session))
  assert.equal(summary.totalEvents, 2)
  assert.equal(summary.classCounts.pothole, 2)
  assert.equal(summary.rawObservationCount, 4)
})

test('M1 video: different classes cannot silently merge into one physical event', () => {
  const session = video()
  const source = evidence(session)
  source.observations = source.observations.map((obs, i) => i === 2
    ? { ...obs, rawClassId: 'raw-B', canonicalClass: 'longitudinal_crack' } : obs)
  assert.throws(() => createVideoTimelineEvent(session, 'bad-group', ['observation-0', 'observation-2'], source), /Ambiguous/)
  const events = [createVideoTimelineEvent(session, 'pothole', ['observation-0', 'observation-1'], source),
    createVideoTimelineEvent(session, 'crack', ['observation-2'], source)]
  const summary = summarizeVideoAnalysis(session, events, source, outcomes(session))
  assert.equal(summary.totalEvents, 2)
  assert.equal(summary.classCounts.pothole, 1)
  assert.equal(summary.classCounts.longitudinal_crack, 1)
  assert.equal(summary.firstDamageTimestampMs, 0)
  assert.equal(summary.lastDamageTimestampMs, 2_000)
})

test('M1 video: duplicate event is idempotent, conflicting ID and reused observations are rejected', () => {
  const session = video()
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event-0', ['observation-0'], source)
  assert.equal(acceptVideoTimelineEvent(event, session, source, []).status, 'accepted')
  assert.equal(acceptVideoTimelineEvent(event, session, source, [event]).status, 'duplicate')
  const conflicting = createVideoTimelineEvent(session, 'event-0', ['observation-1'], source)
  assert.deepEqual(acceptVideoTimelineEvent(conflicting, session, source, [event]), { status: 'rejected', reason: 'event_id_conflict' })
  const overlapping = createVideoTimelineEvent(session, 'event-1', ['observation-0', 'observation-1'], source)
  assert.deepEqual(acceptVideoTimelineEvent(overlapping, session, source, [event]), { status: 'rejected', reason: 'observation_already_grouped' })
})

test('M1 video: wrong video, run, session, domain, detector, model and class map cannot create markers', () => {
  const session = video()
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event-0', ['observation-0'], source)
  for (const patch of [{ videoId: 'other' }, { runId: 'old' }, { sessionId: 'other' }, { sourceDomain: 'REAL' },
    { detectorKind: 'YOLO' }, { modelVersion: 'other' }, { classMapVersion: 'other' }, { confidence: NaN },
    { videoTimestampMs: Infinity }, { lastVideoTimestampMs: -1 }]) {
    assert.equal(acceptVideoTimelineEvent({ ...event, ...patch }, session, source, []).status, 'rejected')
  }
})

test('M1 video: seek, restart and video replacement rotate run identity and reject late results', () => {
  const session = video()
  const source = evidence(session)
  const old = createVideoTimelineEvent(session, 'old-event', ['observation-0'], source)
  for (const next of [{ ...session, runId: 'seek-run' }, { ...session, runId: 'restart-run' },
    { ...session, videoId: 'replacement-video', runId: 'replacement-run' }]) {
    assert.equal(acceptVideoTimelineEvent(old, next, evidence(next), []).status, 'rejected')
    assert.throws(() => summarizeVideoAnalysis(next, [old], evidence(next), outcomes(next)))
  }
})

test('M1 video: cancelled and terminal sessions never admit asynchronous events', () => {
  const session = video()
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event-0', ['observation-0'], source)
  for (const terminal of [{ ...session, status: 'cancelled' as const, analysisStatus: 'cancelled' as const },
    { ...session, status: 'completed' as const, analysisStatus: 'partial' as const }]) {
    assert.equal(acceptVideoTimelineEvent(event, terminal, source, []).status, 'rejected')
  }
})

test('M1 video: forged clock or frame evidence is rejected before timeline grouping', () => {
  const session = video()
  const source = evidence(session)
  for (const patch of [{ clockId: 'wrong-clock' }, { clockDomain: 'SIMULATION' }, { videoId: 'other' }, { valueMs: 3_999 }]) {
    const malformed = { ...source, observations: [{ ...source.observations[0], capturedAt: { ...source.observations[0].capturedAt, ...patch } }] }
    assert.throws(() => createVideoTimelineEvent(session, 'event', ['observation-0'], malformed as typeof source))
  }
  assert.throws(() => createVideoTimelineEvent(session, 'event', ['missing'], source))
  assert.throws(() => createVideoTimelineEvent(session, 'event', ['observation-0'], { ...source, frames: [...source.frames, source.frames[0]] }))
})

test('M1 video: sampling coverage keeps skipped, failed and unattempted gaps visible', () => {
  const session = video()
  const attempted = outcomes(session).slice(0, 3)
  attempted[1].status = 'skipped'
  attempted[2].status = 'failed'
  const coverage = calculateAnalysisCoverage(session, attempted)
  assert.equal(coverage.status, 'partial')
  assert.equal(coverage.basis, 'DECLARED_SAMPLING_GRID')
  assert.deepEqual([coverage.analyzedFrames, coverage.skippedFrames, coverage.failedFrames], [1, 1, 1])
  assert.deepEqual(coverage.coveredRanges, [{ startMs: 0, endMs: 1_000 }])
  assert.deepEqual(coverage.unanalysedRanges, [{ startMs: 1_000, endMs: 4_000 }])
  assert.equal(calculateAnalysisCoverage(session, []).status, 'none')
  assert.equal(calculateAnalysisCoverage(session, [outcomes(session)[3]]).status, 'partial')
})

test('M1 video: coverage is independent of playback and never fills skipped-ahead ranges', () => {
  const session = video()
  const coverage = calculateAnalysisCoverage(session, [outcomes(session)[0], outcomes(session)[3]])
  assert.deepEqual(coverage.coveredRanges, [{ startMs: 0, endMs: 1_000 }, { startMs: 3_000, endMs: 4_000 }])
  assert.deepEqual(coverage.unanalysedRanges, [{ startMs: 1_000, endMs: 3_000 }])
})

test('M1 video: duplicate outcomes do not inflate counts; conflicts, old runs and off-grid times fail', () => {
  const session = video()
  const first = outcomes(session)[0]
  assert.equal(calculateAnalysisCoverage(session, [first, first]).analyzedFrames, 1)
  for (const invalid of [{ ...first, runId: 'old' }, { ...first, videoTimestampMs: NaN },
    { ...first, videoTimestampMs: 4_000 }, { ...first, videoTimestampMs: 500 }]) {
    assert.throws(() => calculateAnalysisCoverage(session, [invalid]))
  }
  assert.throws(() => calculateAnalysisCoverage(session, [first, { ...first, status: 'failed' }]))
  assert.throws(() => calculateAnalysisCoverage(session, [first, { ...first, videoTimestampMs: 1_000 }]))
})

test('M1 video: completed requires all sampling slots, and partial / cancelled / failed summaries preserve status', () => {
  const session = video()
  const source = evidence(session)
  const complete = { ...session, status: 'completed' as const, analysisStatus: 'completed' as const }
  assert.throws(() => summarizeVideoAnalysis(complete, [], source, outcomes(session).slice(0, 2)), /Incomplete/)
  const summary = summarizeVideoAnalysis(complete, [], { ...source, observations: [] }, outcomes(session))
  assert.equal(summary.coverage.status, 'complete')
  assert.equal(summary.totalEvents, 0)
  assert.equal(summary.firstDamageTimestampMs, null)
  assert.equal(summary.lastDamageTimestampMs, null)
  for (const terminal of [{ ...session, status: 'completed' as const, analysisStatus: 'partial' as const },
    { ...session, status: 'completed' as const, analysisStatus: 'failed' as const },
    { ...session, status: 'cancelled' as const, analysisStatus: 'cancelled' as const }]) {
    assert.equal(summarizeVideoAnalysis(terminal, [], source, outcomes(session).slice(0, 1)).analysisStatus, terminal.analysisStatus)
  }
})

test('M1 video: summary derives only admitted events, excludes rejected review and distinguishes raw box counts', () => {
  const session = video()
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event-0', ['observation-0', 'observation-1'], source)
  const rejected = { ...createVideoTimelineEvent(session, 'event-1', ['observation-2'], source), reviewStatus: 'rejected' as const }
  const summary = summarizeVideoAnalysis(session, [event, rejected], source, outcomes(session))
  assert.equal(summary.totalEvents, 1)
  assert.equal(summary.rawObservationCount, 3)
  assert.equal(summary.classCounts.pothole, 1)
  assert.equal(summary.events.length, summary.totalEvents)
  assert.equal(summary.deduplication, 'EXPLICIT_OBSERVATION_GROUPS')
  assert.equal(summary.resultLabel, 'TEST_SYNTHETIC')
  assert.throws(() => summarizeVideoAnalysis(session, [event, event], source, outcomes(session)))
  assert.throws(() => summarizeVideoAnalysis(session, [event], source, outcomes(session).slice(2)))
})

test('M1 video: replay with current YOLO stays REPLAY / YOLO, never TEST by source inference', () => {
  const session = video()
  session.detector.detectorKind = 'YOLO'
  session.detector.modelVersion = 'synthetic-yolo-identity-only'
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event', ['observation-0'], source)
  const summary = summarizeVideoAnalysis(session, [event], source, outcomes(session))
  assert.equal(summary.sourceDomain, 'REPLAY')
  assert.equal(summary.detectorKind, 'YOLO')
  assert.equal(summary.resultLabel, 'YOLO_RESULT')
  // This tests identity handling only; no YOLO implementation or inference exists in M1.
})

test('M1 video: unknown class maps remain unknown in event and summary, with no invented class', () => {
  const session = video()
  const source = evidence(session)
  source.classMap = { ...source.classMap, approved: false }
  source.observations = source.observations.map(obs => ({ ...obs, canonicalClass: 'unknown' }))
  const event = createVideoTimelineEvent(session, 'unknown', ['observation-0'], source)
  const summary = summarizeVideoAnalysis(session, [event], source, outcomes(session))
  assert.equal(summary.classCounts.unknown, 1)
  assert.equal(summary.classCounts.pothole, 0)
})

test('M1 video: summary and coverage are deterministic and do not mutate caller data', () => {
  const session = video()
  const source = evidence(session)
  const event = createVideoTimelineEvent(session, 'event', ['observation-1', 'observation-0'], source)
  const input = JSON.stringify({ session, source, event })
  const a = summarizeVideoAnalysis(session, [event], source, outcomes(session))
  const b = summarizeVideoAnalysis(session, [event], source, [...outcomes(session)].reverse())
  assert.deepEqual(a, b)
  assert.notEqual(a.events[0], event)
  assert.equal(JSON.stringify({ session, source, event }), input)
})
