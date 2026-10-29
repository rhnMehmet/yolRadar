from concurrent.futures import ThreadPoolExecutor
import threading
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.sessions import Review, fingerprint
from app.contracts import ApiError, wire
from conftest import base, new_session, submit, wait_job
from test_review_queries import review_env, reviewer_base, seed_video

def targets(api,session,header):
    item=api.get(reviewer_base(session)+'/candidates',headers=header).json()['items'][0]
    return item,base(session)+'/events/'+item['eventId']+'/review','/v1/candidates/'+item['candidateId']+'/review'

@pytest.mark.parametrize('first,second',[('event-approve','candidate-reject'),('event-reject','candidate-approve'),('candidate-reject','event-approve')])
def test_cross_endpoint_terminal_decision_cannot_be_overwritten(review_env,first,second):
    api,h,_=review_env;session=seed_video(api);item,event_url,candidate_url=targets(api,session,h['reviewer'])
    entity,decision=first.split('-');response=api.post(event_url if entity=='event' else candidate_url,headers=h['reviewer'],json={'commandId':'first','decision':decision,'expectedReviewRevision':0})
    assert response.status_code==200,response.text
    entity,decision=second.split('-');body={'commandId':'second','decision':decision}
    if decision=='approve' and entity=='candidate':body['damageLocation']={'kind':'UNKNOWN'}
    assert api.post(event_url if entity=='event' else candidate_url,headers=h['reviewer-two'],json=body).status_code==409
    current=api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).json()['items'][0]
    assert current['reviewStatus']==('approved' if first=='event-approve' else 'rejected') and current['reviewRevision']==1

@pytest.mark.parametrize('endpoint',['event','candidate'])
def test_receipt_idempotency_revision_and_payload_conflicts(review_env,endpoint):
    api,h,_=review_env;session=seed_video(api);item,event_url,candidate_url=targets(api,session,h['reviewer']);url=event_url if endpoint=='event' else candidate_url
    body={'commandId':'same','decision':'reject','expectedReviewRevision':0}
    assert api.post(url,headers=h['reviewer'],json={**body,'expectedReviewRevision':5}).status_code==409
    first=api.post(url,headers=h['reviewer'],json=body);assert first.status_code==200
    assert api.post(url,headers=h['reviewer'],json=body).json()==first.json()
    assert api.post(url,headers=h['reviewer'],json={**body,'decision':'approve'}).status_code==409
    assert api.post(url,headers=h['reviewer'],json={**body,'commandId':'other'}).status_code==409
    other=candidate_url if endpoint=='event' else event_url
    assert api.post(other,headers=h['reviewer'],json=body).status_code==409
    with api.app.state.engine.store.tx('REPLAY') as db:assert len(api.app.state.engine.store.find(db,'review-audit'))==1

def test_content_approval_never_invents_location_or_snapshot_history(review_env):
    api,h,_=review_env;session=seed_video(api);item,event_url,candidate_url=targets(api,session,h['reviewer'])
    assert api.post(event_url,headers=h['reviewer'],json={'commandId':'content','decision':'approve'}).status_code==200
    assert api.post(candidate_url,headers=h['reviewer'],json={'commandId':'no-location','decision':'approve'}).status_code==422
    snapshot=api.get('/v1/candidates').json()['items'][0]
    assert snapshot['candidate']['reviewStatus']=='pending' and snapshot['reviewDecision']=='pending'
    current=api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).json()['items'][0]
    assert current['reviewStatus']=='approved' and current['locationStatus']=='UNKNOWN' and 'verifiedDamage' not in current
    assert current['reviewerId']=='reviewer' and current['reviewScope']=='CONTENT'

