"""TEST-only reviewer projections and atomic audit helpers; never public media."""
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import re
import time
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .contracts import (ApiError, CanonicalClass, DetectorIdentity, Exact, Id,
    NonNegative, SafeInt, Score, Scope, VerifiedDamage, parse_session, require, same_detector, same_scope, scope, wire)

Revision = Annotated[SafeInt, Field(ge=0)]
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

def entity_key(sid, run, entity):
    return digest([sid, run, entity])

def review_revision(store, db, sid, run, entity):
    state = store.get(db, 'review-state', entity_key(sid, run, entity))
    return state['payload']['reviewRevision'] if state else 0

def review_command(store, db, principal, row, request, operation, target):
    key = digest([principal.id, row['sid'], row['run'], 'review-command', request.commandId])
    hashed = digest([operation, target, wire(request)])
    previous = store.get(db, 'command', key)
    if previous and previous['payload']['hash'] != hashed:
        raise ApiError(409, 'idempotency_conflict')
    return key, hashed, previous['payload']['response'] if previous else None

def review_receipt(store, db, principal, row, key, hashed, result):
    store.put(db, 'command', key, {'hash': hashed, 'response': result}, principal.id, row['sid'], row['run'])

def write_review(store, db, principal, row, entity, request, decision_scope, revision):
    # Same caller transaction as the decision and receipt. No inferred historical actor/time.
    audit_id = digest([row['sid'], row['run'], entity, revision + 1])
    audit = {'entityId': entity, 'reviewRevision': revision + 1, 'reviewerId': principal.id,
        'reviewedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'reviewScope': decision_scope, 'decision': 'approved' if request.decision == 'approve' else 'rejected',
        'commandId': request.commandId}
    store.put(db, 'review-audit', audit_id, audit, principal.id, row['sid'], row['run'])
    store.put(db, 'review-state', entity_key(row['sid'], row['run'], entity),
        {'reviewRevision': revision + 1, 'auditId': audit_id}, row['owner'], row['sid'], row['run'])

class EvidenceRef(Exact):
    frameId: Id
    width: Annotated[SafeInt, Field(ge=1, le=32768)]
    height: Annotated[SafeInt, Field(ge=1, le=32768)]
    available: bool
    mime: Literal['image/jpeg', 'image/png'] | None = None
    videoTimestampMs: NonNegative | None = None

    @model_validator(mode='before')
    @classmethod
    def omit_absent(cls, value):
        if isinstance(value, dict) and any(k in value and value[k] is None for k in ('mime', 'videoTimestampMs')):
            raise ValueError('omit_unknown_fields')
        return value

