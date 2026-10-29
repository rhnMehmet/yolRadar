"""Authoritative TEST sessions, transactions and ingestion orchestration."""
import asyncio
import hashlib
import json
import secrets
from uuid import uuid4
from pydantic import Field
from .contracts import (ApiError, ContractVersion, Domain, Exact, Id, ImageFrame, PositionSample, SafeInt, VideoAnalysisSession,
    parse_session, require, scope, validate_candidate, validate_frame, validate_observation,
    validate_position, validate_time, validate_verified, wire)
from .detectors.test_detector import CLASS_MAP, IDENTITY, PROFILES
from .jobs import Jobs, process_image
from .media import receive_image
from .storage import Store
from .video import make_event, summarize
from typing import Annotated, Literal


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def frame_key(session, frame_id):
    return fingerprint([session['sessionId'], session['runId'], frame_id])


class CreateSession(Exact):
    contractVersion: ContractVersion = 1
    commandId: Id
    sourceDomain: Domain
    detectorKind: Literal['TEST', 'YOLO']
    testProfile: Literal['synthetic_empty', 'synthetic_one', 'synthetic_two']
    clockId: Id
    videoId: Id | None = None
    videoDurationMs: float | None = None
    samplingIntervalMs: float | None = None
    recordingOrigin: Literal['UNKNOWN'] = 'UNKNOWN'


class NewRun(Exact):
    commandId: Id
    expectedRunId: Id


class FrameMetadata(Exact):
    frame: ImageFrame
    kind: Literal['frame', 'photo'] = 'frame'
    vehiclePosition: PositionSample | None = None


class Completion(Exact):
    analysisStatus: Literal['completed', 'partial', 'failed']


class Review(Exact):
    commandId: Id
    decision: Literal['approve', 'reject']
    damageLocation: dict | None = None
    expectedReviewRevision: Annotated[SafeInt, Field(ge=0)] | None = None


class GroupEvents(Exact):
    commandId: Id
    observationIds: list[Id] = Field(min_length=1, max_length=10_000)


