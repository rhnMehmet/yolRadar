import { DAMAGE_TYPES } from './types.ts'
import type {
  Acceptance,
} from './contractValidation.ts'
import {
  finite, identifier, isDetectionObservation, isImageFrame, isVideoAnalysisSession,
  record, resultLabel, sameDetector, sameScope, stringIds, validVideoSample,
} from './contractValidation.ts'
import type {
  AnalysisCoverage, CanonicalClass, ClassMap, CoverageRange, DetectionObservation,
  FrameAnalysisOutcome, ImageFrame, VideoAnalysisSession, VideoAnalysisSummary,
  VideoTimelineEvent,
} from './contracts.ts'

export interface VideoEvidence {
  frames: readonly ImageFrame[]
  observations: readonly DetectionObservation[]
  classMap: ClassMap
}

function requireSession(session: VideoAnalysisSession): void {
  if (!isVideoAnalysisSession(session)) throw new TypeError('Invalid video analysis session')
}

function evidenceIndex(session: VideoAnalysisSession, evidence: VideoEvidence): Map<string, DetectionObservation> {
  const frames = new Map<string, ImageFrame>()
  for (const frame of evidence.frames) {
    if (!isImageFrame(frame, session) || frames.has(frame.frameId)) throw new TypeError('Invalid or duplicate frame')
    frames.set(frame.frameId, frame)
  }
  const observations = new Map<string, DetectionObservation>()
  for (const observation of evidence.observations) {
    const frame = frames.get(observation.frameId)
    if (!frame || !isDetectionObservation(observation, session, frame, evidence.classMap)
      || observations.has(observation.observationId)) throw new TypeError('Invalid or duplicate observation')
    observations.set(observation.observationId, observation)
  }
  return observations
}

/**
 * An explicit group from a future tracker/reviewer, not a claim that time proximity
 * proves physical identity. Different boxes in the SAME frame cannot be one group.
 * All timestamps and scores are recomputed from validated source observations.
 */
export function createVideoTimelineEvent(
  session: VideoAnalysisSession, eventId: string, observationIds: readonly string[], evidence: VideoEvidence,
): VideoTimelineEvent {
  requireSession(session)
  if (!identifier(eventId) || !stringIds(observationIds)) throw new TypeError('Invalid event identity')
  const index = evidenceIndex(session, evidence)
  const observations = observationIds.map(id => {
    const observation = index.get(id)
    if (!observation) throw new TypeError('Missing event observation')
    return observation
  })
  const canonicalClass = observations[0].canonicalClass
  if (observations.some(item => item.canonicalClass !== canonicalClass)
    || new Set(observations.map(item => item.frameId)).size !== observations.length) {
    throw new TypeError('Ambiguous event group')
  }
  const times = observations.map(item => item.capturedAt.valueMs)
  return {
    contractVersion: session.contractVersion, sessionId: session.sessionId, runId: session.runId,
    sourceDomain: 'REPLAY', ...session.detector, videoId: session.videoId, eventId,
    videoTimestampMs: Math.min(...times), lastVideoTimestampMs: Math.max(...times),
    canonicalClass, confidence: Math.max(...observations.map(item => item.confidence)),
    observationIds: [...observationIds].sort(), reviewStatus: 'pending',
  }
}

export function isVideoTimelineEvent(
  value: unknown, session: VideoAnalysisSession, evidence: VideoEvidence,
): value is VideoTimelineEvent {
  if (!record(value) || !sameScope(value, session) || !sameDetector(value, session.detector)
    || value.videoId !== session.videoId || !identifier(value.eventId) || !stringIds(value.observationIds)
    || !['pending', 'approved', 'rejected'].includes(value.reviewStatus as string)) return false
  try {
    const expected = createVideoTimelineEvent(session, value.eventId, value.observationIds, evidence)
    return value.videoTimestampMs === expected.videoTimestampMs
      && value.lastVideoTimestampMs === expected.lastVideoTimestampMs
      && value.canonicalClass === expected.canonicalClass && value.confidence === expected.confidence
  } catch { return false }
}

