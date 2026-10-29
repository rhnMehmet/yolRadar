import pytest
from conftest import base, image_bytes, metadata, new_session, submit, wait_job
from test_review_queries import review_env, reviewer_base, seed_video

def test_evidence_is_private_exact_binary_and_no_store(review_env):
    api,h,_=review_env;session=seed_video(api);url=reviewer_base(session)+'/evidence/frame-pts'
    result=api.get(url,headers=h['reviewer'])
    assert result.status_code==200 and result.content==image_bytes()
    assert result.headers['content-type']=='image/png' and result.headers['cache-control']=='no-store' and result.headers['x-content-type-options']=='nosniff'
    assert 'evidence.png' in result.headers['content-disposition']
    assert api.get(url,headers={'authorization':''}).status_code==401
    assert api.get(url,headers=h['bob']).status_code==403
    assert api.get(url,headers=h['real-reviewer']).status_code==404
    assert api.get(url+'?token=NOT_A_CREDENTIAL',headers=h['reviewer']).status_code==422

@pytest.mark.parametrize('frame_id',['..%2F..%2Fsecret','%2e%2e','C%3A%5Cprivate.key','not-owned'])
def test_path_and_unknown_frame_are_rejected(review_env,frame_id):
    api,h,_=review_env;session=seed_video(api)
    result=api.get(reviewer_base(session)+'/evidence/'+frame_id,headers=h['reviewer'])
    assert result.status_code in (404,422) and b'PRIVATE' not in result.content

def test_frame_identity_cannot_cross_session_or_run(review_env):
    api,h,_=review_env;session=seed_video(api);other=new_session(api)
    assert api.get(reviewer_base(other)+'/evidence/frame-pts',headers=h['reviewer']).status_code==404
    api.post('/v1/sessions/'+session['sessionId']+'/runs',json={'commandId':'rotate-media','expectedRunId':session['runId']})
    assert api.get(reviewer_base(session)+'/evidence/frame-pts',headers=h['reviewer']).status_code==409

def test_unvalidated_or_tampered_media_is_not_served(review_env):
    from app.sessions import frame_key
    api,h,_=review_env;session=new_session(api)
    api.post(base(session)+'/frames',json={**metadata(session),'frame':metadata(session)['frame']})
    assert api.get(reviewer_base(session)+'/evidence/frame-0',headers=h['reviewer']).status_code==404
    session=seed_video(api);engine=api.app.state.engine;url=reviewer_base(session)+'/evidence/frame-pts'
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'frame',frame_key(session,'frame-pts'));row['payload']['mediaName']='../../private.key'
        engine.store.put(db,'frame',row['id'],row['payload'],row['owner'],row['sid'],row['run'])
    assert api.get(url,headers=h['reviewer']).status_code==404

def test_jpeg_binary_and_digest_tampering(review_env):
    from app.sessions import frame_key
    api,h,_=review_env;session=new_session(api);content=image_bytes(fmt='JPEG')
    assert wait_job(api,submit(api,session,content=content,mime='image/jpeg'))['status']=='succeeded'
    url=reviewer_base(session)+'/evidence/frame-0'
    response=api.get(url,headers=h['reviewer'])
    assert response.status_code==200 and response.content==content and response.headers['content-type']=='image/jpeg'
    engine=api.app.state.engine
    with engine.store.tx('REPLAY') as db:
        row=engine.store.get(db,'frame',frame_key(session,'frame-0'))
        path=engine.store.path('REPLAY',row['payload']['mediaName'])
    path.write_bytes(b'SYNTHETIC_CORRUPTED_BYTES')
    assert api.get(url,headers=h['reviewer']).status_code==404