class Engine:
    def __init__(self, settings, worker=process_image):
        self.settings = settings
        self.store = Store(settings)
        self.jobs = Jobs(self, worker)
        self.ingest_lock = asyncio.Lock()
        self.review_cursor_key = secrets.token_bytes(32)

    def locate(self, principal, sid, run_id=None, review=False):
        for domain in principal.domains:
            with self.store.tx(domain) as db:
                row = self.store.get(db, 'session', sid)
            if row and (row['owner'] == principal.id or (review and principal.reviewer)):
                if run_id is not None and row['run'] != run_id:
                    raise ApiError(409, 'stale_run')
                return domain, row
        raise ApiError(404, 'session_not_found')

    @staticmethod
    def active(row):
        if row['payload']['session']['status'] != 'active':
            raise ApiError(409, 'session_not_active')

    def create(self, principal, request):
        data = wire(request)
        # Keep the persisted M2 command fingerprint stable for omitted/explicit v1.
        if data['contractVersion'] == 1:
            data.pop('contractVersion')
        domain = data['sourceDomain']
        if domain not in principal.domains:
            raise ApiError(403, 'domain_not_allowed')
        if data['detectorKind'] != 'TEST':
            raise ApiError(503, 'yolo_model_unavailable')
        with self.store.tx(domain) as db:
            key = fingerprint([principal.id, 'create', data['commandId']])
            command = self.store.get(db, 'command', key)
            digest = fingerprint(data)
            if command:
                if command['payload']['hash'] != digest:
                    raise ApiError(409, 'idempotency_conflict')
                return self.store.get(db, 'session', command['sid'])['payload']['session']
            current = self.store.find(db, 'session', owner=principal.id)
            if sum(row['payload']['session']['status'] == 'active' for row in current) >= 4:
                raise ApiError(429, 'active_session_limit')
            sid, run_id = uuid4().hex, uuid4().hex
            session = {'contractVersion': data.get('contractVersion', 1), 'sessionId': sid, 'runId': run_id, 'sourceDomain': domain,
                'status': 'active', 'clockDomain': {'REAL': 'DEVICE_MONOTONIC', 'SIM': 'SIMULATION', 'REPLAY': 'VIDEO'}[domain],
                'clockId': data['clockId'], 'detector': IDENTITY.copy()}
            video_keys = ('videoId', 'videoDurationMs', 'samplingIntervalMs')
            if domain == 'REPLAY':
                require(all(key in data for key in video_keys), 'video_plan_required')
                session.update({key: data[key] for key in video_keys})
                session.update(recordingOrigin='UNKNOWN', analysisStatus='running')
                session = wire(VideoAnalysisSession.model_validate(session))
            else:
                require(not any(key in data for key in video_keys), 'video_requires_replay')
                session = parse_session(session)
            self.store.put(db, 'session', sid, {'session': session, 'testProfile': data['testProfile']}, principal.id, sid, run_id)
            self.store.put(db, 'command', key, {'hash': digest}, principal.id, sid, run_id)
            return session

    def new_run(self, principal, sid, request):
        domain, _ = self.locate(principal, sid)
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            key = fingerprint([principal.id, sid, 'new-run', request.commandId])
            previous = self.store.get(db, 'command', key)
            digest = fingerprint(wire(request))
            if previous:
                if previous['payload']['hash'] != digest:
                    raise ApiError(409, 'idempotency_conflict')
                return row['payload']['session']
            if request.expectedRunId != row['run']:
                raise ApiError(409, 'stale_run')
            self.cancel_jobs(db, sid, row['run'])
            session = dict(row['payload']['session'], runId=uuid4().hex, status='active')
            if domain == 'REPLAY':
                session['analysisStatus'] = 'running'
            row['payload']['session'] = session
            self.store.put(db, 'session', sid, row['payload'], principal.id, sid, session['runId'])
            self.store.put(db, 'command', key, {'hash': digest}, principal.id, sid, session['runId'])
            return session

    def cancel(self, principal, sid):
        domain, _ = self.locate(principal, sid)
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            session = row['payload']['session']
            if session['status'] == 'completed':
                raise ApiError(409, 'session_already_completed')
            session['status'] = 'cancelled'
            if domain == 'REPLAY':
                session['analysisStatus'] = 'cancelled'
            self.cancel_jobs(db, sid, row['run'])
            self.store.put(db, 'session', sid, row['payload'], row['owner'], sid, row['run'])
            return session

    def register(self, principal, sid, run_id, request):
        domain, _ = self.locate(principal, sid, run_id)
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            self.active(row)
            if row['run'] != run_id:
                raise ApiError(409, 'stale_run')
            session = row['payload']['session']
            frame = validate_frame(wire(request.frame), session)
            packet = {'frame': frame, 'kind': request.kind, 'outcome': None}
            if request.vehiclePosition is not None:
                sample = wire(request.vehiclePosition)
                require(all(sample[key] == value for key, value in scope(session).items()), 'scope_mismatch')
                validate_time(sample['capturedAt'], session)
                validate_position(sample['position'], session)
                packet['vehiclePosition'] = sample
            frames = self.store.find(db, 'frame', sid=sid, run=run_id)
            if domain == 'REPLAY':
                from .video import coverage
                timestamp = frame['capturedAt']['valueMs']
                coverage(session, [{**scope(session), 'videoId': session['videoId'], 'frameId': frame['frameId'], 'videoTimestampMs': timestamp, 'status': 'skipped',
                    **({'plannedSampleTimestampMs': frame['plannedSampleTimestampMs']} if 'plannedSampleTimestampMs' in frame else {})}])
                if any((item['payload']['frame']['capturedAt']['valueMs'] == timestamp
                    or (session['contractVersion'] == 2 and item['payload']['frame'].get('plannedSampleTimestampMs') == frame['plannedSampleTimestampMs']))
                    and item['payload']['frame']['frameId'] != frame['frameId'] for item in frames):
                    raise ApiError(409, 'sampling_slot_conflict')
            key = frame_key(session, frame['frameId'])
            prior = self.store.get(db, 'frame', key)
            metadata_hash = fingerprint(packet)
            if prior:
                if prior['payload']['metadataHash'] != metadata_hash:
                    raise ApiError(409, 'frame_metadata_conflict')
                return {'frameId': frame['frameId'], 'status': 'registered', 'duplicate': True}
            if len(frames) >= 10_000:
                raise ApiError(429, 'frame_metadata_limit')
            packet['metadataHash'] = metadata_hash
            self.store.put(db, 'frame', key, packet, principal.id, sid, run_id)
            return {'frameId': frame['frameId'], 'status': 'registered', 'duplicate': False}

    async def upload(self, principal, sid, run_id, frame_id, request):
        domain, _ = self.locate(principal, sid, run_id)
        try:
            await asyncio.wait_for(self.ingest_lock.acquire(), timeout=self.settings.upload_timeout)
        except TimeoutError:
            raise ApiError(503, 'upload_busy') from None
        uploaded = None
        try:
            with self.store.tx(domain) as db:
                row = self.store.get(db, 'session', sid)
                self.active(row)
                if row['run'] != run_id:
                    raise ApiError(409, 'stale_run')
                key = frame_key(row['payload']['session'], frame_id)
                frame_row = self.store.get(db, 'frame', key)
                if not frame_row:
                    raise ApiError(404, 'frame_not_registered')
                packet = frame_row['payload']
                if packet.get('outcome') == 'skipped':
                    raise ApiError(409, 'frame_already_skipped')
            if not packet.get('jobId') and (self.active_job_count() >= self.settings.queue_limit or self.jobs.queue.full()):
                raise ApiError(429, 'analysis_queue_full')
            uploaded = await receive_image(request, self.store, domain, packet['kind'], self.settings.max_media_bytes - self.store.media_bytes(), hash_only=bool(packet.get('jobId')))
            with self.store.tx(domain) as db:
                current = self.store.get(db, 'session', sid)
                self.active(current)
                if current['run'] != run_id:
                    raise ApiError(409, 'stale_run')
                packet = self.store.get(db, 'frame', key)['payload']
                if packet.get('jobId'):
                    if packet['sha256'] != uploaded['sha256'] or packet['mime'] != uploaded['mime']:
                        raise ApiError(409, 'image_payload_conflict')
                    return {**self.public_job(self.store.get(db, 'job', packet['jobId'])['payload']), 'duplicate': True}
                job_id = uuid4().hex
                packet.update(uploaded, jobId=job_id)
                job = {'jobId': job_id, 'sessionId': sid, 'runId': run_id, 'frameId': frame_id,
                    'sourceDomain': domain, 'detectorKind': 'TEST', 'resultLabel': 'TEST_SYNTHETIC',
                    'status': 'queued', 'frameKey': key}
                self.store.put(db, 'frame', key, packet, principal.id, sid, run_id)
                self.store.put(db, 'job', job_id, job, principal.id, sid, run_id)
            uploaded = None  # Ownership transferred to the private database record.
            self.jobs.queue.put_nowait((domain, job_id))
            return {**self.public_job(job), 'duplicate': False}
        finally:
            if uploaded is not None:
                self.store.path(domain, uploaded['mediaName']).unlink(missing_ok=True)
            self.ingest_lock.release()

    def active_job_count(self):
        count = 0
        for domain in ('REAL', 'SIM', 'REPLAY'):
            with self.store.tx(domain) as db:
                count += sum(row['payload']['status'] in ('queued', 'running') for row in self.store.find(db, 'job'))
        return count

    @staticmethod
    def public_job(job):
        return {key: value for key, value in job.items() if key not in ('frameKey',)}

    @staticmethod
    def public_candidate(item):
        return {key: value for key, value in item.items() if key != 'reviewHash'}

    def get_job(self, principal, job_id):
        for domain in principal.domains:
            with self.store.tx(domain) as db:
                row = self.store.get(db, 'job', job_id)
                if row and row['owner'] == principal.id:
                    result = self.public_job(row['payload'])
                    result['observations'] = []
                    for observation_id in result.get('observationIds', []):
                        observation = self.store.get(db, 'observation', observation_id)
                        if observation and (observation['owner'], observation['sid'], observation['run']) == (row['owner'], row['sid'], row['run']):
                            result['observations'].append(observation['payload'])
                    return result
        raise ApiError(404, 'job_not_found')

    def start_job(self, domain, job_id):
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'job', job_id)
            if not row or row['payload']['status'] != 'queued':
                return None
            job = row['payload']
            session = self.store.get(db, 'session', row['sid'])
            if not session or session['run'] != row['run'] or session['payload']['session']['status'] != 'active':
                job['status'] = 'cancelled'
                self.store.put(db, 'job', job_id, job, row['owner'], row['sid'], row['run'])
                return None
            packet = self.store.get(db, 'frame', job['frameKey'])['payload']
            job['status'] = 'running'
            self.store.put(db, 'job', job_id, job, row['owner'], row['sid'], row['run'])
            return {'path': str(self.store.path(domain, packet['mediaName'])), 'mime': packet['mime'],
                'frame': packet['frame'], 'profile': session['payload']['testProfile']}

    def job_cancelled(self, domain, job_id):
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'job', job_id)
            return row is None or row['payload']['status'] == 'cancelled'

    def finish_job(self, domain, job_id, result):
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'job', job_id)
            if not row:
                return
            job = row['payload']
            if job['status'] not in ('running', 'queued'):
                return
            session_row = self.store.get(db, 'session', row['sid'])
            packet_row = self.store.get(db, 'frame', job['frameKey'])
            if not session_row or session_row['run'] != row['run'] or session_row['payload']['session']['status'] != 'active':
                job['status'] = 'cancelled'
            elif not isinstance(result, dict) or not result.get('ok'):
                code = result.get('errorCode') if isinstance(result, dict) else None
                allowed = {'invalid_image', 'worker_crashed', 'worker_timeout', 'worker_failed', 'invalid_detector_output', 'cancelled'}
                job.update(status='failed', errorCode=code if code in allowed else 'worker_failed')
            else:
                session, packet = session_row['payload']['session'], packet_row['payload']
                try:
                    require(isinstance(result.get('observations'), list) and len(result['observations']) <= 100)
                    observations = [validate_observation(item, session, packet['frame'], CLASS_MAP) for item in result['observations']]
                    require(len(observations) <= 100 and len({item['observationId'] for item in observations}) == len(observations))
                except Exception:
                    job.update(status='failed', errorCode='invalid_detector_output')
                else:
                    for observation in observations:
                        oid = observation['observationId']
                        self.store.put(db, 'observation', oid, observation, row['owner'], row['sid'], row['run'])
                        event_id = 'event-' + oid[4:]
                        candidate_id = 'candidate-' + oid[4:]
                        if domain == 'REPLAY':
                            event = make_event(session, event_id, [oid], observations)
                            self.store.put(db, 'event', event_id, event, row['owner'], row['sid'], row['run'])
                        candidate = {**scope(session), **session['detector'], 'candidateId': candidate_id,
                            'observationIds': [oid], 'canonicalClass': observation['canonicalClass'],
                            'reviewStatus': 'pending', 'damageLocation': {'kind': 'UNKNOWN'}}
                        if 'vehiclePosition' in packet:
                            candidate['vehiclePosition'] = packet['vehiclePosition']
                        validate_candidate(candidate, session, observations)
                        self.store.put(db, 'candidate', candidate_id, {'candidate': candidate, 'eventId': event_id if domain == 'REPLAY' else None, 'reviewDecision': 'pending'}, row['owner'], row['sid'], row['run'])
                    job.update(status='succeeded', observationIds=[obs['observationId'] for obs in observations])
            if packet_row:
                packet_row['payload']['outcome'] = 'analyzed' if job['status'] == 'succeeded' else 'failed'
                self.store.put(db, 'frame', packet_row['id'], packet_row['payload'], row['owner'], row['sid'], row['run'])
                if job['status'] != 'succeeded' and packet_row['payload'].get('mediaName'):
                    self.store.path(domain, packet_row['payload']['mediaName']).unlink(missing_ok=True)
            self.store.put(db, 'job', job_id, job, row['owner'], row['sid'], row['run'])

    def cancel_jobs(self, db, sid, run_id):
        for row in self.store.find(db, 'job', sid=sid, run=run_id):
            if row['payload']['status'] in ('queued', 'running'):
                row['payload']['status'] = 'cancelled'
                self.store.put(db, 'job', row['id'], row['payload'], row['owner'], sid, run_id)

    def interrupt_jobs(self):
        for domain in ('REAL', 'SIM', 'REPLAY'):
            self.store.recover(domain)

    def video_data(self, principal, sid, run_id):
        domain, row = self.locate(principal, sid, run_id)
        require(domain == 'REPLAY', 'video_session_required')
        with self.store.tx(domain) as db:
            # Read current session and all evidence in one consistent snapshot.
            row = self.store.get(db, 'session', sid)
            if row['run'] != run_id:
                raise ApiError(409, 'stale_run')
            session = row['payload']['session']
            events = [r['payload'] for r in self.store.find(db, 'event', sid=sid, run=run_id)]
            observations = [r['payload'] for r in self.store.find(db, 'observation', sid=sid, run=run_id)]
            frames = [r['payload'] for r in self.store.find(db, 'frame', sid=sid, run=run_id)]
            return session, events, observations, frames

    def summary(self, principal, sid, run_id):
        values = self.video_data(principal, sid, run_id)
        return {'summary': summarize(*values), 'trackingStatus': 'NO_PHYSICAL_TRACKER', 'countMeaning': 'PROVISIONAL_EVENT_GROUPS'}

    def skip(self, principal, sid, run_id, frame_id):
        domain, _ = self.locate(principal, sid, run_id)
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            self.active(row)
            if row['run'] != run_id:
                raise ApiError(409, 'stale_run')
            key = frame_key(row['payload']['session'], frame_id)
            frame = self.store.get(db, 'frame', key)
            if not frame:
                raise ApiError(404, 'frame_not_registered')
            if frame['payload'].get('jobId'):
                raise ApiError(409, 'frame_already_submitted')
            frame['payload']['outcome'] = 'skipped'
            self.store.put(db, 'frame', key, frame['payload'], principal.id, sid, run_id)
            return {'frameId': frame_id, 'status': 'skipped'}

    def group(self, principal, sid, run_id, request):
        if not principal.reviewer:
            raise ApiError(403, 'reviewer_required')
        domain, _ = self.locate(principal, sid, run_id, review=True)
        require(domain == 'REPLAY', 'video_session_required')
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            if row['run'] != run_id:
                raise ApiError(409, 'stale_run')
            key = fingerprint([principal.id, sid, run_id, 'group', request.commandId])
            digest = fingerprint(wire(request))
            previous = self.store.get(db, 'command', key)
            if previous:
                event = self.store.get(db, 'event', previous['payload']['eventId'])
                if previous['payload']['hash'] != digest or not event:
                    raise ApiError(409, 'idempotency_conflict')
                return event['payload']
            session = row['payload']['session']
            observations = [item['payload'] for item in self.store.find(db, 'observation', sid=sid, run=run_id)]
            event = make_event(session, 'event-' + uuid4().hex, request.observationIds, observations)
            selected = set(request.observationIds)
            old_events = [item for item in self.store.find(db, 'event', sid=sid, run=run_id) if selected.intersection(item['payload']['observationIds'])]
            covered = set()
            for old in old_events:
                refs = set(old['payload']['observationIds'])
                if not refs <= selected or old['payload']['reviewStatus'] != 'pending':
                    raise ApiError(409, 'reviewed_or_partial_group')
                covered.update(refs)
            require(covered == selected, 'missing_group_events')
            candidates = [item for item in self.store.find(db, 'candidate', sid=sid, run=run_id) if item['payload'].get('eventId') in {item['id'] for item in old_events}]
            if any(item['payload']['reviewDecision'] != 'pending' for item in candidates):
                raise ApiError(409, 'reviewed_group')
            for item in old_events:
                db.execute('DELETE FROM records WHERE kind=? AND id=?', ('event', item['id']))
            for item in candidates:
                db.execute('DELETE FROM records WHERE kind=? AND id=?', ('candidate', item['id']))
            candidate = {**scope(session), **session['detector'], 'candidateId': 'candidate-' + uuid4().hex,
                'observationIds': event['observationIds'], 'canonicalClass': event['canonicalClass'],
                'reviewStatus': 'pending', 'damageLocation': {'kind': 'UNKNOWN'}}
            validate_candidate(candidate, session, observations)
            self.store.put(db, 'event', event['eventId'], event, row['owner'], sid, run_id)
            self.store.put(db, 'candidate', candidate['candidateId'], {'candidate': candidate, 'eventId': event['eventId'], 'reviewDecision': 'pending'}, row['owner'], sid, run_id)
            self.store.put(db, 'command', key, {'hash': digest, 'eventId': event['eventId'], 'replacedEvents': [item['payload'] for item in old_events]}, principal.id, sid, run_id)
            return event

    def complete(self, principal, sid, run_id, request):
        domain, _ = self.locate(principal, sid, run_id)
        with self.store.tx(domain) as db:
            row = self.store.get(db, 'session', sid)
            if row['run'] != run_id:
                raise ApiError(409, 'stale_run')
            self.active(row)
            if any(r['payload']['status'] in ('queued', 'running') for r in self.store.find(db, 'job', sid=sid, run=run_id)):
                raise ApiError(409, 'analysis_jobs_pending')
            session = row['payload']['session']
            session['status'] = 'completed'
            if domain == 'REPLAY':
                session['analysisStatus'] = request.analysisStatus
                events = [r['payload'] for r in self.store.find(db, 'event', sid=sid, run=run_id)]
                observations = [r['payload'] for r in self.store.find(db, 'observation', sid=sid, run=run_id)]
                frames = [r['payload'] for r in self.store.find(db, 'frame', sid=sid, run=run_id)]
                summarize(session, events, observations, frames)
            self.store.put(db, 'session', sid, row['payload'], row['owner'], sid, run_id)
            return session

    def candidates(self, principal):
        result = []
        for domain in principal.domains:
            with self.store.tx(domain) as db:
                for row in self.store.find(db, 'candidate', owner=None if principal.reviewer else principal.id):
                    current = self.store.get(db, 'session', row['sid'])
                    if current and current['run'] == row['run']:
                        result.append({**self.public_candidate(row['payload']), 'resultLabel': 'TEST_SYNTHETIC'})
        return result

    def review_candidate(self, principal, candidate_id, request):
        if not principal.reviewer:
            raise ApiError(403, 'reviewer_required')
        for domain in principal.domains:
            with self.store.tx(domain) as db:
                row = self.store.get(db, 'candidate', candidate_id)
                if not row:
                    continue
                session_row = self.store.get(db, 'session', row['sid'])
                if session_row['run'] != row['run']:
                    raise ApiError(409, 'stale_run')
                item = row['payload']
                from .review_queries import review_command, review_receipt, write_review, review_revision
                key, digest, previous = review_command(self.store, db, principal, row, request, 'candidate', candidate_id)
                if previous is not None:
                    return previous
                command_hash = fingerprint([principal.id, wire(request)])
                if item['reviewDecision'] != 'pending':
                    if item.get('reviewHash') != command_hash:
                        raise ApiError(409, 'review_conflict')
                    return self.public_candidate(item)
                candidate, session = item['candidate'], session_row['payload']['session']
                event = self.store.get(db, 'event', item['eventId']) if item.get('eventId') else None
                if event and (event['sid'], event['run'], event['owner']) != (row['sid'], row['run'], row['owner']):
                    raise ApiError(409, 'review_state_inconsistent')
                if event and (event['payload']['reviewStatus'] == 'rejected'
                    or (event['payload']['reviewStatus'] == 'approved' and request.decision == 'reject')):
                    raise ApiError(409, 'review_conflict')
                entity = item.get('eventId') or candidate_id
                revision = review_revision(self.store, db, row['sid'], row['run'], entity)
                if request.expectedReviewRevision is not None and request.expectedReviewRevision != revision:
                    raise ApiError(409, 'stale_review_revision')
                if request.decision == 'approve':
                    require(request.damageLocation is not None, 'damage_location_required_for_verification')
                    verified = {**scope(session), **session['detector'], 'verifiedId': uuid4().hex,
                        'candidateId': candidate_id, 'canonicalClass': candidate['canonicalClass'],
                        'damageLocation': request.damageLocation, 'reviewStatus': 'approved',
                        'review': {'kind': 'HUMAN', 'reviewerId': principal.id}}
                    verified = validate_verified(verified, session, candidate)
                    self.store.put(db, 'verified', verified['verifiedId'], verified, row['owner'], row['sid'], row['run'])
                    item['verifiedDamage'] = verified
                item.update(reviewDecision='approved' if request.decision == 'approve' else 'rejected', reviewHash=command_hash)
                self.store.put(db, 'candidate', candidate_id, item, row['owner'], row['sid'], row['run'])
                if item.get('eventId'):
                    event = self.store.get(db, 'event', item['eventId'])
                    event['payload']['reviewStatus'] = item['reviewDecision']
                    self.store.put(db, 'event', event['id'], event['payload'], row['owner'], row['sid'], row['run'])
                write_review(self.store, db, principal, row, entity, request, 'LOCATION' if request.decision == 'approve' else 'CONTENT', revision)
                result = self.public_candidate(item)
                review_receipt(self.store, db, principal, row, key, digest, result)
                return result
        raise ApiError(404, 'candidate_not_found')

    def review_event(self, principal, sid, run_id, event_id, request):
        if not principal.reviewer:
            raise ApiError(403, 'reviewer_required')
        domain, _ = self.locate(principal, sid, run_id, review=True)
        require(domain == 'REPLAY', 'video_session_required')
        with self.store.tx(domain) as db:
            current = self.store.get(db, 'session', sid)
            if current['run'] != run_id:
                raise ApiError(409, 'stale_run')
            row = self.store.get(db, 'event', event_id)
            if not row or row['sid'] != sid or row['run'] != run_id:
                raise ApiError(404, 'event_not_found')
            from .review_queries import review_command, review_receipt, write_review, review_revision
            command_key, command_digest, receipt = review_command(self.store, db, principal, row, request, 'event', event_id)
            if receipt is not None:
                return receipt
            require(request.damageLocation is None, 'video_review_does_not_create_map_damage')
            key = fingerprint([principal.id, sid, run_id, 'event-review', request.commandId])
            digest = fingerprint([event_id, wire(request)])
            previous = self.store.get(db, 'command', key)
            if previous:
                if previous['payload']['hash'] != digest:
                    raise ApiError(409, 'idempotency_conflict')
                return row['payload']
            if row['payload']['reviewStatus'] != 'pending':
                raise ApiError(409, 'review_conflict')
            revision = review_revision(self.store, db, sid, run_id, event_id)
            if request.expectedReviewRevision is not None and request.expectedReviewRevision != revision:
                raise ApiError(409, 'stale_review_revision')
            linked = [r for r in self.store.find(db, 'candidate', sid=sid, run=run_id) if r['payload'].get('eventId') == event_id]
            if not linked or any(r['owner'] != row['owner'] or r['payload']['reviewDecision'] != 'pending' for r in linked):
                raise ApiError(409, 'review_state_inconsistent')
            row['payload']['reviewStatus'] = 'approved' if request.decision == 'approve' else 'rejected'
            self.store.put(db, 'event', event_id, row['payload'], row['owner'], sid, run_id)
            self.store.put(db, 'command', key, {'hash': digest}, principal.id, sid, run_id)
            write_review(self.store, db, principal, row, event_id, request, 'CONTENT', revision)
            review_receipt(self.store, db, principal, row, command_key, command_digest, row['payload'])
            return row['payload']
