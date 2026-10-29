from concurrent.futures import ThreadPoolExecutor
import pytest
from conftest import base, image_bytes, metadata, new_session, submit, wait_job


@pytest.mark.parametrize(('fmt', 'mime'), [('PNG', 'image/png'), ('JPEG', 'image/jpeg')])
def test_generated_image_runs_through_real_decoder_and_synthetic_detector(api, fmt, mime):
    session = new_session(api)
    job = wait_job(api, submit(api, session, content=image_bytes(fmt), mime=mime))
    assert job['status'] == 'succeeded'
    assert job['resultLabel'] == 'TEST_SYNTHETIC' and job['detectorKind'] == 'TEST'
    assert len(job['observationIds']) == 1
    assert job['observations'][0]['box'] == {'x': 0.1, 'y': 0.2, 'width': 0.2, 'height': 0.3}
    assert job['observations'][0]['frameId'] == 'frame-0'
    summary = api.get(base(session) + '/summary').json()
    assert summary['summary']['rawObservationCount'] == 1
    assert summary['trackingStatus'] == 'NO_PHYSICAL_TRACKER'


@pytest.mark.parametrize(('content', 'mime'), [(b'not an image', 'image/png'), (b'\x89PNG\r\n\x1a\n', 'image/png'), (image_bytes(), 'image/jpeg')])
def test_corrupt_or_mismatched_content_fails_without_exposing_parser_error(api, content, mime):
    session = new_session(api)
    job = wait_job(api, submit(api, session, content=content, mime=mime))
    assert job['status'] == 'failed' and job['errorCode'] == 'invalid_image'
    assert api.get(base(session) + '/summary').json()['summary']['coverage']['failedFrames'] == 1
    assert not list((api.app.state.engine.store.folder('REPLAY') / 'media').iterdir())


def test_unsupported_mime_empty_body_and_byte_limits(api):
    session = new_session(api)
    api.post(base(session) + '/frames', json=metadata(session))
    url = base(session) + '/frames/frame-0/content'
    assert api.put(url, content=b'test', headers={'content-type': 'text/plain'}).status_code == 415
    assert api.put(url, content=b'', headers={'content-type': 'image/png'}).status_code == 422
    assert api.put(url, content=b'x' * (4 * 1024 * 1024 + 1), headers={'content-type': 'image/png'}).status_code == 413
    assert not list((api.app.state.engine.store.folder('REPLAY') / 'media').iterdir())


def test_photo_and_request_body_limits_are_enforced_for_chunked_content(api):
    session = new_session(api)
    api.post(base(session) + '/frames', json=metadata(session, kind='photo'))
    def chunks():
        for _ in range(9):
            yield b'x' * (1024 * 1024)
    response = api.put(base(session) + '/frames/frame-0/content', content=chunks(), headers={'content-type': 'image/png'})
    assert response.status_code == 413
    assert not list((api.app.state.engine.store.folder('REPLAY') / 'media').iterdir())


def test_pixel_limit_and_dimension_mismatch_fail(api):
    session = new_session(api)
    huge = image_bytes(size=(4001, 4000))
    assert wait_job(api, submit(api, session, content=huge, size=(4001, 4000)))['status'] == 'failed'
    assert wait_job(api, submit(api, session, 'frame-1', 1000, size=(20, 20)))['status'] == 'failed'


def test_duplicate_binary_is_idempotent_but_changed_payload_is_409(api):
    session = new_session(api)
    content = image_bytes()
    first = submit(api, session, content=content)
    assert wait_job(api, first)['status'] == 'succeeded'
    url = base(session) + '/frames/frame-0/content'
    duplicate = api.put(url, content=content, headers={'content-type': 'image/png'}).json()
    assert duplicate['jobId'] == first['jobId'] and duplicate['duplicate'] is True
    assert api.put(url, content=image_bytes(color='red'), headers={'content-type': 'image/png'}).status_code == 409
    assert api.get(base(session) + '/summary').json()['summary']['coverage']['analyzedFrames'] == 1


def test_concurrent_duplicate_upload_creates_one_job(api):
    session = new_session(api)
    api.post(base(session) + '/frames', json=metadata(session))
    def send(_):
        return api.put(base(session) + '/frames/frame-0/content', content=image_bytes(), headers={'content-type': 'image/png'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send, range(2)))
    assert all(result.status_code == 202 for result in results)
    assert results[0].json()['jobId'] == results[1].json()['jobId']
    assert wait_job(api, results[0].json())['status'] == 'succeeded'


def test_client_filename_does_not_become_a_server_path(api):
    session = new_session(api)
    job = submit(api, session)
    assert wait_job(api, job)['status'] == 'succeeded'
    files = list((api.app.state.engine.store.folder('REPLAY') / 'media').iterdir())
    assert len(files) == 1 and len(files[0].stem) == 32
    packet = metadata(session, '../escape', 1000)
    assert api.post(base(session) + '/frames', json=packet).status_code == 422
    packet = metadata(session, 'safe-frame', 1000)
    packet['filename'] = '../../escape.png'
    assert api.post(base(session) + '/frames', json=packet).status_code == 422
