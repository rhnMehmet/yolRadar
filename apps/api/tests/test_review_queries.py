from dataclasses import replace
import secrets
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.security import Principal
from conftest import base, image_bytes, metadata, new_session, submit, wait_job

import json
from pathlib import Path
from pydantic import ValidationError
from app.contracts import ApiError
from app.review_queries import ReviewItem, ReviewSession, ReviewFrame, ReviewSummary

PARITY_CASES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/fixtures/m4-review-cases.json').read_text(encoding='utf-8'))['cases']

@pytest.mark.parametrize('case', PARITY_CASES, ids=lambda c: c['id'])
def test_review_contract_parity(case):
    accepted = True
    try:
        {'session':ReviewSession,'item':ReviewItem,'frame':ReviewFrame,'summary':ReviewSummary}[case['kind']].model_validate(case['value'])
    except (ValueError, ValidationError, ApiError):
        accepted = False
    assert accepted == case['valid']
    item = case['value']
    eligible = accepted and case['kind'] == 'item' and item['reviewStatus'] == 'approved' and item['locationStatus'] == 'VERIFIED' and item.get('verifiedDamage', {}).get('damageLocation', {}).get('position', {}).get('kind') == 'GPS'
    assert eligible == case['mapEligibleTest']
    assert case['mapEligibleProduction'] is False

@pytest.fixture
def review_env(settings, credentials):
    tokens = {name: secrets.token_urlsafe(32) for name in ('reviewer','reviewer-two','real-reviewer')}
    configured = replace(settings, principals=settings.principals + tuple(Principal.create(name, token,
        domains=('REAL',) if name == 'real-reviewer' else ('REPLAY',), reviewer=True) for name,token in tokens.items()))
    headers = {name:{'authorization':'Bearer '+token} for name,token in {**credentials,**tokens}.items()}
    with TestClient(create_app(configured), headers=headers['bob']) as client:
        yield client, headers, configured

def reviewer_base(session):
    return '/v1/review' + base(session).removeprefix('/v1')

def seed_video(client, profile='synthetic_one'):
    session = new_session(client, contractVersion=2, testProfile=profile)
    value = metadata(session,'frame-pts',1001.001001001001)
    value['frame']['plannedSampleTimestampMs'] = 1000
    assert client.post(base(session)+'/frames',json=value).status_code == 201
    response = client.put(base(session)+'/frames/frame-pts/content',content=image_bytes(),headers={'content-type':'image/png'})
    assert wait_job(client,response.json())['status'] == 'succeeded'
    return session

def test_reviewer_reads_other_owner_but_owner_endpoints_stay_private(review_env):
    api,h,_ = review_env; session = seed_video(api)
    assert api.get('/v1/review/sessions',headers=h['reviewer']).status_code == 200
    result = api.get(reviewer_base(session)+'/candidates',headers=h['reviewer'])
    assert result.status_code == 200, result.text
    item = result.json()['items'][0]
    assert item['videoTimestampMs'] == 1001.001001001001 and item['reviewRevision'] == 0
    assert item['frameId'] == 'frame-pts' and item['sourceDomain'] == 'REPLAY' and item['resultOrigin'] == 'TEST_SYNTHETIC'
    assert item['evidence'][0]['available'] and item['locationStatus'] == 'UNKNOWN'
    assert 'reviewedAt' not in item and 'reviewerId' not in item and 'verifiedDamage' not in item
    assert api.get('/v1/sessions/'+session['sessionId'],headers=h['reviewer']).status_code == 404
    assert api.get(base(session)+'/summary',headers=h['reviewer']).status_code == 404
    assert api.get(reviewer_base(session)+'/candidates',headers=h['real-reviewer']).status_code == 404

@pytest.mark.parametrize('route',['/sessions','/map-damages'])
def test_missing_identity_and_producer_do_not_get_reviewer_access(review_env,route):
    api,h,_=review_env
    assert api.get('/v1/review'+route,headers={'authorization':''}).status_code == 401
    assert api.get('/v1/review'+route,headers=h['bob']).status_code == 403
    assert api.get('/v1/review'+route+'?reviewer=true',headers=h['bob']).status_code == 403

def test_stable_session_pages_cursor_scope_and_filters(review_env):
    api,h,_=review_env
    sessions=[new_session(api) for _ in range(3)]
    first=api.get('/v1/review/sessions?limit=1',headers=h['reviewer']).json()
    cursor=first['nextCursor']; assert cursor
    ids=[first['items'][0]['session']['sessionId']]
    while cursor:
        result=api.get('/v1/review/sessions',params={'limit':1,'cursor':cursor},headers=h['reviewer'])
        assert result.status_code == 200
        ids.extend(x['session']['sessionId'] for x in result.json()['items']);cursor=result.json()['nextCursor']
    assert ids == sorted(s['sessionId'] for s in sessions) and len(set(ids))==3
    for changes in [{'cursor':first['nextCursor']+'x'}, {'cursor':first['nextCursor'],'status':'cancelled'}, {'cursor':first['nextCursor'],'limit':2}]:
        assert api.get('/v1/review/sessions',params={'limit':1,**changes},headers=h['reviewer']).status_code == 422
    assert api.get('/v1/review/sessions',params={'limit':1,'cursor':first['nextCursor']},headers=h['reviewer-two']).status_code == 422
    assert api.get('/v1/review/sessions?detectorKind=YOLO',headers=h['reviewer']).json()['items']==[]

