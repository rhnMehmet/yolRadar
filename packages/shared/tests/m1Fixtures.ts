/** Entirely synthetic fixtures. No user media, real GPS samples or trained model. */
import type {
  CaptureSession, ClassMap, DamageCandidate, DetectionObservation, FrameAnalysisOutcome,
  ImageFrame, SessionScope, VideoAnalysisSession, VideoEvidence,
} from '../src/index.ts'

export const classMap: ClassMap = {
  version: 'synthetic-map-v1', approved: true,
  entries: [{ rawClassId: 'raw-A', canonicalClass: 'pothole' }, { rawClassId: 'raw-B', canonicalClass: 'longitudinal_crack' }],
}
export function scope(session: SessionScope): SessionScope {
  return { contractVersion: session.contractVersion, sessionId: session.sessionId, runId: session.runId, sourceDomain: session.sourceDomain }
}
export function capture(sourceDomain: CaptureSession['sourceDomain'] = 'REAL'): CaptureSession {
  return {
    contractVersion: 1, sessionId: 'synthetic-session', runId: 'synthetic-run', sourceDomain,
    clockDomain: sourceDomain === 'REAL' ? 'DEVICE_MONOTONIC' : sourceDomain === 'SIM' ? 'SIMULATION' : 'VIDEO',
    clockId: 'synthetic-clock', status: 'active',
    detector: { detectorKind: 'TEST', modelVersion: 'synthetic-model-v1', classMapVersion: classMap.version },
  }
}
export function video(): VideoAnalysisSession {
  return {
    ...capture('REPLAY'), sourceDomain: 'REPLAY', clockDomain: 'VIDEO', videoId: 'synthetic-video',
    videoDurationMs: 4_000, samplingIntervalMs: 1_000, recordingOrigin: 'UNKNOWN', analysisStatus: 'running',
  }
}
export function frame(session: CaptureSession, id = 'frame-0', time = 0): ImageFrame {
  return { ...scope(session), frameId: id, width: 640, height: 360,
    capturedAt: session.clockDomain === 'VIDEO'
      ? { clockDomain: 'VIDEO', clockId: session.clockId, videoId: (session as VideoAnalysisSession).videoId, valueMs: time }
      : { clockDomain: session.clockDomain, clockId: session.clockId, valueMs: time },
  }
}
export function observation(session: CaptureSession, image: ImageFrame, id = 'observation-0'): DetectionObservation {
  return {
    ...scope(session), ...session.detector, observationId: id, frameId: image.frameId,
    capturedAt: { ...image.capturedAt }, rawClassId: 'raw-A', canonicalClass: 'pothole', confidence: 0.8,
    box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
  }
}
export function candidate(session: CaptureSession, obs: DetectionObservation): DamageCandidate {
  return { ...scope(session), ...session.detector, candidateId: 'candidate-0', observationIds: [obs.observationId],
    canonicalClass: obs.canonicalClass, reviewStatus: 'pending', damageLocation: { kind: 'UNKNOWN' } }
}
export function evidence(session: VideoAnalysisSession): VideoEvidence {
  const frames = [0, 1, 2, 3].map(i => frame(session, `frame-${i}`, i * 1_000))
  const observations = frames.slice(0, 3).map((image, i) => observation(session, image, `observation-${i}`))
  return { frames, observations, classMap }
}
export function outcomes(session: VideoAnalysisSession): FrameAnalysisOutcome[] {
  return [0, 1, 2, 3].map(i => ({ ...scope(session), videoId: session.videoId, frameId: `frame-${i}`,
    videoTimestampMs: i * 1_000, status: 'analyzed' }))
}
