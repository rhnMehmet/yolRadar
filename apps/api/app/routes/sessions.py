from fastapi import APIRouter, Depends, Request
from ..contracts import Id
from ..security import Principal, authenticate
from ..sessions import CreateSession, FrameMetadata, NewRun

router = APIRouter(prefix='/v1', tags=['sessions and frames'])


@router.post('/sessions', status_code=201)
def create(payload: CreateSession, request: Request, principal: Principal = Depends(authenticate)):
    return {'session': request.app.state.engine.create(principal, payload), 'resultLabel': 'TEST_SYNTHETIC'}


@router.get('/sessions/{sessionId}')
def get(sessionId: Id, request: Request, principal: Principal = Depends(authenticate)):
    _, row = request.app.state.engine.locate(principal, sessionId)
    return {'session': row['payload']['session'], 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/sessions/{sessionId}/runs')
def run(sessionId: Id, payload: NewRun, request: Request, principal: Principal = Depends(authenticate)):
    return {'session': request.app.state.engine.new_run(principal, sessionId, payload), 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/sessions/{sessionId}/cancel')
def cancel(sessionId: Id, request: Request, principal: Principal = Depends(authenticate)):
    return {'session': request.app.state.engine.cancel(principal, sessionId), 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/sessions/{sessionId}/runs/{runId}/frames', status_code=201)
def register(sessionId: Id, runId: Id, payload: FrameMetadata, request: Request, principal: Principal = Depends(authenticate)):
    return request.app.state.engine.register(principal, sessionId, runId, payload)


@router.put('/sessions/{sessionId}/runs/{runId}/frames/{frameId}/content', status_code=202,
    openapi_extra={'requestBody': {'required': True, 'content': {'image/jpeg': {'schema': {'type': 'string', 'format': 'binary'}}, 'image/png': {'schema': {'type': 'string', 'format': 'binary'}}}}})
async def upload(sessionId: Id, runId: Id, frameId: Id, request: Request, principal: Principal = Depends(authenticate)):
    return await request.app.state.engine.upload(principal, sessionId, runId, frameId, request)


@router.post('/sessions/{sessionId}/runs/{runId}/frames/{frameId}/skip')
def skip(sessionId: Id, runId: Id, frameId: Id, request: Request, principal: Principal = Depends(authenticate)):
    return request.app.state.engine.skip(principal, sessionId, runId, frameId)


@router.get('/jobs/{jobId}')
def job(jobId: Id, request: Request, principal: Principal = Depends(authenticate)):
    return request.app.state.engine.get_job(principal, jobId)
