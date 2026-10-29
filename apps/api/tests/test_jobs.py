from dataclasses import replace
import os
import time
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.jobs import process_image
from app.detectors.test_detector import TestDetector
from conftest import base, image_bytes, metadata, new_session, submit, wait_job


def slow_worker(payload, sender):
    time.sleep(30)
    process_image(payload, sender)


def crash_once_worker(payload, sender):
    if payload['frame']['frameId'] == 'frame-crash':
        os._exit(7)
    process_image(payload, sender)


def invalid_worker(payload, sender):
    sender.send({'ok': True, 'observations': [{'private': 'SYNTHETIC_INVALID_WORKER_OUTPUT'}]})
    sender.close()


def client_for(settings, credentials, worker):
    return TestClient(create_app(settings, worker=worker), headers={'authorization': 'Bearer ' + credentials['alice']})


def test_worker_crash_is_reported_and_next_worker_succeeds(settings, credentials):
    with client_for(settings, credentials, crash_once_worker) as client:
        session = new_session(client)
        failed = wait_job(client, submit(client, session, 'frame-crash'))
        assert failed['status'] == 'failed' and failed['errorCode'] == 'worker_crashed'
        successful = wait_job(client, submit(client, session, 'frame-next', 1000))
        assert successful['status'] == 'succeeded'


def test_worker_timeout_is_bounded_and_returns_safe_error(settings, credentials):
    with client_for(replace(settings, worker_timeout=0.5), credentials, slow_worker) as client:
        session = new_session(client)
        job = wait_job(client, submit(client, session))
        assert job['status'] == 'failed' and job['errorCode'] == 'worker_timeout'


def test_invalid_worker_output_cannot_create_observations(settings, credentials):
    with client_for(settings, credentials, invalid_worker) as client:
        session = new_session(client)
        job = wait_job(client, submit(client, session))
        assert job['status'] == 'failed' and job['errorCode'] == 'invalid_detector_output'
        assert client.get(base(session) + '/timeline').json()['events'] == []


def test_queue_limit_rejects_new_work_without_storing_an_extra_upload(settings, credentials):
    with client_for(replace(settings, queue_limit=2), credentials, slow_worker) as client:
        session = new_session(client)
        submit(client, session)
        submit(client, session, 'frame-1', 1000)
        client.post(base(session) + '/frames', json=metadata(session, 'frame-2', 2000))
        response = client.put(base(session) + '/frames/frame-2/content', content=image_bytes(), headers={'content-type': 'image/png'})
        assert response.status_code == 429
        assert response.json()['error']['code'] == 'analysis_queue_full'
        assert len(list((client.app.state.engine.store.folder('REPLAY') / 'media').iterdir())) == 2


@pytest.mark.parametrize('action', ['cancel', 'rotate'])
def test_cancel_or_new_run_prevents_late_success_from_being_committed(settings, credentials, action):
    with client_for(settings, credentials, slow_worker) as client:
        session = new_session(client)
        job = submit(client, session)
        if action == 'cancel':
            assert client.post('/v1/sessions/' + session['sessionId'] + '/cancel').status_code == 200
            current = session
        else:
            response = client.post('/v1/sessions/' + session['sessionId'] + '/runs', json={'commandId': 'rotate', 'expectedRunId': session['runId']})
            current = response.json()['session']
        late = TestDetector().detect(metadata(session)['frame'], 'synthetic_one')
        client.app.state.engine.finish_job('REPLAY', job['jobId'], {'ok': True, 'observations': late})
        assert client.get('/v1/jobs/' + job['jobId']).json()['status'] == 'cancelled'
        assert client.get(base(current) + '/timeline').json()['events'] == []
        with client.app.state.engine.store.tx('REPLAY') as db:
            assert client.app.state.engine.store.find(db, 'observation') == []
