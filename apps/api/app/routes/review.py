"""Reviewer-only reads. Owner routes keep their existing authorization semantics."""
import hashlib
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from ..contracts import ApiError, CanonicalClass, Domain, Id
from ..security import Principal, authenticate
from ..review_queries import list_candidates, list_sessions, require_reviewer
from ..sessions import frame_key

router = APIRouter(prefix='/v1/review', tags=['private reviewer reads'])
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=768)]

def access(request, principal, allowed, environment, domain=None):
    engine = request.app.state.engine
    require_reviewer(engine, principal)
    if environment != 'TEST':
        raise ApiError(403, 'environment_not_allowed')
    if set(request.query_params) - set(allowed) or any(len(request.query_params.getlist(k)) != 1 for k in request.query_params):
        raise ApiError(422, 'unsupported_review_filter')
    if domain is not None and domain not in principal.domains:
        raise ApiError(403, 'domain_not_allowed')
    return engine

@router.get('/sessions')
def sessions(request: Request, principal: Principal = Depends(authenticate), limit: Limit = 25, cursor: Cursor = None,
    environment: Literal['TEST', 'PRODUCTION'] = 'TEST', sourceDomain: Domain | None = None,
    detectorKind: Literal['TEST', 'YOLO'] | None = None, status: Literal['active', 'completed', 'cancelled'] | None = None):
    engine = access(request, principal, ('limit','cursor','environment','sourceDomain','detectorKind','status'), environment, sourceDomain)
    return list_sessions(engine, principal, {'sourceDomain':sourceDomain,'detectorKind':detectorKind,'status':status}, limit, cursor)

@router.get('/sessions/{sessionId}/runs/{runId}/candidates')
def candidates(sessionId: Id, runId: Id, request: Request, principal: Principal = Depends(authenticate), limit: Limit = 25, cursor: Cursor = None,
    environment: Literal['TEST', 'PRODUCTION'] = 'TEST', status: Literal['pending','approved','rejected'] | None = None,
    canonicalClass: CanonicalClass | None = None):
    engine = access(request, principal, ('limit','cursor','environment','status','canonicalClass'), environment)
    return list_candidates(engine, principal, sessionId, runId, {'status':status,'canonicalClass':canonicalClass}, limit, cursor)

@router.get('/sessions/{sessionId}/runs/{runId}/evidence/{frameId}')
def evidence(sessionId: Id, runId: Id, frameId: Id, request: Request, principal: Principal = Depends(authenticate), environment: Literal['TEST','PRODUCTION'] = 'TEST'):
    engine = access(request, principal, ('environment',), environment)
    domain, _ = engine.locate(principal, sessionId, runId, review=True)
    with engine.store.tx(domain) as db:
        current = engine.store.get(db, 'session', sessionId)
        if current['run'] != runId: raise ApiError(409, 'stale_run')
        packet = engine.store.get(db, 'frame', frame_key(current['payload']['session'], frameId))
        if packet is None or (packet['sid'],packet['run'],packet['owner']) != (sessionId,runId,current['owner']):
            raise ApiError(404, 'evidence_not_found')
        data = packet['payload']
        if data.get('outcome') != 'analyzed' or data.get('mime') not in ('image/jpeg','image/png') or not data.get('mediaName'):
            raise ApiError(404, 'evidence_not_available')
        try:
            target = engine.store.path(domain, data['mediaName'])
            maximum = 8 * 1024 * 1024 if data['kind'] == 'photo' else 4 * 1024 * 1024
            with target.open('rb') as file: content = file.read(maximum + 1)
            if not content or len(content) > maximum or hashlib.sha256(content).hexdigest() != data.get('sha256'):
                raise ValueError('invalid_evidence')
        except (OSError, ValueError, ApiError):
            raise ApiError(404, 'evidence_not_available') from None
    extension = 'png' if data['mime'] == 'image/png' else 'jpg'
    return Response(content, media_type=data['mime'], headers={'Cache-Control':'no-store','Content-Disposition':f'inline; filename="evidence.{extension}"'})

@router.get('/map-damages')
def map_damages(request: Request, principal: Principal = Depends(authenticate), limit: Limit = 25, cursor: Cursor = None,
    environment: Literal['TEST','PRODUCTION'] = 'TEST', layer: Literal['production','test'] = 'production', sourceDomain: Domain | None = None):
    engine = access(request, principal, ('limit','cursor','environment','layer','sourceDomain'), environment, sourceDomain)
    # No production namespace exists in this service. A source label or human vote cannot promote TEST data.
    if layer == 'production':
        if cursor is not None: raise ApiError(422, 'invalid_cursor')
        return {'environment':'TEST','layer':layer,'items':[],'nextCursor':None}
    result = list_candidates(engine, principal, None, None, {'sourceDomain':sourceDomain}, limit, cursor, map_mode=True)
    return {**result,'layer':layer}