@pytest.mark.parametrize('cross',[False,True])
def test_two_reviewers_race_one_atomic_winner(review_env,cross):
    api,h,settings=review_env;session=seed_video(api);item,_,_=targets(api,session,h['reviewer']);engine=api.app.state.engine
    principals={p.id:p for p in settings.principals};barrier=threading.Barrier(2)
    def run(actor,decision,candidate=False):
        barrier.wait()
        try:
            req=Review(commandId=actor,decision=decision,expectedReviewRevision=0)
            if candidate:engine.review_candidate(principals[actor],item['candidateId'],req)
            else:engine.review_event(principals[actor],session['sessionId'],session['runId'],item['eventId'],req)
            return 200
        except ApiError as e:return e.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(run,'reviewer','approve');b=pool.submit(run,'reviewer-two','reject',cross)
        assert sorted([a.result(),b.result()])==[200,409]
    current=api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).json()['items'][0]
    assert current['reviewRevision']==1
    with engine.store.tx('REPLAY') as db:assert len(engine.store.find(db,'review-audit'))==1

@pytest.mark.parametrize('failed_kind',['review-audit','review-state','command'])
def test_audit_failure_rolls_back_decision_and_receipt(review_env,monkeypatch,failed_kind):
    api,h,_=review_env;session=seed_video(api);item,event_url,_=targets(api,session,h['reviewer']);store=api.app.state.engine.store;original=store.put
    def fail(db,kind,*args):
        if kind==failed_kind and (kind!='command' or 'response' in args[1]):
            raise RuntimeError('SYNTHETIC_AUDIT_FAILURE')
        return original(db,kind,*args)
    with monkeypatch.context() as m:
        m.setattr(store,'put',fail)
        with pytest.raises(RuntimeError):api.post(event_url,headers=h['reviewer'],json={'commandId':'rollback','decision':'approve'})
    current=api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).json()['items'][0]
    assert current['reviewStatus']=='pending' and current['reviewRevision']==0
    with store.tx('REPLAY') as db:assert store.find(db,'review-audit')==[] and store.find(db,'review-state')==[]
    assert api.post(event_url,headers=h['reviewer'],json={'commandId':'rollback','decision':'approve'}).status_code==200

def test_late_old_run_decision_rejected(review_env):
    api,h,_=review_env;session=seed_video(api);_,url,candidate=targets(api,session,h['reviewer'])
    api.post('/v1/sessions/'+session['sessionId']+'/runs',json={'commandId':'new-run','expectedRunId':session['runId']})
    for target in [url,candidate]:assert api.post(target,headers=h['reviewer'],json={'commandId':'late','decision':'reject'}).status_code==409

def test_restart_preserves_audit_and_idempotent_receipt(settings,credentials):
    headers={'authorization':'Bearer '+credentials['alice']}
    with TestClient(create_app(settings),headers=headers) as api:
        session=new_session(api);assert wait_job(api,submit(api,session))['status']=='succeeded'
        event=api.get(base(session)+'/timeline').json()['events'][0]
        url=base(session)+'/events/'+event['eventId']+'/review';body={'commandId':'persist','decision':'approve'}
        first=api.post(url,json=body);assert first.status_code==200
        before=api.get(reviewer_base(session)+'/candidates').json()['items'][0]
    with TestClient(create_app(settings),headers=headers) as api:
        after=api.get(reviewer_base(session)+'/candidates').json()['items'][0]
        assert after==before and after['reviewRevision']==1
        assert api.post(url,json=body).json()==first.json()

def test_legacy_terminal_record_has_no_fabricated_audit(review_env):
    api,h,settings=review_env;session=seed_video(api);item,event_url,_=targets(api,session,h['reviewer']);engine=api.app.state.engine
    req=Review(commandId='legacy',decision='approve');principal=next(p for p in settings.principals if p.id=='reviewer')
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'event',item['eventId']);row['payload']['reviewStatus']='approved'
        engine.store.put(db,'event',row['id'],row['payload'],row['owner'],row['sid'],row['run'])
        key=fingerprint([principal.id,session['sessionId'],session['runId'],'event-review',req.commandId])
        engine.store.put(db,'command',key,{'hash':fingerprint([item['eventId'],wire(req)])},principal.id,row['sid'],row['run'])
    result=api.get(reviewer_base(session)+'/candidates',headers=h['reviewer']).json()['items'][0]
    assert result['reviewRevision']==0 and 'reviewerId' not in result and 'reviewedAt' not in result
    assert api.post(event_url,headers=h['reviewer'],json=wire(req)).status_code==200
