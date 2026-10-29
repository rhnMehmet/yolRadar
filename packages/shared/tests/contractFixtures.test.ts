import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  isCaptureSession, isVideoAnalysisSession, isSpatialPosition, isImageFrame, isCaptureTime,
  isDetectionObservation, isDamageCandidate, isVerifiedDamage, isAlertEvent,
  isPositionSample, isSimulationGroundTruth, isClassMap, isVideoTimelineEvent, summarizeVideoAnalysis,
} from '../src/index.ts'

// Trusted fixture harness deliberately passes malformed JSON to runtime guards.
type Fixture = Record<string, any>
function revive(value: any): any {
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    if (value.$number === 'NaN') return NaN
    if (value.$number === 'Infinity') return Infinity
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]))
  }
  return value
}
const fixtureFile = new URL('../../../contracts/fixtures/m1-cases.json', import.meta.url)
// URL starts from packages/shared/tests, so repository root is three parents up.
const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')).cases as Fixture[]
for (const original of fixtures) {
  test(`M2 shared fixture: ${original.id}`, () => {
    const f = revive(original) as Fixture
    let accepted: boolean
    let summary: any
    try {
      switch (f.kind) {
        case 'session': accepted = isCaptureSession(f.value); break
        case 'videoSession': accepted = isVideoAnalysisSession(f.value); break
        case 'position': accepted = isSpatialPosition(f.value, f.session); break
        case 'time': accepted = isCaptureTime(f.value, f.session); break
        case 'frame': accepted = isImageFrame(f.value, f.session); break
        case 'observation': accepted = isDetectionObservation(f.value, f.session, f.frame, f.map); break
        case 'candidate': accepted = isDamageCandidate(f.value, f.session, f.observations); break
        case 'verified': accepted = isVerifiedDamage(f.value, f.session, f.candidate); break
        case 'alert': accepted = isAlertEvent(f.value, f.session, f.candidate, f.map, f.verified); break
        case 'sample': accepted = isPositionSample(f.value, f.session); break
        case 'truth': accepted = isSimulationGroundTruth(f.value, f.session); break
        case 'classMap': accepted = isClassMap(f.value); break
        case 'event': accepted = isVideoTimelineEvent(f.value, f.session, f.evidence); break
        case 'summary':
          summary = summarizeVideoAnalysis(f.session, f.value.events, f.evidence, f.value.outcomes)
          accepted = true
          break
        default: throw new Error('Unsupported fixture kind')
      }
    } catch { accepted = false }
    assert.equal(accepted, f.expected)
    if (accepted && f.expectedSummary) {
      for (const [key, expected] of Object.entries(f.expectedSummary)) assert.deepEqual(summary[key], expected)
    }
  })
}
