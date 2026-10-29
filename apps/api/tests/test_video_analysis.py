from conftest import base, metadata, new_session, submit, wait_job


def test_video_time_comes_from_frame_and_complete_requires_full_plan(api):
    session = new_session(api, videoDurationMs=1000)
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    event = api.get(base(session) + '/timeline').json()['events'][0]
    assert event['videoTimestampMs'] == event['lastVideoTimestampMs'] == 0
    assert api.post(base(session) + '/complete', json={'analysisStatus': 'completed'}).status_code == 200
    summary = api.get(base(session) + '/summary').json()['summary']
    assert summary['analysisStatus'] == 'completed' and summary['coverage']['status'] == 'complete'
    assert summary['totalEvents'] == summary['classCounts']['pothole'] == 1
    assert api.post(base(session) + '/frames', json=metadata(session, 'later', 0)).status_code == 409


def test_skipped_failed_and_unattempted_sampling_ranges_stay_incomplete(api):
    session = new_session(api)
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    api.post(base(session) + '/frames', json=metadata(session, 'skip', 1000))
    assert api.post(base(session) + '/frames/skip/skip').json()['status'] == 'skipped'
    assert wait_job(api, submit(api, session, 'bad', 2000, content=b'bad image'))['status'] == 'failed'
    assert api.post(base(session) + '/complete', json={'analysisStatus': 'completed'}).status_code == 422
    assert api.post(base(session) + '/complete', json={'analysisStatus': 'partial'}).status_code == 200
    value = api.get(base(session) + '/summary').json()['summary']
    assert value['analysisStatus'] == 'partial'
    coverage = value['coverage']
    assert [coverage['analyzedFrames'], coverage['skippedFrames'], coverage['failedFrames']] == [1, 1, 1]
    assert coverage['unanalysedRanges'] == [{'startMs': 1000, 'endMs': 4000}]


def test_explicit_reviewed_group_replaces_provisional_markers_without_double_counting(api):
    session = new_session(api, videoDurationMs=2000)
    for index in range(2):
        assert wait_job(api, submit(api, session, f'frame-{index}', index * 1000))['status'] == 'succeeded'
    before = api.get(base(session) + '/summary').json()['summary']
    assert before['totalEvents'] == before['rawObservationCount'] == 2
    ids = [event['observationIds'][0] for event in before['events']]
    request = {'commandId': 'group-synthetic-hazard', 'observationIds': ids}
    first = api.post(base(session) + '/events/group', json=request)
    assert first.status_code == 200, first.text
    assert api.post(base(session) + '/events/group', json=request).json() == first.json()
    after = api.get(base(session) + '/summary').json()['summary']
    assert after['totalEvents'] == 1 and after['rawObservationCount'] == 2
    assert after['events'][0]['lastVideoTimestampMs'] == 1000
    assert len(api.get('/v1/candidates').json()['items']) == 1


def test_distinct_simultaneous_hazards_cannot_be_merged(api):
    session = new_session(api, testProfile='synthetic_two')
    assert wait_job(api, submit(api, session))['status'] == 'succeeded'
    before = api.get(base(session) + '/summary').json()['summary']
    assert before['totalEvents'] == 2
    ids = [event['observationIds'][0] for event in before['events']]
    assert api.post(base(session) + '/events/group', json={'commandId': 'invalid-group', 'observationIds': ids}).status_code == 422
    assert api.get(base(session) + '/summary').json()['summary']['totalEvents'] == 2


def test_skipped_frame_is_terminal_and_cannot_later_be_uploaded(api):
    session = new_session(api)
    api.post(base(session) + '/frames', json=metadata(session))
    assert api.post(base(session) + '/frames/frame-0/skip').status_code == 200
    from conftest import image_bytes
    assert api.put(base(session) + '/frames/frame-0/content', content=image_bytes(), headers={'content-type': 'image/png'}).status_code == 409