/** Existing events are an authoritative per-run store, never client-chosen history. */
export function acceptVideoTimelineEvent(
  value: unknown, session: VideoAnalysisSession, evidence: VideoEvidence,
  existing: readonly VideoTimelineEvent[],
): Acceptance {
  if (!isVideoAnalysisSession(session) || session.status !== 'active'
    || !isVideoTimelineEvent(value, session, evidence)
    || existing.some(event => !isVideoTimelineEvent(event, session, evidence))) {
    return { status: 'rejected', reason: 'invalid_or_inactive_event' }
  }
  const prior = existing.find(event => event.eventId === value.eventId)
  if (prior) {
    const same = prior.videoTimestampMs === value.videoTimestampMs
      && prior.lastVideoTimestampMs === value.lastVideoTimestampMs
      && prior.canonicalClass === value.canonicalClass && prior.confidence === value.confidence
      && [...prior.observationIds].sort().join('|') === [...value.observationIds].sort().join('|')
      && prior.reviewStatus === value.reviewStatus
    return same ? { status: 'duplicate' } : { status: 'rejected', reason: 'event_id_conflict' }
  }
  const used = new Set(existing.flatMap(event => [...event.observationIds]))
  return value.observationIds.some(id => used.has(id))
    ? { status: 'rejected', reason: 'observation_already_grouped' } : { status: 'accepted' }
}

function outcomesBySlot(session: VideoAnalysisSession, values: readonly FrameAnalysisOutcome[]): Map<number, FrameAnalysisOutcome> {
  requireSession(session)
  const slots = new Map<number, FrameAnalysisOutcome>()
  const ids = new Set<string>()
  const timestamps = new Set<number>()
  for (const outcome of values) {
    if (!record(outcome) || !sameScope(outcome, session) || outcome.videoId !== session.videoId
      || !identifier(outcome.frameId) || !finite(outcome.videoTimestampMs, 0, session.videoDurationMs)
      || outcome.videoTimestampMs === session.videoDurationMs
      || !['analyzed', 'skipped', 'failed'].includes(outcome.status)) throw new TypeError('Invalid frame outcome')
    const planned = session.contractVersion === 2 ? outcome.plannedSampleTimestampMs : outcome.videoTimestampMs
    if (session.contractVersion === 2 ? !validVideoSample(session, outcome.videoTimestampMs, planned)
      : outcome.plannedSampleTimestampMs !== undefined || Math.abs(Math.round(outcome.videoTimestampMs / session.samplingIntervalMs) * session.samplingIntervalMs - outcome.videoTimestampMs) > 0.000001) {
      throw new TypeError('Frame outcome is outside the declared sampling grid')
    }
    const slot = Math.round(planned! / session.samplingIntervalMs)
    const prior = slots.get(slot)
    if (prior) {
      if (prior.frameId === outcome.frameId && prior.status === outcome.status
        && prior.videoTimestampMs === outcome.videoTimestampMs && prior.plannedSampleTimestampMs === outcome.plannedSampleTimestampMs) continue
      throw new TypeError('Conflicting slot outcome')
    }
    if (ids.has(outcome.frameId) || timestamps.has(outcome.videoTimestampMs)) throw new TypeError('Frame reused at a different video time')
    slots.set(slot, outcome)
    ids.add(outcome.frameId)
    timestamps.add(outcome.videoTimestampMs)
  }
  return slots
}

function appendRange(ranges: CoverageRange[], startMs: number, endMs: number): void {
  const last = ranges.at(-1)
  if (last && last.endMs === startMs) last.endMs = endMs
  else ranges.push({ startMs, endMs })
}

