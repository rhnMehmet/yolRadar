"""Only synthetic frames and ephemeral test principals; no live API/data."""
import copy
import threading
from concurrent.futures import ThreadPoolExecutor
import pytest
from conftest import base, new_session, metadata
from test_review_queries import review_env, reviewer_base, seed_video
from app.contracts import wire
from app.review_queries import ReviewFrame, ReviewSummary
from app.sessions import frame_key, Review
from app.video import make_event

def item_url(api,session,h):
    item=api.get(reviewer_base(session)+'/candidates',headers=h).json()['items'][0]
    return item,reviewer_base(session)+'/candidates/'+item['candidateId']+'/evidence'

def test_metadata_uses_only_selected_candidate_boxes_and_pts(review_env):
    api,h,_=review_env; s=seed_video(api,'synthetic_two');item,url=item_url(api,s,h['reviewer'])
    response=api.get(url,headers=h['reviewer']);assert response.status_code==200,response.text
    data=response.json();assert data['observationCount']==data['frameCount']==1 and data['nextCursor'] is None
    f=data['items'][0];ReviewFrame.model_validate(f)
    assert f['candidateId']==item['candidateId'] and f['frame']['capturedAt']['valueMs']==1001.001001001001
    assert [o['observationId'] for o in f['observations']]==item['observationIds']
    assert all(o['canonicalClass']==item['canonicalClass'] and 0<o['box']['width']<=1 for o in f['observations'])
    assert 'mediaName' not in response.text and 'sha256' not in response.text

@pytest.mark.parametrize('suffix',['/summary','/candidates/unknown/evidence'])
def test_details_require_reviewer_and_scope(review_env,suffix):
    api,h,_=review_env;s=seed_video(api);url=reviewer_base(s)+suffix
    for actor,status in [('bob',403),('real-reviewer',404)]:assert api.get(url,headers=h[actor]).status_code==status
    assert api.get(url,headers={'authorization':''}).status_code==401
    assert api.get(url+'?reviewer=true',headers=h['reviewer']).status_code==422
    assert api.get(url+'?environment=PRODUCTION',headers=h['reviewer']).status_code==403

def test_candidate_and_old_run_cannot_cross_scope(review_env):
    api,h,_=review_env;s=seed_video(api);item,url=item_url(api,s,h['reviewer']);other=new_session(api)
    assert api.get(reviewer_base(other)+'/candidates/'+item['candidateId']+'/evidence',headers=h['reviewer']).status_code==404
    api.post('/v1/sessions/'+s['sessionId']+'/runs',json={'commandId':'rotate-detail','expectedRunId':s['runId']})
    assert api.get(url,headers=h['reviewer']).status_code==409
    assert api.get(reviewer_base(s)+'/summary',headers=h['reviewer']).status_code==409

def test_reviewer_summary_keeps_rejected_separate_from_owner_summary(review_env):
    api,h,_=review_env;s=seed_video(api,'synthetic_two');item,_=item_url(api,s,h['reviewer'])
    api.post(base(s)+'/events/'+item['eventId']+'/review',headers=h['reviewer'],json={'commandId':'reject-summary','decision':'reject'})
    result=api.get(reviewer_base(s)+'/summary',headers=h['reviewer']);assert result.status_code==200,result.text
    v=result.json();ReviewSummary.model_validate(v)
    assert v['totalEvents']==2 and v['includedEvents']==1 and v['reviewCounts']=={'pending':1,'approved':0,'rejected':1}
    assert v['locationCounts']=={'UNKNOWN':2,'ESTIMATED':0,'VERIFIED':0}
    assert v['slots']=={'planned':4,'analyzed':1,'skipped':0,'failed':0,'unattempted':3}
    assert api.get(base(s)+'/summary').json()['summary']['totalEvents']==1
    assert v['firstDamageTimestampMs']==1001.001001001001 and v['verifiedCount']==0

def test_empty_summary_and_metadata_filter_bounds(review_env):
    api,h,_=review_env;s=new_session(api)
    v=api.get(reviewer_base(s)+'/summary',headers=h['reviewer']).json();ReviewSummary.model_validate(v)
    assert v['firstDamageTimestampMs'] is None and v['slots']['unattempted']==4
    s=seed_video(api);_,url=item_url(api,s,h['reviewer'])
    for query in ['limit=0','limit=101','limit=1&limit=2','cursor=wrong','frameId=other','token=NOT_A_CREDENTIAL']:
        assert api.get(url+'?'+query,headers=h['reviewer']).status_code==422

