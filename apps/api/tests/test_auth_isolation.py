import json
import pytest
from conftest import base, new_session
from app.main import create_app
from app.security import Settings


def test_health_and_openapi_are_non_sensitive(api):
    assert api.get('/health', headers={'authorization': ''}).json() == {
        'status': 'ok', 'profile': 'TEST', 'resultLabel': 'TEST_SYNTHETIC', 'contractVersion': 1}
    schema = api.get('/openapi.json').json()
    assert '/v1/sessions' in schema['paths']
    assert schema['paths']['/v1/sessions']['post']['security'] == [{'LocalBearer': []}]
    assert api.get('/health').headers['cache-control'] == 'no-store'
    assert api.app._telemetry['logs'] is False and api.app._telemetry['auto_configure'] is False
    assert '/v1/sessions/{sessionId}/runs/{runId}/frames/{frameId}/content' in schema['paths']


def test_fail_closed_without_credentials(monkeypatch):
    monkeypatch.delenv('ROADSENSE_API_AUTH_FILE', raising=False)
    with pytest.raises(RuntimeError):
        create_app()


@pytest.mark.parametrize('header', ['', 'Basic invalid', 'Bearer invalid'])
def test_authentication_is_required(api, header):
    assert api.get('/v1/candidates', headers={'authorization': header}).status_code == 401


def test_other_owner_and_unauthorized_domain_cannot_access_session(api, credentials):
    session = new_session(api)
    headers = {'authorization': 'Bearer ' + credentials['bob']}
    assert api.get('/v1/sessions/' + session['sessionId'], headers=headers).status_code == 404
    assert api.post('/v1/sessions/' + session['sessionId'] + '/cancel', headers=headers).status_code == 404
    request = {'commandId': 'synthetic-command', 'sourceDomain': 'REAL', 'detectorKind': 'TEST',
        'testProfile': 'synthetic_one', 'clockId': 'clock'}
    assert api.post('/v1/sessions', json=request, headers=headers).status_code == 403


def test_client_cannot_assign_owner_role_or_recording_origin(api):
    request = {'commandId': 'synthetic-command', 'sourceDomain': 'SIM', 'detectorKind': 'TEST',
        'testProfile': 'synthetic_one', 'clockId': 'clock', 'owner': 'alice', 'reviewer': True}
    assert api.post('/v1/sessions', json=request).status_code == 422
    request.pop('owner'); request.pop('reviewer')
    request['recordingOrigin'] = 'REAL'
    assert api.post('/v1/sessions', json=request).status_code == 422


@pytest.mark.parametrize('domain', ['REAL', 'SIM', 'REPLAY'])
def test_source_partitions_are_separate_and_test_labeled(api, domain):
    session = new_session(api, domain)
    assert session['sourceDomain'] == domain
    assert session['detector']['detectorKind'] == 'TEST'
    store = api.app.state.engine.store
    for other in ('REAL', 'SIM', 'REPLAY'):
        with store.tx(other) as db:
            assert bool(store.get(db, 'session', session['sessionId'])) == (other == domain)


def test_yolo_never_silently_falls_back(api):
    request = {'commandId': 'synthetic-command', 'sourceDomain': 'SIM', 'detectorKind': 'YOLO',
        'testProfile': 'synthetic_one', 'clockId': 'clock'}
    result = api.post('/v1/sessions', json=request)
    assert result.status_code == 503
    assert result.json()['error']['code'] == 'yolo_model_unavailable'


def test_no_sensitive_validation_input_or_tokens_in_errors_logs(api, caplog, credentials):
    marker = 'SYNTHETIC_PRIVATE_INPUT_DO_NOT_LOG'
    result = api.post('/v1/sessions', json={'private': marker})
    assert result.status_code == 422
    assert marker not in result.text and marker not in caplog.text
    assert credentials['alice'] not in caplog.text


def test_host_and_cors_are_restricted(api):
    assert api.get('/health', headers={'host': 'attacker.invalid'}).status_code == 400
    response = api.options('/v1/sessions', headers={'origin': 'https://attacker.invalid', 'access-control-request-method': 'POST'})
    assert 'access-control-allow-origin' not in response.headers
    response = api.options('/v1/sessions', headers={'origin': 'http://127.0.0.1:5173', 'access-control-request-method': 'POST'})
    assert response.headers['access-control-allow-origin'] == 'http://127.0.0.1:5173'
