from fastapi import APIRouter, Depends, Request
from ..contracts import Id
from ..security import Principal, authenticate
from ..sessions import Review

router = APIRouter(prefix='/v1/candidates', tags=['candidate review'])


@router.get('')
def list_candidates(request: Request, principal: Principal = Depends(authenticate)):
    return {'items': request.app.state.engine.candidates(principal), 'resultLabel': 'TEST_SYNTHETIC'}


@router.post('/{candidateId}/review')
def review(candidateId: Id, payload: Review, request: Request, principal: Principal = Depends(authenticate)):
    return {'item': request.app.state.engine.review_candidate(principal, candidateId, payload), 'resultLabel': 'TEST_SYNTHETIC'}