/** Coverage means completed samples on the declared grid, never every decoded frame. */
export function calculateAnalysisCoverage(
  session: VideoAnalysisSession, outcomes: readonly FrameAnalysisOutcome[],
): AnalysisCoverage {
  const slots = outcomesBySlot(session, outcomes)
  const coveredRanges: CoverageRange[] = []
  const unanalysedRanges: CoverageRange[] = []
  let analyzedFrames = 0
  let skippedFrames = 0
  let failedFrames = 0
  const slotCount = Math.ceil(session.videoDurationMs / session.samplingIntervalMs)
  for (let slot = 0; slot < slotCount; slot++) {
    const status = slots.get(slot)?.status
    if (status === 'analyzed') analyzedFrames++
    if (status === 'skipped') skippedFrames++
    if (status === 'failed') failedFrames++
    const ranges = status === 'analyzed' ? coveredRanges : unanalysedRanges
    appendRange(ranges, slot * session.samplingIntervalMs, Math.min((slot + 1) * session.samplingIntervalMs, session.videoDurationMs))
  }
  return {
    basis: 'DECLARED_SAMPLING_GRID', samplingIntervalMs: session.samplingIntervalMs,
    status: analyzedFrames === slotCount ? 'complete' : analyzedFrames === 0 ? 'none' : 'partial',
    analyzedFrames, skippedFrames, failedFrames, coveredRanges, unanalysedRanges,
  }
}

/** Rejected review events are excluded; admitted pending events remain provisional. */
export function summarizeVideoAnalysis(
  session: VideoAnalysisSession, events: readonly VideoTimelineEvent[], evidence: VideoEvidence,
  outcomes: readonly FrameAnalysisOutcome[],
): VideoAnalysisSummary {
  requireSession(session)
  const observations = evidenceIndex(session, evidence)
  const slots = outcomesBySlot(session, outcomes)
  const analyzed = new Map([...slots.values()].filter(item => item.status === 'analyzed').map(item => [item.frameId, item]))
  for (const outcome of analyzed.values()) {
    const frame = evidence.frames.find(item => item.frameId === outcome.frameId)
    if (!frame || frame.capturedAt.valueMs !== outcome.videoTimestampMs
      || frame.plannedSampleTimestampMs !== outcome.plannedSampleTimestampMs) throw new TypeError('Missing analyzed frame evidence')
  }
  const coverage = calculateAnalysisCoverage(session, outcomes)
  if (session.analysisStatus === 'completed' && coverage.status !== 'complete') {
    throw new TypeError('Incomplete coverage cannot be reported as completed analysis')
  }
  const eventIds = new Set<string>()
  const used = new Set<string>()
  for (const event of events) {
    if (!isVideoTimelineEvent(event, session, evidence) || eventIds.has(event.eventId)) throw new TypeError('Invalid or duplicate timeline event')
    eventIds.add(event.eventId)
    for (const id of event.observationIds) {
      const observation = observations.get(id)!
      if (used.has(id) || analyzed.get(observation.frameId)?.videoTimestampMs !== observation.capturedAt.valueMs) {
        throw new TypeError('Duplicate or unanalyzed event observation')
      }
      used.add(id)
    }
  }
  // Return copies: callers cannot mutate source events through a summary reference.
  const accepted = events.filter(event => event.reviewStatus !== 'rejected')
    .map(event => ({ ...event, observationIds: [...event.observationIds].sort() }))
    .sort((a, b) => a.videoTimestampMs - b.videoTimestampMs || (a.eventId < b.eventId ? -1 : 1))
  const classCounts = Object.fromEntries([...DAMAGE_TYPES, 'unknown'].map(key => [key, 0])) as Record<CanonicalClass, number>
  for (const event of accepted) classCounts[event.canonicalClass]++
  return {
    contractVersion: session.contractVersion, sessionId: session.sessionId, runId: session.runId,
    sourceDomain: 'REPLAY', ...session.detector, videoId: session.videoId,
    resultLabel: resultLabel(session.detector.detectorKind), analysisStatus: session.analysisStatus,
    coverage, totalEvents: accepted.length,
    rawObservationCount: [...observations.values()].filter(item => analyzed.get(item.frameId)?.videoTimestampMs === item.capturedAt.valueMs).length,
    classCounts, firstDamageTimestampMs: accepted[0]?.videoTimestampMs ?? null,
    lastDamageTimestampMs: accepted.length ? Math.max(...accepted.map(event => event.lastVideoTimestampMs)) : null,
    events: accepted, deduplication: 'EXPLICIT_OBSERVATION_GROUPS',
  }
}