def test_long_group_pages_preserve_twenty_frame_cap(review_env):
    api,h,_=review_env;s=seed_video(api);item,url=item_url(api,s,h['reviewer']);engine=api.app.state.engine
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'session',s['sessionId']);s=row['payload']['session'];s['videoDurationMs']=30000
        engine.store.put(db,'session',row['id'],row['payload'],row['owner'],row['sid'],row['run'])
        candidate=engine.store.get(db,'candidate',item['candidateId']);first=engine.store.get(db,'observation',item['observationIds'][0]);packet=engine.store.get(db,'frame',frame_key(s,'frame-pts'))
        observations=[first['payload']]
        for i in range(1,23):
            obs=copy.deepcopy(first['payload']);obs.update(observationId='group-obs-'+str(i),frameId='group-frame-'+str(i));obs['capturedAt']['valueMs']=i*1000+1
            data=copy.deepcopy(packet['payload']);data['frame']['frameId']=obs['frameId'];data['frame']['capturedAt']=obs['capturedAt'];data['frame']['plannedSampleTimestampMs']=i*1000
            engine.store.put(db,'observation',obs['observationId'],obs,row['owner'],row['sid'],row['run']);engine.store.put(db,'frame',frame_key(s,obs['frameId']),data,row['owner'],row['sid'],row['run']);observations.append(obs)
        refs=[o['observationId'] for o in observations];candidate['payload']['candidate']['observationIds']=refs
        engine.store.put(db,'candidate',candidate['id'],candidate['payload'],row['owner'],row['sid'],row['run'])
        event=make_event(s,item['eventId'],refs,observations);engine.store.put(db,'event',event['eventId'],event,row['owner'],row['sid'],row['run'])
    one=api.get(url+'?limit=100',headers=h['reviewer']).json();assert len(one['items'])==20 and one['frameCount']==23 and one['nextCursor']
    two=api.get(url,params={'limit':100,'cursor':one['nextCursor']},headers=h['reviewer']).json();assert len(two['items'])==3 and two['nextCursor'] is None
    assert len({o['observationId'] for p in (one,two) for f in p['items'] for o in f['observations']})==23
    assert api.get(url,params={'limit':99,'cursor':one['nextCursor']},headers=h['reviewer']).status_code==422
    assert api.get(url,params={'limit':100,'cursor':one['nextCursor']},headers=h['reviewer-two']).status_code==422

def test_summary_is_one_snapshot_during_concurrent_review(review_env,monkeypatch):
    api,h,settings=review_env;s=seed_video(api);item,_=item_url(api,s,h['reviewer']);engine=api.app.state.engine
    original=engine.store.find;started=threading.Event();future=[]
    reviewer=next(p for p in settings.principals if p.id=='reviewer-two')
    with ThreadPoolExecutor(max_workers=1) as pool:
        def find(db,kind,**kwargs):
            result=original(db,kind,**kwargs)
            if kind=='event' and not started.is_set():
                started.set();future.append(pool.submit(engine.review_event,reviewer,s['sessionId'],s['runId'],item['eventId'],Review(commandId='concurrent-summary',decision='reject')))
            return result
        with monkeypatch.context() as m:
            m.setattr(engine.store,'find',find)
            before=api.get(reviewer_base(s)+'/summary',headers=h['reviewer']).json()
        assert before['reviewCounts']['pending']==before['includedEvents']==1
        future[0].result(timeout=10)
    after=api.get(reviewer_base(s)+'/summary',headers=h['reviewer']).json()
    assert after['reviewCounts']['rejected']==1 and after['includedEvents']==0

def test_exact_candidate_filter_does_not_broaden_session_scope(review_env):
    api,h,_=review_env;s=seed_video(api,'synthetic_two');item,_=item_url(api,s,h['reviewer']);other=new_session(api)
    response=api.get(reviewer_base(s)+'/candidates',params={'candidateId':item['candidateId']},headers=h['reviewer'])
    assert [i['candidateId'] for i in response.json()['items']]==[item['candidateId']]
    assert api.get(reviewer_base(other)+'/candidates',params={'candidateId':item['candidateId']},headers=h['reviewer']).json()['items']==[]

def test_skipped_failed_unattempted_are_distinct(review_env):
    api,h,_=review_env;s=seed_video(api)
    for fid,planned in [('skipped-slot',0),('failed-slot',2000)]:
        m=metadata(s,fid,planned+1);m['frame']['plannedSampleTimestampMs']=planned
        assert api.post(base(s)+'/frames',json=m).status_code==201
    assert api.post(base(s)+'/frames/skipped-slot/skip').status_code==200
    engine=api.app.state.engine
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'frame',frame_key(s,'failed-slot'));row['payload']['outcome']='failed'
        engine.store.put(db,'frame',row['id'],row['payload'],row['owner'],row['sid'],row['run'])
    result=api.get(reviewer_base(s)+'/summary',headers=h['reviewer']);assert result.status_code==200,result.text
    assert result.json()['slots']=={'planned':4,'analyzed':1,'skipped':1,'failed':1,'unattempted':1}

@pytest.mark.parametrize('corruption',['owner','run','box','pts'])
def test_corrupt_observation_cannot_be_returned_as_selected_evidence(review_env,corruption):
    api,h,_=review_env;s=seed_video(api);item,url=item_url(api,s,h['reviewer']);engine=api.app.state.engine
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'observation',item['observationIds'][0]);payload=row['payload']
        if corruption in ('owner','run'):
            db.execute('UPDATE records SET '+corruption+'=? WHERE kind=? AND id=?',('wrong','observation',row['id']))
        else:
            if corruption=='box':payload['box']['width']=2
            else:payload['capturedAt']['valueMs']+=1
            engine.store.put(db,'observation',row['id'],payload,row['owner'],row['sid'],row['run'])
    assert api.get(url,headers=h['reviewer']).status_code==422

def test_maximum_response_is_measured_in_utf8_bytes():
    from app.review_queries import bounded_review
    from app.contracts import ApiError
    with pytest.raises(ApiError) as error:bounded_review({'synthetic':'ğ'*(1024*1024)})
    assert error.value.status==413
