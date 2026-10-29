import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoApi, validateObservations, validateSummary, API_ORIGIN, TEST_LABEL, VideoApiError } from '../src/features/video-analysis/videoApi.ts'
import { video, frame, observation, scope, classMap } from '../../../packages/shared/tests/m1Fixtures.ts'
import { summarizeVideoAnalysis } from '../../../packages/shared/src/index.ts'

const session = () => ({ ...video(), contractVersion: 2 as const, clockId: 'synthetic-video' })
const summary = () => summarizeVideoAnalysis(session(), [], { frames: [], observations: [], classMap }, [])
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
const token = () => crypto.randomUUID() + crypto.randomUUID() // ephemeral; never a real credential
test('fixed loopback, no storage/cookies/cache/redirect; v2 request has separate plan', async () => {
  let requests = 0; const credential = token()
  const api = createVideoApi(credential, (async (url, options) => {
    requests++; assert.equal(url, API_ORIGIN + '/v1/sessions'); assert.equal(options!.cache, 'no-store'); assert.equal(options!.credentials, 'omit'); assert.equal(options!.redirect, 'error')
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer ' + credential)
    const body = JSON.parse(options!.body as string); assert.equal(body.contractVersion, 2); assert.equal(body.sourceDomain, 'REPLAY'); assert.equal(body.detectorKind, 'TEST'); assert.equal(body.samplingIntervalMs, 1000)
    assert.equal((url as string).includes(credential), false)
    return json({ session: session(), resultLabel: TEST_LABEL })
  }) as typeof fetch)
  await api.create('synthetic-video', 4000, new AbortController().signal); assert.equal(requests, 1)
})
test('invalid credentials never initiate a request', () => { assert.throws(() => createVideoApi('short')); assert.throws(() => createVideoApi('x'.repeat(40) + '\n')) })
for (const status of [401, 403, 409, 422, 429, 500]) test(`API ${status} is safe and specific, without server body echo`, async () => {
  const api = createVideoApi(token(), (async () => json({ private: 'NEVER_SURFACE_RESPONSE_BODY' }, status)) as typeof fetch)
  await assert.rejects(api.create('synthetic-video', 4000, new AbortController().signal), error => error instanceof VideoApiError && error.status === status && !error.message.includes('NEVER_SURFACE'))
})
test('timeout and abort bound pending fetch; no secret appears in errors', async () => {
  const credential = token(), api = createVideoApi(credential, (async () => new Promise(() => {})) as typeof fetch, 10)
  await assert.rejects(api.create('synthetic-video', 4000, new AbortController().signal), /zaman aşımına/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(api.create('synthetic-video', 4000, aborted.signal), { name: 'AbortError' })
})
test('mid-flight abort settles even when a transport ignores abort', async () => {
  const abort = new AbortController(), api = createVideoApi(token(), (async () => new Promise(() => {})) as typeof fetch, 1000)
  const request = api.create('synthetic-video', 4000, abort.signal)
  abort.abort(); await assert.rejects(request, { name: 'AbortError' })
})
test('oversized or invalid JSON response is rejected without echoing private response text', async () => {
  const api = createVideoApi(token(), (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch)
  await assert.rejects(api.create('synthetic-video', 4000, new AbortController().signal), /bağlantısı\/yanıtı/)
})
for (const patch of [{ videoId: 'other-video' }, { runId: '' }, { contractVersion: 1 }, { sourceDomain: 'REAL' }]) test(`wrong returned scope ${JSON.stringify(patch)}`, async () => {
  const api = createVideoApi(token(), (async () => json({ session: { ...session(), ...patch }, resultLabel: TEST_LABEL })) as typeof fetch)
  await assert.rejects(api.create('synthetic-video', 4000, new AbortController().signal))
})
test('observations must belong to exact frame PTS/scope and valid normalized boxes', () => {
  const s = session(), f = { ...frame(s, 'sample', 1001), plannedSampleTimestampMs: 1000 }, obs = observation(s, f)
  assert.equal(validateObservations([obs], s, f).length, 1)
  for (const patch of [{ runId: 'old' }, { frameId: 'other' }, { capturedAt: { ...obs.capturedAt, valueMs: 1000 } }, { box: { x: .9, y: .1, width: .2, height: .1 } }]) assert.throws(() => validateObservations([{ ...obs, ...patch }], s, f))
})
test('backend summary validates coverage partition/counts, TEST label, events and stale run', () => {
  const valid = summary(); assert.equal(validateSummary(valid, session()), valid)
  for (const patch of [{ resultLabel: 'YOLO_RESULT' }, { runId: 'old' }, { totalEvents: 1 }, { analysisStatus: 'completed' },
    { coverage: { ...valid.coverage, analyzedFrames: 1 } }, { coverage: { ...valid.coverage, unanalysedRanges: [{ startMs: 1000, endMs: 4000 }] } }]) assert.throws(() => validateSummary({ ...valid, ...patch }, session()))
})
test('frame upload carries real fractional time and planned slot; late job from another run rejected', async () => {
  const s = session(), f = { ...frame(s, 'sample', 1001.001001001001), plannedSampleTimestampMs: 1000 }
  let calls = 0
  const api = createVideoApi(token(), (async (_url, options) => {
    if (++calls === 1) { const body = JSON.parse(options!.body as string); assert.equal(body.frame.capturedAt.valueMs, f.capturedAt.valueMs); assert.equal(body.frame.plannedSampleTimestampMs, 1000); return json({ frameId: f.frameId, status: 'registered' }) }
    return json({ ...scope(s), frameId: f.frameId, jobId: 'job', runId: 'wrong-run', detectorKind: 'TEST', resultLabel: TEST_LABEL, status: 'succeeded', observations: [] })
  }) as typeof fetch)
  await assert.rejects(api.analyze(s, f, new Blob(['synthetic'], { type: 'image/jpeg' }), new AbortController().signal), /eşleşmiyor/)
})
