from dataclasses import replace
import json
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.storage import Store
from conftest import base, metadata, new_session, submit, wait_job


def test_sqlite_persists_sessions_observations_and_summaries(settings, credentials):
    headers = {'authorization': 'Bearer ' + credentials['alice']}
    with TestClient(create_app(settings), headers=headers) as client:
        session = new_session(client)
        assert wait_job(client, submit(client, session))['status'] == 'succeeded'
        before = client.get(base(session) + '/summary').json()
    with TestClient(create_app(settings), headers=headers) as client:
        assert client.get('/v1/sessions/' + session['sessionId']).status_code == 200
        assert client.get(base(session) + '/summary').json() == before


def test_transactions_roll_back_and_ids_are_bound_as_sql_parameters(settings):
    store = Store(settings)
    store.acquire()
    try:
        with pytest.raises(RuntimeError):
            with store.tx('SIM') as db:
                store.put(db, 'fixture', 'rollback', {'synthetic': True}, 'alice', 's', 'r')
                raise RuntimeError('synthetic failure')
        with store.tx('SIM') as db:
            assert store.get(db, 'fixture', 'rollback') is None
            attack = "' OR 1=1 --"
            store.put(db, 'fixture', attack, {'synthetic': True}, 'alice', 's', 'r')
            assert store.get(db, 'fixture', 'not-found') is None
            assert len(store.find(db, 'fixture')) == 1
    finally:
        store.close()


def test_exclusive_instance_lock_prevents_second_server_without_mutating_first(settings, credentials):
    headers = {'authorization': 'Bearer ' + credentials['alice']}
    with TestClient(create_app(settings), headers=headers) as first:
        session = new_session(first)
        with pytest.raises(RuntimeError, match='Another RoadSense'):
            with TestClient(create_app(settings)):
                pass
        assert first.get('/v1/sessions/' + session['sessionId']).status_code == 200


def test_startup_recovers_interrupted_job_and_removes_only_owned_orphan_media(settings):
    store = Store(settings)
    store.acquire()
    job_id = uuid4().hex
    owned_name, unrelated_name = uuid4().hex + '.upload', 'keep-user-file.txt'
    try:
        (store.folder('SIM') / 'media' / owned_name).write_bytes(b'synthetic orphan')
        (store.folder('SIM') / 'media' / unrelated_name).write_text('unrelated', encoding='utf8')
        with store.tx('SIM') as db:
            store.put(db, 'job', job_id, {'status': 'running', 'frameKey': 'missing'}, 'alice', 'synthetic-session', 'run')
    finally:
        store.close()
    store.acquire()
    try:
        with store.tx('SIM') as db:
            job = store.get(db, 'job', job_id)['payload']
            assert job['status'] == 'failed' and job['errorCode'] == 'worker_interrupted'
        assert not (store.folder('SIM') / 'media' / owned_name).exists()
        assert (store.folder('SIM') / 'media' / unrelated_name).exists()
    finally:
        store.close()


def test_media_quota_rejects_upload_and_cleans_partial_file(settings, credentials):
    headers = {'authorization': 'Bearer ' + credentials['alice']}
    with TestClient(create_app(replace(settings, max_media_bytes=1)), headers=headers) as client:
        session = new_session(client)
        client.post(base(session) + '/frames', json=metadata(session))
        response = client.put(base(session) + '/frames/frame-0/content', content=b'synthetic', headers={'content-type': 'image/png'})
        assert response.status_code == 507
        assert not list((client.app.state.engine.store.folder('REPLAY') / 'media').iterdir())


def test_private_media_paths_cannot_escape_partition(settings):
    store = Store(settings)
    for name in ('../escape', '..\\escape', '/absolute', 'folder/name'):
        with pytest.raises(Exception):
            store.path('SIM', name)