class ReviewItem(Scope, DetectorIdentity, Exact):
    environment: Literal['TEST']
    resultOrigin: Literal['TEST_SYNTHETIC', 'YOLO_RESULT']
    candidateId: Id
    eventId: Id | None = None
    videoId: Id | None = None
    recordingOrigin: Literal['REAL', 'SIM', 'UNKNOWN'] | None = None
    frameId: Id
    canonicalClass: CanonicalClass
    videoTimestampMs: NonNegative | None = None
    confidence: Score
    reviewStatus: Literal['pending', 'approved', 'rejected']
    reviewRevision: Revision
    reviewedAt: str | None = None
    reviewerId: Id | None = None
    reviewScope: Literal['CONTENT', 'LOCATION'] | None = None
    locationStatus: Literal['UNKNOWN', 'ESTIMATED', 'VERIFIED']
    verifiedDamage: VerifiedDamage | None = None
    observationIds: list[Id] = Field(min_length=1, max_length=100)
    observationCount: Annotated[SafeInt, Field(ge=1, le=10000)]
    frameCount: Annotated[SafeInt, Field(ge=1, le=10000)]
    referencesTruncated: bool
    evidence: list[EvidenceRef] = Field(min_length=1, max_length=20)

    @model_validator(mode='before')
    @classmethod
    def omit_unknown(cls, value):
        if isinstance(value, dict):
            if any(k in value and value[k] is None for k in ('eventId','videoId','recordingOrigin','videoTimestampMs','reviewedAt','reviewerId','reviewScope','verifiedDamage')):
                raise ValueError('omit_unknown_fields')
            if 'verifiedDamage' in value and wire(VerifiedDamage.model_validate(value['verifiedDamage'])) != value['verifiedDamage']:
                raise ValueError('unexpected_verification_fields')
        return value

    @model_validator(mode='after')
    def check_projection(self):
        if self.resultOrigin != ('TEST_SYNTHETIC' if self.detectorKind == 'TEST' else 'YOLO_RESULT'):
            raise ValueError('wrong_result_origin')
        if len(set(self.observationIds)) != len(self.observationIds) or len({e.frameId for e in self.evidence}) != len(self.evidence):
            raise ValueError('duplicate_reference')
        if len(self.observationIds) != min(100, self.observationCount) or len(self.evidence) != min(20, self.frameCount) or self.frameId != self.evidence[0].frameId:
            raise ValueError('inconsistent_references')
        if self.frameCount > self.observationCount or self.referencesTruncated != (self.observationCount > 100 or self.frameCount > 20):
            raise ValueError('inconsistent_reference_counts')
        replay = self.sourceDomain == 'REPLAY'
        if replay != (self.videoId is not None and self.eventId is not None and self.videoTimestampMs is not None and self.recordingOrigin is not None):
            raise ValueError('video_context_required')
        if not replay and any(v is not None for v in (self.videoId, self.eventId, self.videoTimestampMs, self.recordingOrigin)):
            raise ValueError('video_requires_replay')
        for evidence in self.evidence:
            if replay != (evidence.videoTimestampMs is not None) or evidence.available != (evidence.mime is not None):
                raise ValueError('invalid_evidence_reference')
        audited = self.reviewedAt is not None
        if audited != (self.reviewerId is not None) or audited != (self.reviewScope is not None) or audited != (self.reviewRevision > 0):
            raise ValueError('audit_fields_must_be_recorded_together')
        if audited:
            if self.reviewStatus == 'pending' or not re.fullmatch(r'(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', self.reviewedAt):
                raise ValueError('invalid_review_time')
            datetime.fromisoformat(self.reviewedAt.replace('Z', '+00:00'))
        if (self.locationStatus == 'VERIFIED') != (self.verifiedDamage is not None):
            raise ValueError('verification_required')
        if self.verifiedDamage:
            v = wire(self.verifiedDamage)
            same_scope(v, wire(self)); same_detector(v, {'detector': {k: getattr(self, k) for k in ('detectorKind', 'modelVersion', 'classMapVersion')}})
            if v['candidateId'] != self.candidateId or v['canonicalClass'] != self.canonicalClass or self.reviewStatus != 'approved':
                raise ValueError('verification_mismatch')
            origin = self.recordingOrigin if replay else self.sourceDomain
            if (v['damageLocation']['position']['kind'], origin) not in (('GPS', 'REAL'), ('SIM_LOCAL', 'SIM')):
                raise ValueError('coordinate_domain_mismatch')
        return self

class ReviewSession(Exact):
    environment: Literal['TEST']
    resultOrigin: Literal['TEST_SYNTHETIC', 'YOLO_RESULT']
    session: dict

    @model_validator(mode='after')
    def check_session(self):
        parsed = parse_session(self.session)
        if parsed != self.session:
            raise ValueError('unexpected_session_fields')
        self.session = parsed
        if self.resultOrigin != ('TEST_SYNTHETIC' if parsed['detector']['detectorKind'] == 'TEST' else 'YOLO_RESULT'):
            raise ValueError('wrong_origin')
        return self

def require_reviewer(engine, principal):
    if not principal.reviewer:
        raise ApiError(403, 'reviewer_required')
    if engine.settings.profile != 'TEST':
        raise ApiError(403, 'environment_not_allowed')