def test_pagination_cutoff_excludes_new_sessions(review_env):
    api,h,_=review_env
    before=[new_session(api) for _ in range(2)]
    page=api.get('/v1/review/sessions?limit=1',headers=h['reviewer']).json()
    later=new_session(api)
    next_page=api.get('/v1/review/sessions',params={'limit':1,'cursor':page['nextCursor']},headers=h['reviewer']).json()
    ids=[page['items'][0]['session']['sessionId'],next_page['items'][0]['session']['sessionId']]
    assert set(ids)=={s['sessionId'] for s in before} and later['sessionId'] not in ids
    assert next_page['nextCursor'] is None

@pytest.mark.parametrize('query',['limit=0','limit=101','status=invalid','ownerId=bob','reviewer=true','token=NOT_A_CREDENTIAL','limit=1&limit=2','canonicalClass=pothole'])
def test_session_filters_are_bounded_and_cannot_claim_identity(review_env,query):
    api,h,_=review_env
    assert api.get('/v1/review/sessions?'+query,headers=h['reviewer']).status_code == 422

def test_environment_and_domain_filters_cannot_expand_scope(review_env):
    api,h,_=review_env
    assert api.get('/v1/review/sessions?environment=PRODUCTION',headers=h['reviewer']).status_code == 403
    assert api.get('/v1/review/sessions?sourceDomain=REAL',headers=h['reviewer']).status_code == 403

def test_candidate_pages_include_rejected_events_and_preserve_pts(review_env):
    api,h,_=review_env; session=seed_video(api,'synthetic_two');url=reviewer_base(session)+'/candidates'
    first=api.get(url+'?limit=1',headers=h['reviewer']).json()
    second=api.get(url,params={'limit':1,'cursor':first['nextCursor']},headers=h['reviewer']).json()
    assert len(first['items'])==len(second['items'])==1 and first['items'][0]['candidateId']!=second['items'][0]['candidateId']
    item=first['items'][0]
    assert api.post(base(session)+'/events/'+item['eventId']+'/review',json={'commandId':'reject','decision':'reject','expectedReviewRevision':0},headers=h['reviewer']).status_code==200
    result=api.get(url+'?status=rejected',headers=h['reviewer']).json()['items']
    assert len(result)==1 and result[0]['reviewRevision']==1 and result[0]['reviewerId']=='reviewer'
    assert result[0]['videoTimestampMs']==1001.001001001001
    assert api.get(base(session)+'/summary').json()['summary']['totalEvents']==1
    assert api.get(url+'?canonicalClass=pothole',headers=h['reviewer']).status_code==200
    assert api.get(url+'?ownerId=bob',headers=h['reviewer']).status_code==422

def test_old_run_is_not_a_reviewer_backdoor(review_env):
    api,h,_=review_env; session=seed_video(api)
    new=api.post('/v1/sessions/'+session['sessionId']+'/runs',json={'commandId':'rotate','expectedRunId':session['runId']}).json()['session']
    assert api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).status_code==409
    assert api.get(reviewer_base(new)+'/candidates',headers=h['reviewer']).json()['items']==[]

def test_map_defaults_empty_production_and_only_explicit_test_gps_verified(review_env):
    api,h,_=review_env
    session=seed_video(api)
    event=api.get(base(session)+'/timeline').json()['events'][0]
    api.post(base(session)+'/events/'+event['eventId']+'/review',headers=h['reviewer'],json={'commandId':'approve-content','decision':'approve'})
    assert api.get('/v1/review/map-damages?layer=test',headers=h['reviewer']).json()['items']==[]
    api.headers.update(h['alice']); real=new_session(api,'REAL');assert wait_job(api,submit(api,real))['status']=='succeeded'
    candidate=next(i['candidate'] for i in api.get('/v1/candidates').json()['items'] if i['candidate']['sessionId']==real['sessionId'])
    response=api.post('/v1/candidates/'+candidate['candidateId']+'/review',headers=h['real-reviewer'],json={'commandId':'synthetic-location','decision':'approve',
        'damageLocation':{'kind':'ESTIMATED','position':{'kind':'GPS','latitude':37.5,'longitude':30.5,'accuracyM':5},'uncertaintyM':10,'method':'HUMAN_PLACEMENT'}})
    assert response.status_code==200,response.text
    test=api.get('/v1/review/map-damages?layer=test&sourceDomain=REAL',headers=h['real-reviewer'])
    assert test.status_code==200,test.text
    item=test.json()['items'][0]
    assert item['environment']=='TEST' and item['resultOrigin']=='TEST_SYNTHETIC' and item['locationStatus']=='VERIFIED'
    assert item['reviewScope']=='LOCATION' and item['reviewRevision']==1
    assert api.get('/v1/review/map-damages?sourceDomain=REAL',headers=h['real-reviewer']).json()['items']==[]
    assert api.get('/v1/review/map-damages?environment=PRODUCTION',headers=h['real-reviewer']).status_code==403
