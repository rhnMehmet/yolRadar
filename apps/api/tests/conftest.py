"""Only generated color images, synthetic coordinates and ephemeral credentials."""
from dataclasses import replace
import io
import secrets
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from app.main import create_app
from app.security import Principal, Settings


@pytest.fixture
def credentials():
    return {name: secrets.token_urlsafe(32) for name in ('alice', 'bob', 'sim')}


@pytest.fixture
def settings(tmp_path, credentials):
    return Settings(tmp_path / 'private-data', (
        Principal.create('alice', credentials['alice'], reviewer=True),
        Principal.create('bob', credentials['bob'], domains=('REPLAY',)),
        Principal.create('sim', credentials['sim'], domains=('SIM',)),
    ))


@pytest.fixture
def api(settings, credentials):
    app = create_app(settings)
    with TestClient(app) as client:
        client.headers['authorization'] = 'Bearer ' + credentials['alice']
        yield client


def new_session(client, domain='REPLAY', **changes):
    request = {'commandId': uuid4().hex, 'sourceDomain': domain, 'detectorKind': 'TEST',
        'testProfile': 'synthetic_one', 'clockId': 'synthetic-clock'}
    if domain == 'REPLAY':
        request.update(videoId='synthetic-video', videoDurationMs=4000, samplingIntervalMs=1000)
    request.update(changes)
    response = client.post('/v1/sessions', json=request)
    assert response.status_code == 201, response.text
    return response.json()['session']


def base(session):
    return f'/v1/sessions/{session["sessionId"]}/runs/{session["runId"]}'


def metadata(session, frame_id='frame-0', timestamp=0, size=(16, 16), kind='frame'):
    time_value = {'clockDomain': session['clockDomain'], 'clockId': session['clockId'], 'valueMs': timestamp}
    if session['sourceDomain'] == 'REPLAY':
        time_value['videoId'] = session['videoId']
    return {'kind': kind, 'frame': {**{key: session[key] for key in ('contractVersion', 'sessionId', 'runId', 'sourceDomain')},
        'frameId': frame_id, 'capturedAt': time_value, 'width': size[0], 'height': size[1]}}


def image_bytes(fmt='PNG', size=(16, 16), color='blue'):
    image = Image.new('RGB', size, color=color)
    stream = io.BytesIO()
    image.save(stream, format=fmt)
    return stream.getvalue()


def submit(client, session, frame_id='frame-0', timestamp=0, content=None, mime='image/png', size=(16, 16), kind='frame'):
    response = client.post(base(session) + '/frames', json=metadata(session, frame_id, timestamp, size, kind))
    assert response.status_code == 201, response.text
    response = client.put(base(session) + f'/frames/{frame_id}/content', content=image_bytes() if content is None else content,
        headers={'content-type': mime})
    assert response.status_code == 202, response.text
    return response.json()


def wait_job(client, job, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get('/v1/jobs/' + job['jobId'])
        assert response.status_code == 200, response.text
        value = response.json()
        if value['status'] not in ('queued', 'running'):
            return value
        time.sleep(0.025)
    raise AssertionError('Synthetic worker did not finish within test deadline')
