"""Synthetic decoded PTS policies, shared fixtures and authoritative lifecycle tests."""
import json
from pathlib import Path
import pytest
from app.contracts import scope, validate_frame
from app.video import coverage
from conftest import base, image_bytes, metadata, new_session, wait_job

CASES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/fixtures/m3a-video-timing.json').read_text(encoding='utf8'))['cases']


@pytest.mark.parametrize('case', CASES, ids=[c['id'] for c in CASES])
def test_shared_timing_fixture(case):
    session = {'contractVersion': case.get('version', 2), 'sourceDomain': 'REPLAY', 'sessionId': 'synthetic-session',
        'runId': 'synthetic-run', 'status': 'active', 'clockDomain': 'VIDEO', 'clockId': 'synthetic-clock',
        'detector': {'detectorKind': 'TEST', 'modelVersion': 'synthetic-model', 'classMapVersion': 'synthetic-map'},
        'videoId': 'synthetic-video', 'videoDurationMs': case.get('duration', 4000),
        'samplingIntervalMs': case.get('interval', 1000), 'recordingOrigin': 'UNKNOWN', 'analysisStatus': 'running'}
    outcomes = []
    accepted = True
    try:
        for planned, actual, frame_id in case['samples']:
            frame = metadata(session, frame_id, actual)['frame']
            frame['runId'] = case.get('runId', session['runId'])
            if not case.get('omitPlanned'):
                frame['plannedSampleTimestampMs'] = planned
            validate_frame(frame, session)
            outcomes.append({**scope(frame), 'frameId': frame_id, 'videoId': session['videoId'], 'videoTimestampMs': actual,
                'status': 'analyzed', **({} if case.get('omitPlanned') else {'plannedSampleTimestampMs': planned})})
        result = coverage(session, outcomes)
    except Exception:
        accepted = False
    assert accepted == case['valid']
    if accepted:
        assert result['analyzedFrames'] == len({sample[0] for sample in case['samples']})


def timed_metadata(session, frame_id='actual-pts', actual=1001.001001001001, planned=1000):
    result = metadata(session, frame_id, actual)
    result['frame']['plannedSampleTimestampMs'] = planned
    return result


def test_v2_pts_upload_idempotency_conflicts_and_summary(api):
    session = new_session(api, contractVersion=2)
    request = timed_metadata(session)
    url = base(session) + '/frames'
    assert api.post(url, json=request).status_code == 201
    assert api.post(url, json=request).json()['duplicate'] is True
    assert api.post(url, json=timed_metadata(session, 'other-frame', 1002)).status_code == 409
    assert api.post(url, json=timed_metadata(session, actual=1002)).status_code == 409
    content_url = url + '/actual-pts/content'
    first = api.put(content_url, content=image_bytes(), headers={'content-type':'image/png'})
    assert first.status_code == 202
    assert wait_job(api, first.json())['status'] == 'succeeded'
    again = api.put(content_url, content=image_bytes(), headers={'content-type':'image/png'})
    assert again.json()['jobId'] == first.json()['jobId'] and again.json()['duplicate']
    assert api.put(content_url, content=image_bytes(color='red'), headers={'content-type':'image/png'}).status_code == 409
    summary = api.get(base(session) + '/summary').json()['summary']
    assert summary['firstDamageTimestampMs'] == request['frame']['capturedAt']['valueMs']
    assert summary['events'][0]['videoTimestampMs'] == request['frame']['capturedAt']['valueMs']
    assert summary['coverage']['coveredRanges'] == [{'startMs':1000,'endMs':2000}]
    assert summary['coverage']['analyzedFrames'] == summary['totalEvents'] == 1
    assert summary['coverage']['status'] == 'partial'
    assert api.post(base(session) + '/complete', json={'analysisStatus':'completed'}).status_code == 422
    assert api.post(url, json=timed_metadata(session, 'outside', 2101, 2000)).status_code == 422
    missing = metadata(session, 'missing', 2000)
    assert api.post(url, json=missing).status_code == 422


def test_v1_persisted_m2_command_fingerprint_and_explicit_default_remain_compatible(api):
    from app.sessions import fingerprint
    request = {'commandId':'persisted-m2-create','sourceDomain':'REPLAY','detectorKind':'TEST',
        'testProfile':'synthetic_one','clockId':'synthetic-clock','videoId':'synthetic-video',
        'videoDurationMs':4000,'samplingIntervalMs':1000}
    first = api.post('/v1/sessions', json=request)
    assert first.status_code == 201
    session = first.json()['session']
    engine = api.app.state.engine
    # M2 persisted exactly this payload, before contractVersion was a request field.
    # The M2 DTO serialized these float-typed plan fields as JSON 4000.0/1000.0.
    old_digest = fingerprint({**request, 'recordingOrigin':'UNKNOWN', 'videoDurationMs':4000.0, 'samplingIntervalMs':1000.0})
    with engine.store.tx('REPLAY') as db:
        command = engine.store.get(db, 'command', fingerprint(['alice','create',request['commandId']]))
        assert command['payload']['hash'] == old_digest
    assert api.post('/v1/sessions', json={**request,'contractVersion':1}).json() == first.json()
    assert api.post('/v1/sessions', json={**request,'contractVersion':2}).status_code == 409
    assert session['contractVersion'] == 1


@pytest.mark.parametrize('version,domain', [(True,'REPLAY'),(3,'REPLAY'),(2,'REAL'),(2,'SIM')])
def test_unsupported_or_non_video_versions_are_rejected(api, version, domain):
    response = api.post('/v1/sessions', json={'contractVersion':version,'commandId':'bad-version',
        'sourceDomain':domain,'detectorKind':'TEST','testProfile':'synthetic_one','clockId':'synthetic-clock',
        **({'videoId':'synthetic-video','videoDurationMs':4000,'samplingIntervalMs':1000} if domain == 'REPLAY' else {})})
    assert response.status_code == 422


@pytest.mark.parametrize('action', ['cancel', 'rotate'])
def test_v2_seek_and_cancel_reject_late_results(settings, credentials, action):
    from test_jobs import client_for, slow_worker
    from app.detectors.test_detector import TestDetector
    with client_for(settings, credentials, slow_worker) as client:
        session = new_session(client, contractVersion=2)
        request = timed_metadata(session)
        assert client.post(base(session) + '/frames', json=request).status_code == 201
        job = client.put(base(session) + '/frames/actual-pts/content', content=image_bytes(), headers={'content-type':'image/png'}).json()
        if action == 'cancel':
            assert client.post('/v1/sessions/' + session['sessionId'] + '/cancel').status_code == 200
            current = session
        else:
            current = client.post('/v1/sessions/' + session['sessionId'] + '/runs', json={'commandId':'seek','expectedRunId':session['runId']}).json()['session']
        late = TestDetector().detect(request['frame'], 'synthetic_one')
        client.app.state.engine.finish_job('REPLAY', job['jobId'], {'ok':True,'observations':late})
        assert client.get('/v1/jobs/' + job['jobId']).json()['status'] == 'cancelled'
        assert client.get(base(current) + '/timeline').json()['events'] == []
        assert client.post(base(session) + '/frames', json=timed_metadata(session, 'late', 2001, 2000)).status_code == 409