def reviewer_item(engine, db, domain, row, session):
    candidate = row['payload']['candidate']
    same_scope(candidate, session); same_detector(candidate, session)
    event = engine.store.get(db, 'event', row['payload']['eventId']) if row['payload'].get('eventId') else None
    if event and (event['sid'], event['run'], event['owner']) != (row['sid'], row['run'], row['owner']):
        raise ApiError(409, 'review_state_inconsistent')
    observations = []
    for ref in candidate['observationIds']:
        obs = engine.store.get(db, 'observation', ref)
        require(obs is not None and (obs['sid'], obs['run'], obs['owner']) == (row['sid'], row['run'], row['owner']), 'invalid_review_evidence')
        same_scope(obs['payload'], session); same_detector(obs['payload'], session)
        observations.append(obs['payload'])
    observations.sort(key=lambda o: (o['capturedAt']['valueMs'], o['frameId'], o['observationId']))
    frame_ids = list(dict.fromkeys(o['frameId'] for o in observations))
    evidence = []
    from .sessions import frame_key
    for fid in frame_ids[:20]:
        frame = engine.store.get(db, 'frame', frame_key(session, fid))
        require(frame is not None and (frame['sid'], frame['run'], frame['owner']) == (row['sid'], row['run'], row['owner']), 'invalid_review_evidence')
        packet = frame['payload']; image = packet['frame']; same_scope(image, session)
        available = packet.get('outcome') == 'analyzed' and packet.get('mime') in ('image/jpeg', 'image/png') and bool(packet.get('mediaName'))
        evidence.append({'frameId': fid, 'width': image['width'], 'height': image['height'], 'available': available,
            **({'mime': packet['mime']} if available else {}),
            **({'videoTimestampMs': image['capturedAt']['valueMs']} if domain == 'REPLAY' else {})})
    result = {**scope(session), **session['detector'], 'environment': 'TEST',
        'resultOrigin': 'TEST_SYNTHETIC' if session['detector']['detectorKind'] == 'TEST' else 'YOLO_RESULT',
        'candidateId': candidate['candidateId'], 'frameId': frame_ids[0], 'canonicalClass': candidate['canonicalClass'],
        'confidence': max(o['confidence'] for o in observations),
        'reviewStatus': event['payload']['reviewStatus'] if event else row['payload']['reviewDecision'], 'reviewRevision': 0,
        'locationStatus': 'VERIFIED' if row['payload'].get('verifiedDamage') else candidate['damageLocation']['kind'],
        'observationIds': [o['observationId'] for o in observations[:100]], 'observationCount': len(observations),
        'frameCount': len(frame_ids), 'referencesTruncated': len(observations) > 100 or len(frame_ids) > 20, 'evidence': evidence}
    if domain == 'REPLAY':
        require(event is not None, 'invalid_review_event')
        result.update(eventId=event['id'], videoId=session['videoId'], recordingOrigin=session['recordingOrigin'], videoTimestampMs=event['payload']['videoTimestampMs'])
    if row['payload'].get('verifiedDamage'):
        result['verifiedDamage'] = row['payload']['verifiedDamage']
    state = engine.store.get(db, 'review-state', entity_key(row['sid'], row['run'], event['id'] if event else row['id']))
    if state:
        audit = engine.store.get(db, 'review-audit', state['payload']['auditId'])
        require(audit is not None and audit['payload']['reviewRevision'] == state['payload']['reviewRevision'], 'invalid_review_audit')
        result.update({k: audit['payload'][k] for k in ('reviewRevision', 'reviewerId', 'reviewedAt', 'reviewScope')})
    return wire(ReviewItem.model_validate(result))

def page(engine, principal, namespace, filters, limit, cursor, query):
    require_reviewer(engine, principal)
    context = digest([principal.id, sorted(principal.domains), 'TEST', namespace, filters, limit])
    after = ('', ''); snapshot = time.time()
    if cursor:
        try:
            require(len(cursor) <= 768, 'invalid_cursor')
            payload, signature = cursor.split('.')
            expected = hmac.new(engine.review_cursor_key, payload.encode(), hashlib.sha256).hexdigest()
            require(hmac.compare_digest(signature, expected), 'invalid_cursor')
            data = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            require(data['context'] == context and type(data['snapshot']) in (int, float), 'invalid_cursor')
            after = tuple(data['after']); snapshot = data['snapshot']
        except Exception:
            raise ApiError(422, 'invalid_cursor') from None
    rows = []
    for domain in sorted(principal.domains):
        if filters.get('sourceDomain') and filters['sourceDomain'] != domain:
            continue
        with engine.store.tx(domain) as db:
            for row in query(db, domain, snapshot, after, limit + 1):
                if namespace == 'sessions':
                    s = row['payload']['session']
                    item = wire(ReviewSession(environment='TEST', resultOrigin='TEST_SYNTHETIC' if s['detector']['detectorKind'] == 'TEST' else 'YOLO_RESULT', session=s))
                else:
                    current = engine.store.get(db, 'session', row['sid'])
                    if current['run'] != row['run']:
                        raise ApiError(409, 'stale_run')
                    item = reviewer_item(engine, db, domain, row, current['payload']['session'])
                rows.append((domain, row, item))
    rows.sort(key=lambda item: (item[0], item[1]['id']))
    selected = rows[:limit]; items = [r[2] for r in selected]
    next_cursor = None
    if len(rows) > limit:
        last = (selected[-1][0], selected[-1][1]['id'])
        payload = base64.urlsafe_b64encode(json.dumps({'context': context, 'snapshot': snapshot, 'after': last}, separators=(',', ':')).encode()).decode().rstrip('=')
        next_cursor = payload + '.' + hmac.new(engine.review_cursor_key, payload.encode(), hashlib.sha256).hexdigest()
    return {'environment': 'TEST', 'items': items, 'nextCursor': next_cursor}

