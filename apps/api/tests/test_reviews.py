from conftest import base, new_session, submit, wait_job


def test_unknown_location_video_event_can_be_approved_without_map_damage(api):
    session = new_session(api)
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    event = api.get(base(session) + '/timeline').json()['events'][0]
    request = {'commandId': 'review-video-event', 'decision': 'approve'}
    url = base(session) + '/events/' + event['eventId'] + '/review'
    assert api.post(url, json=request).json()['event']['reviewStatus'] == 'approved'
    assert api.post(url, json=request).status_code == 200
    candidate = api.get('/v1/candidates').json()['items'][0]['candidate']
    result = api.post('/v1/candidates/' + candidate['candidateId'] + '/review', json={'commandId': 'no-fabrication', 'decision': 'approve'})
    assert result.status_code == 422
    assert result.json()['error']['code'] == 'damage_location_required_for_verification'
    with api.app.state.engine.store.tx('REPLAY') as db:
        assert api.app.state.engine.store.find(db, 'verified') == []


def test_sim_candidate_human_approval_preserves_test_and_sim_domains(api):
    session = new_session(api, 'SIM')
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    candidate = api.get('/v1/candidates').json()['items'][0]['candidate']
    request = {'commandId': 'human-location', 'decision': 'approve', 'damageLocation': {
        'kind': 'ESTIMATED', 'position': {'kind': 'SIM_LOCAL', 'frameId': 'synthetic-world', 'units': 'm', 'x': 1, 'y': 2, 'z': 0},
        'uncertaintyM': 2, 'method': 'HUMAN_PLACEMENT'}}
    url = '/v1/candidates/' + candidate['candidateId'] + '/review'
    response = api.post(url, json=request)
    assert response.status_code == 200, response.text
    verified = response.json()['item']['verifiedDamage']
    assert verified['sourceDomain'] == 'SIM' and verified['detectorKind'] == 'TEST'
    assert verified['review']['reviewerId'] == 'alice'
    assert api.post(url, json=request).json() == response.json()
    request['damageLocation']['position']['x'] = 3
    assert api.post(url, json=request).status_code == 409


def test_rejection_is_reflected_in_summary_and_duplicate_review_does_not_duplicate(api):
    session = new_session(api)
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    candidate = api.get('/v1/candidates').json()['items'][0]['candidate']
    url = '/v1/candidates/' + candidate['candidateId'] + '/review'
    request = {'commandId': 'reject', 'decision': 'reject'}
    first = api.post(url, json=request)
    assert first.status_code == 200
    assert api.post(url, json=request).json() == first.json()
    summary = api.get(base(session) + '/summary').json()['summary']
    assert summary['totalEvents'] == 0 and summary['rawObservationCount'] == 1


def test_non_reviewer_cannot_review_or_see_another_users_candidates(api, credentials):
    session = new_session(api)
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    candidate = api.get('/v1/candidates').json()['items'][0]['candidate']
    headers = {'authorization': 'Bearer ' + credentials['bob']}
    assert api.get('/v1/candidates', headers=headers).json()['items'] == []
    assert api.post('/v1/candidates/' + candidate['candidateId'] + '/review', json={'commandId': 'not-authorized', 'decision': 'reject'}, headers=headers).status_code == 403
