import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptFrame, isAlertEvent, isCaptureSession, isCaptureTime, isClassMap,
  isDamageCandidate, isDetectionObservation, isImageFrame, isPositionSample,
  isSimulationGroundTruth, isSpatialPosition, isVerifiedDamage, isVideoAnalysisSession,
  resolveCanonicalClass, resultLabel, sameScope, scopeKey,
} from '../src/index.ts'
import type { AlertEvent, VerifiedDamage } from '../src/index.ts'
import { candidate, capture, classMap, frame, observation, scope, video } from './m1Fixtures.ts'

test('M1: REAL / SIM / REPLAY sessions keep independent TEST / YOLO identities', () => {
  for (const session of [capture('REAL'), capture('SIM'), video()]) {
    assert.equal(isCaptureSession(session), true)
    assert.equal(isCaptureSession({ ...session, detector: { ...session.detector, detectorKind: 'YOLO' } }), true)
    assert.equal(isImageFrame(frame(session), session), true)
  }
  assert.equal(resultLabel('TEST'), 'TEST_SYNTHETIC')
  assert.equal(resultLabel('YOLO'), 'YOLO_RESULT')
  assert.equal(isCaptureSession(null), false)
  assert.equal(isCaptureSession({ ...capture(), contractVersion: 2 }), false)
})

test('M1: wrong domain, session and run are rejected even with matching IDs', () => {
  const session = capture()
  const image = frame(session)
  for (const patch of [{ sourceDomain: 'SIM' }, { sessionId: 'other' }, { runId: 'old-run' }, { contractVersion: 99 }]) {
    assert.equal(isImageFrame({ ...image, ...patch }, session), false)
    assert.equal(sameScope({ ...image, ...patch }, session), false)
  }
  assert.equal(isCaptureSession({ ...session, sourceDomain: 'SIM' }), false)
})

test('M1: clock instance, domain, video ID, finite time and duration must match', () => {
  const session = video()
  const time = frame(session).capturedAt
  for (const patch of [{ clockId: 'other-clock' }, { clockDomain: 'DEVICE_MONOTONIC' }, { videoId: 'other-video' },
    { valueMs: -1 }, { valueMs: Infinity }, { valueMs: NaN }, { valueMs: 4_001 }]) {
    assert.equal(isCaptureTime({ ...time, ...patch }, session), false)
  }
  assert.equal(isCaptureTime({ ...time, valueMs: 4_000 }, session), true)
  assert.equal(isVideoAnalysisSession({ ...session, videoDurationMs: 0 }), false)
  assert.equal(isVideoAnalysisSession({ ...session, samplingIntervalMs: 0.000001 }), false)
})

test('M1: missing / non-finite / out-of-bounds GPS is rejected; zero and world boundaries are valid', () => {
  const session = capture()
  const gps = { kind: 'GPS', latitude: 0, longitude: 0, accuracyM: 10 }
  assert.equal(isSpatialPosition(gps, session), true)
  assert.equal(isSpatialPosition({ ...gps, latitude: 90, longitude: -180 }, session), true)
  for (const value of [null, {}, { kind: 'GPS' }, { ...gps, latitude: NaN }, { ...gps, longitude: Infinity },
    { ...gps, latitude: 90.1 }, { ...gps, longitude: -180.1 }, { ...gps, accuracyM: -1 }, { ...gps, latitude: '0' }]) {
    assert.equal(isSpatialPosition(value, session), false)
  }
})

test('M1: SIM_LOCAL never passes as REAL GPS; replay coordinates require explicit recording provenance', () => {
  const local = { kind: 'SIM_LOCAL', units: 'm', frameId: 'synthetic-world', x: 1, y: 2, z: 0 }
  const gps = { kind: 'GPS', latitude: 0, longitude: 0, accuracyM: 10 }
  assert.equal(isSpatialPosition(local, capture('SIM')), true)
  assert.equal(isSpatialPosition(local, capture()), false)
  assert.equal(isSpatialPosition(gps, capture('SIM')), false)
  assert.equal(isSpatialPosition({ ...local, units: 'degrees' }, capture('SIM')), false)
  assert.equal(isSpatialPosition({ ...local, x: Infinity }, capture('SIM')), false)
  assert.equal(isSpatialPosition(gps, video()), false)
  const realReplay = { ...video(), recordingOrigin: 'REAL' as const }
  const simReplay = { ...video(), recordingOrigin: 'SIM' as const }
  assert.equal(isSpatialPosition(gps, realReplay), true)
  assert.equal(isSpatialPosition(local, simReplay), true)
  assert.equal(isSpatialPosition({ ...gps, frameId: 'sim-world', x: 1, y: 2, z: 0 }, capture()), false)
})

