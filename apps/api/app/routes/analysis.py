from fastapi import APIRouter, Depends, Request
from ..contracts import Id
from ..security import Principal, authenticate
from ..sessions import Completion, GroupEvents, Review

router = APIRouter(prefix='/v1/sessions/{sessionId}/runs/{runId}', tags=['video analysis'])


@router.get('/timeline')
def timeline(sessionId: Id, runId: Id, request: Request, principal: Principal = Depends(authenticate)):
    _, events, _, _ = request.app.state.engine.video_data(principal, sessionId, runId)
    return {'events': sorted(events, key=lambda item: (item['videoTimestampMs'], item['eventId'])),
        'resultLabel': 'TEST_SYNTHETIC', 'trackingStatus': 'NO_PHYSICAL_TRACKER'}


@router.get('/summary')
def summary(sessionId: Id, runId: Id, request: Request, principal: Principal = Depends(authenticate)):
    return request.app.state.engine.summary(principal, sessionId, runId)


@router.post('/complete')
def complete(sessionId: Id, runId: Id, payload: Completion, request: Request, principal: Principal = Depends(authenticate)):
    return {'session': request.app.state.engine.complete(principal, sessionId, runId, payload), 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/events/{eventId}/review')
def review(sessionId: Id, runId: Id, eventId: Id, payload: Review, request: Request, principal: Principal = Depends(authenticate)):
    return {'event': request.app.state.engine.review_event(principal, sessionId, runId, eventId, payload), 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/events/group')
def group(sessionId: Id, runId: Id, payload: GroupEvents, request: Request, principal: Principal = Depends(authenticate)):
    return {'event': request.app.state.engine.group(principal, sessionId, runId, payload),
        'resultLabel': 'TEST_SYNTHETIC', 'trackingStatus': 'NO_PHYSICAL_TRACKER'}