def list_sessions(engine, principal, filters, limit, cursor):
    def query(db, domain, snapshot, after, size):
        if domain < after[0]: return []
        clauses = ["kind='session'", 'created<=?', 'id>?']; args = [snapshot, after[1] if domain == after[0] else '']
        for key, field in [('detectorKind', '$.session.detector.detectorKind'), ('status', '$.session.status')]:
            if filters.get(key): clauses.append('json_extract(payload, ?) = ?'); args.extend([field, filters[key]])
        return [dict(r, payload=json.loads(r['payload'])) for r in db.execute('SELECT * FROM records WHERE '+ ' AND '.join(clauses)+' ORDER BY id LIMIT ?', [*args, size])]
    return page(engine, principal, 'sessions', filters, limit, cursor, query)

def list_candidates(engine, principal, sid, run, filters, limit, cursor, map_mode=False):
    require_reviewer(engine, principal)
    if sid:
        engine.locate(principal, sid, run, review=True)
    def query(db, domain, snapshot, after, size):
        if domain < after[0]: return []
        clauses = ["c.kind='candidate'", "s.kind='session'", 'c.run=s.run', 'c.owner=s.owner', 'c.created<=?', 'c.id>?']
        args = [snapshot, after[1] if domain == after[0] else '']
        if sid: clauses.extend(['c.sid=?','c.run=?']); args.extend([sid, run])
        for key, field in [('canonicalClass', '$.candidate.canonicalClass')]:
            if filters.get(key): clauses.append('json_extract(c.payload, ?) = ?'); args.extend([field, filters[key]])
        if filters.get('detectorKind'):
            clauses.append("json_extract(s.payload,'$.session.detector.detectorKind')=?"); args.append(filters['detectorKind'])
        if filters.get('status'):
            clauses.append("COALESCE(json_extract(e.payload,'$.reviewStatus'),json_extract(c.payload,'$.reviewDecision'))=?"); args.append(filters['status'])
        if map_mode:
            clauses.extend(["json_extract(c.payload,'$.reviewDecision')='approved'", "json_extract(c.payload,'$.verifiedDamage.damageLocation.position.kind')='GPS'",
                "COALESCE(json_extract(e.payload,'$.reviewStatus'),json_extract(c.payload,'$.reviewDecision'))='approved'",
                "json_extract(c.payload,'$.verifiedDamage.damageLocation.method') IN ('HUMAN_PLACEMENT','CALIBRATED_PROJECTION')",
                "(json_extract(s.payload,'$.session.sourceDomain')='REAL' OR json_extract(s.payload,'$.session.recordingOrigin')='REAL')"])
        sql="SELECT c.* FROM records c JOIN records s ON s.id=c.sid LEFT JOIN records e ON e.kind='event' AND e.id=json_extract(c.payload,'$.eventId') AND e.sid=c.sid AND e.run=c.run WHERE "+' AND '.join(clauses)+' ORDER BY c.id LIMIT ?'
        return [dict(r, payload=json.loads(r['payload'])) for r in db.execute(sql,[*args,size])]
    return page(engine, principal, 'map' if map_mode else sid+':'+run, filters, limit, cursor, query)