test('M1: vehicle samples bind position and time to the same session', () => {
  const session = capture()
  const sample = { ...scope(session), sampleId: 'position-0', capturedAt: frame(session).capturedAt,
    position: { kind: 'GPS', latitude: 0, longitude: 0, accuracyM: 10 } }
  assert.equal(isPositionSample(sample, session), true)
  assert.equal(isPositionSample({ ...sample, runId: 'old-run' }, session), false)
  assert.equal(isPositionSample({ ...sample, capturedAt: { ...sample.capturedAt, clockId: 'other' } }, session), false)
})

test('M1: normalized box, score, frame and detector validation rejects malformed observations', () => {
  const session = capture()
  const image = frame(session)
  const obs = observation(session, image)
  assert.equal(isDetectionObservation(obs, session, image, classMap), true)
  for (const patch of [{ confidence: NaN }, { confidence: Infinity }, { confidence: 1.01 }, { confidence: -0.1 },
    { frameId: 'wrong' }, { detectorKind: 'YOLO' }, { modelVersion: 'other' }, { classMapVersion: 'other' },
    { box: { x: -0.1, y: 0, width: 0.2, height: 0.3 } }, { box: { x: 0.9, y: 0, width: 0.2, height: 0.3 } },
    { box: { x: 0, y: 0, width: 0, height: 1 } }, { box: { x: 0, y: NaN, width: 1, height: 1 } }]) {
    assert.equal(isDetectionObservation({ ...obs, ...patch }, session, image, classMap), false)
  }
  assert.equal(isImageFrame({ ...image, width: 0 }, session), false)
  assert.equal(isImageFrame({ ...image, height: Infinity }, session), false)
})

test('M1: numeric dataset indices have no implicit canonical mapping', () => {
  assert.equal(resolveCanonicalClass('0', classMap), 'unknown')
  assert.equal(resolveCanonicalClass('raw-A', classMap), 'pothole')
  assert.equal(isClassMap({ ...classMap, entries: [...classMap.entries, classMap.entries[0]] }), false)
  assert.equal(isClassMap({ ...classMap, entries: [{ rawClassId: '0', canonicalClass: 'made-up-class' }] }), false)
})

test('M1: unapproved class maps permit only unknown, and cannot produce alerts', () => {
  const session = capture()
  const image = frame(session)
  const unapproved = { ...classMap, approved: false }
  const obs = observation(session, image)
  assert.equal(resolveCanonicalClass('raw-A', unapproved), 'unknown')
  assert.equal(isDetectionObservation(obs, session, image, unapproved), false)
  assert.equal(isDetectionObservation({ ...obs, canonicalClass: 'unknown' }, session, image, unapproved), true)
  const item = candidate(session, obs)
  const alert = { ...scope(session), ...session.detector, alertId: 'alert-0', candidateId: item.candidateId,
    canonicalClass: 'pothole', resultLabel: 'TEST_SYNTHETIC', reason: 'CAMERA_OBSERVATION' }
  assert.equal(isAlertEvent(alert, session, item, unapproved), false)
})

test('M1: repeated frame request is idempotent and no global state is mutated', () => {
  const session = capture()
  const image = frame(session)
  const seen = new Set<string>()
  assert.deepEqual(acceptFrame(image, session, seen), { status: 'accepted' })
  assert.equal(seen.size, 0)
  seen.add(scopeKey(session, 'frame', image.frameId))
  assert.deepEqual(acceptFrame(image, session, seen), { status: 'duplicate' })
  assert.equal(acceptFrame(image, { ...session, status: 'cancelled' }, seen).status, 'rejected')
  assert.equal(acceptFrame({ ...image, runId: 'old' }, session, seen).status, 'rejected')
})

