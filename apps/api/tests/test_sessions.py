from conftest import base, metadata, new_session, submit, wait_job


def test_create_command_id_is_idempotent_and_payload_conflict_is_409(api):
    request = {'commandId': 'same-create-command', 'sourceDomain': 'SIM', 'detectorKind': 'TEST',
        'testProfile': 'synthetic_one', 'clockId': 'clock'}
    a = api.post('/v1/sessions', json=request)
    b = api.post('/v1/sessions', json=request)
    assert a.status_code == b.status_code == 201
    assert a.json() == b.json()
    request['testProfile'] = 'synthetic_two'
    assert api.post('/v1/sessions', json=request).status_code == 409


def test_cancel_and_rotate_reject_late_frames_and_old_run(api):
    session = new_session(api)
    request = {'commandId': 'rotate-command', 'expectedRunId': session['runId']}
    response = api.post('/v1/sessions/' + session['sessionId'] + '/runs', json=request)
    assert response.status_code == 200
    new = response.json()['session']
    assert new['runId'] != session['runId']
    assert api.post(base(session) + '/frames', json=metadata(session)).status_code == 409
    assert api.get(base(session) + '/summary').status_code == 409
    assert api.post('/v1/sessions/' + session['sessionId'] + '/runs', json=request).json()['session']['runId'] == new['runId']
    assert api.post('/v1/sessions/' + session['sessionId'] + '/cancel').status_code == 200
    assert api.post(base(new) + '/frames', json=metadata(new)).status_code == 409
    assert api.post('/v1/sessions/' + session['sessionId'] + '/cancel').status_code == 200
    assert api.get(base(new) + '/summary').json()['summary']['analysisStatus'] == 'cancelled'


def test_frame_metadata_duplicates_and_sampling_slot_conflicts(api):
    session = new_session(api)
    packet = metadata(session)
    assert api.post(base(session) + '/frames', json=packet).json()['duplicate'] is False
    assert api.post(base(session) + '/frames', json=packet).json()['duplicate'] is True
    packet['frame']['width'] = 17
    assert api.post(base(session) + '/frames', json=packet).status_code == 409
    assert api.post(base(session) + '/frames', json=metadata(session, 'different-frame', 0)).status_code == 409
    assert api.post(base(session) + '/frames', json=metadata(session, 'off-grid', 500)).status_code == 422


def test_metadata_scope_clock_and_virtual_gps_cannot_be_spoofed(api):
    session = new_session(api, 'SIM')
    packet = metadata(session)
    packet['frame']['sourceDomain'] = 'REAL'
    assert api.post(base(session) + '/frames', json=packet).status_code == 422
    packet = metadata(session)
    packet['frame']['capturedAt']['clockId'] = 'other-clock'
    assert api.post(base(session) + '/frames', json=packet).status_code == 422
    packet = metadata(session)
    packet['vehiclePosition'] = {**{key: session[key] for key in ('contractVersion', 'sessionId', 'runId', 'sourceDomain')},
        'sampleId': 'synthetic-position', 'capturedAt': packet['frame']['capturedAt'],
        'position': {'kind': 'GPS', 'latitude': 0, 'longitude': 0, 'accuracyM': 10}}
    assert api.post(base(session) + '/frames', json=packet).status_code == 422


def test_active_session_limit_is_enforced(api):
    for _ in range(4):
        new_session(api, 'SIM')
    request = {'commandId': 'fifth-command', 'sourceDomain': 'SIM', 'detectorKind': 'TEST',
        'testProfile': 'synthetic_one', 'clockId': 'clock'}
    assert api.post('/v1/sessions', json=request).status_code == 429