test('M1: unknown defect location remains valid and is not copied from the vehicle position', () => {
  const session = capture()
  const obs = observation(session, frame(session))
  const item = candidate(session, obs)
  item.vehiclePosition = { ...scope(session), sampleId: 'position-0', capturedAt: obs.capturedAt,
    position: { kind: 'GPS', latitude: 0, longitude: 0, accuracyM: 10 } }
  assert.equal(isDamageCandidate(item, session, [obs]), true)
  assert.deepEqual(item.damageLocation, { kind: 'UNKNOWN' })
  assert.equal(isDamageCandidate({ ...item, damageLocation: {} }, session, [obs]), false)
  assert.equal(isDamageCandidate({ ...item, damageLocation: { kind: 'UNKNOWN', position: item.vehiclePosition.position } }, session, [obs]), false)
  assert.equal(isDamageCandidate({ ...item, observationIds: ['missing'] }, session, [obs]), false)
  assert.equal(isDamageCandidate(item, session, [{ ...obs, sourceDomain: 'SIM' }]), false)
})

test('M1: human-reviewed verified damage is separate and cannot promote SIM / TEST evidence', () => {
  const session = capture('SIM')
  const obs = observation(session, frame(session))
  const item = candidate(session, obs)
  const verified: VerifiedDamage = {
    ...scope(session), ...session.detector, verifiedId: 'verified-0', candidateId: item.candidateId,
    canonicalClass: 'pothole', reviewStatus: 'approved', review: { kind: 'HUMAN', reviewerId: 'synthetic-reviewer' },
    damageLocation: { kind: 'ESTIMATED', method: 'HUMAN_PLACEMENT', uncertaintyM: 1,
      position: { kind: 'SIM_LOCAL', units: 'm', frameId: 'synthetic-world', x: 1, y: 2, z: 0 } },
  }
  assert.equal(isVerifiedDamage(verified, session, item), true)
  assert.equal(isVerifiedDamage(item, session, item), false)
  assert.equal(isDamageCandidate(verified, session, [obs]), false)
  for (const patch of [{ sourceDomain: 'REAL' }, { detectorKind: 'YOLO' }, { review: { kind: 'AUTOMATIC', reviewerId: 'fake' } },
    { damageLocation: { kind: 'UNKNOWN' } }, { canonicalClass: 'unknown' }]) {
    assert.equal(isVerifiedDamage({ ...verified, ...patch }, session, item), false)
  }
})

test('M1: TEST alert labels are mandatory; map approach additionally requires reviewed damage', () => {
  const session = capture()
  const obs = observation(session, frame(session))
  const item = candidate(session, obs)
  const alert: AlertEvent = { ...scope(session), ...session.detector, alertId: 'alert-0', candidateId: item.candidateId,
    canonicalClass: 'pothole', resultLabel: 'TEST_SYNTHETIC', reason: 'CAMERA_OBSERVATION' }
  assert.equal(isAlertEvent(alert, session, item, classMap), true)
  assert.equal(isAlertEvent({ ...alert, resultLabel: 'YOLO_RESULT' }, session, item, classMap), false)
  assert.equal(isAlertEvent({ ...alert, reason: 'MAP_APPROACH' }, session, item, classMap), false)
  assert.equal(isAlertEvent(alert, { ...session, status: 'cancelled' }, item, classMap), false)
})

test('M1: simulation ground truth cannot pass the detector observation or real-data boundary', () => {
  const session = capture('SIM')
  const image = frame(session)
  const truth = { ...scope(session), truthId: 'truth-0', capturedAt: image.capturedAt, canonicalClass: 'pothole',
    position: { kind: 'SIM_LOCAL', units: 'm', frameId: 'synthetic-world', x: 0, y: 0, z: 0 } }
  assert.equal(isSimulationGroundTruth(truth, session), true)
  assert.equal(isSimulationGroundTruth(truth, capture()), false)
  assert.equal(isDetectionObservation(truth, session, image, classMap), false)
})
