"""M1 wire contracts and pure policies. Coordinates and clocks are never inferred."""
from __future__ import annotations

import math
import re
from typing import Annotated, Literal
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, TypeAdapter, model_validator

MAX_SAFE = 9_007_199_254_740_991
VIDEO_SAMPLE_TOLERANCE_MS = 100
Domain = Literal['REAL', 'SIM', 'REPLAY']
DamageClass = Literal['pothole', 'longitudinal_crack', 'transverse_crack', 'alligator_crack', 'other']
CanonicalClass = Literal['pothole', 'longitudinal_crack', 'transverse_crack', 'alligator_crack', 'other', 'unknown']
CLASSES = ('pothole', 'longitudinal_crack', 'transverse_crack', 'alligator_crack', 'other', 'unknown')


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


def identifier(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value) is None:
        raise ValueError('invalid_identifier')
    return value


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > MAX_SAFE:
        raise ValueError('invalid_number')
    return float(value)


def integer(value):
    parsed = number(value)
    if not parsed.is_integer():
        raise ValueError('invalid_integer')
    return int(parsed)


Id = Annotated[str, BeforeValidator(identifier)]
Num = Annotated[float, BeforeValidator(number)]
NonNegative = Annotated[Num, Field(ge=0)]
Positive = Annotated[Num, Field(ge=2.220446049250313e-16)]
Score = Annotated[Num, Field(ge=0, le=1)]
SafeInt = Annotated[int, BeforeValidator(integer)]
ContractVersion = Annotated[Literal[1, 2], BeforeValidator(integer)]


class Wire(BaseModel):
    # M1 allows additional top-level keys but forbids them in positions/clocks.
    model_config = ConfigDict(strict=True, extra='ignore', allow_inf_nan=False)


class Exact(Wire):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)


class Scope(Wire):
    contractVersion: ContractVersion
    sessionId: Id
    runId: Id
    sourceDomain: Domain

    @model_validator(mode='after')
    def check_version(self):
        if self.contractVersion == 2 and self.sourceDomain != 'REPLAY':
            raise ValueError('v2_requires_replay')
        return self


class DetectorIdentity(Wire):
    detectorKind: Literal['TEST', 'YOLO']
    modelVersion: Id
    classMapVersion: Id


class CaptureSession(Scope):
    status: Literal['active', 'completed', 'cancelled']
    clockDomain: Literal['DEVICE_MONOTONIC', 'SIMULATION', 'VIDEO']
    clockId: Id
    detector: DetectorIdentity

    @model_validator(mode='after')
    def check_clock(self):
        expected = {'REAL': 'DEVICE_MONOTONIC', 'SIM': 'SIMULATION', 'REPLAY': 'VIDEO'}
        if self.clockDomain != expected[self.sourceDomain]:
            raise ValueError('wrong_clock_domain')
        return self


class VideoAnalysisSession(CaptureSession):
    sourceDomain: Literal['REPLAY']
    clockDomain: Literal['VIDEO']
    videoId: Id
    videoDurationMs: Positive
    samplingIntervalMs: Positive
    recordingOrigin: Literal['REAL', 'SIM', 'UNKNOWN']
    analysisStatus: Literal['running', 'completed', 'partial', 'cancelled', 'failed']

    @model_validator(mode='after')
    def check_plan(self):
        if math.ceil(self.videoDurationMs / self.samplingIntervalMs) > 100_000:
            raise ValueError('sampling_plan_too_large')
        allowed = {'active': ('running',), 'cancelled': ('cancelled',), 'completed': ('completed', 'partial', 'failed')}
        if self.analysisStatus not in allowed[self.status]:
            raise ValueError('inconsistent_analysis_status')
        return self


class NativeTime(Exact):
    clockDomain: Literal['DEVICE_MONOTONIC', 'SIMULATION']
    clockId: Id
    valueMs: NonNegative


class VideoTime(Exact):
    clockDomain: Literal['VIDEO']
    clockId: Id
    videoId: Id
    valueMs: NonNegative


Time = Annotated[NativeTime | VideoTime, Field(discriminator='clockDomain')]


class Gps(Exact):
    kind: Literal['GPS']
    latitude: Annotated[Num, Field(ge=-90, le=90)]
    longitude: Annotated[Num, Field(ge=-180, le=180)]
    accuracyM: NonNegative


class SimLocal(Exact):
    kind: Literal['SIM_LOCAL']
    frameId: Id
    units: Literal['m']
    x: Num
    y: Num
    z: Num


Position = Annotated[Gps | SimLocal, Field(discriminator='kind')]


class PositionSample(Scope):
    sampleId: Id
    capturedAt: Time
    position: Position


class ImageFrame(Scope):
    frameId: Id
    plannedSampleTimestampMs: Annotated[NonNegative | None, BeforeValidator(number)] = None
    capturedAt: Time
    width: Annotated[SafeInt, Field(ge=1, le=32768)]
    height: Annotated[SafeInt, Field(ge=1, le=32768)]


class Box(Wire):
    x: Score
    y: Score
    width: Annotated[Positive, Field(le=1)]
    height: Annotated[Positive, Field(le=1)]

    @model_validator(mode='after')
    def check_bounds(self):
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError('box_out_of_bounds')
        return self


class ClassEntry(Wire):
    rawClassId: Id
    canonicalClass: DamageClass


class ClassMap(Wire):
    version: Id
    approved: bool
    entries: Annotated[list[ClassEntry], Field(min_length=1, max_length=1000)]

    @model_validator(mode='after')
    def check_unique(self):
        if len({entry.rawClassId for entry in self.entries}) != len(self.entries):
            raise ValueError('duplicate_raw_class')
        return self


class DetectionObservation(Scope, DetectorIdentity):
    observationId: Id
    frameId: Id
    capturedAt: Time
    rawClassId: Id
    canonicalClass: CanonicalClass
    confidence: Score
    box: Box


def unique_ids(value):
    if not isinstance(value, list) or not 0 < len(value) <= 10_000:
        raise ValueError('invalid_references')
    if len(set(identifier(item) for item in value)) != len(value):
        raise ValueError('duplicate_references')
    return value


Ids = Annotated[list[Id], BeforeValidator(unique_ids)]


class UnknownLocation(Exact):
    kind: Literal['UNKNOWN']


class EstimatedLocation(Exact):
    kind: Literal['ESTIMATED']
    position: Position
    uncertaintyM: NonNegative
    method: Literal['CALIBRATED_PROJECTION', 'HUMAN_PLACEMENT']


class DamageCandidate(Scope, DetectorIdentity):
    candidateId: Id
    observationIds: Ids
    canonicalClass: CanonicalClass
    reviewStatus: Literal['pending', 'rejected']
    # No explicit null: M1 accepts absence, not null.
    vehiclePosition: PositionSample = Field(default=None)
    damageLocation: Annotated[UnknownLocation | EstimatedLocation, Field(discriminator='kind')]


class HumanReview(Wire):
    kind: Literal['HUMAN']
    reviewerId: Id


class VerifiedDamage(Scope, DetectorIdentity):
    verifiedId: Id
    candidateId: Id
    canonicalClass: DamageClass
    damageLocation: EstimatedLocation
    reviewStatus: Literal['approved']
    review: HumanReview


class AlertEvent(Scope, DetectorIdentity):
    alertId: Id
    candidateId: Id
    canonicalClass: DamageClass
    resultLabel: Literal['TEST_SYNTHETIC', 'YOLO_RESULT']
    reason: Literal['CAMERA_OBSERVATION', 'MAP_APPROACH']


class SimulationGroundTruth(Scope):
    sourceDomain: Literal['SIM']
    truthId: Id
    capturedAt: Time
    canonicalClass: DamageClass
    position: SimLocal


class VideoTimelineEvent(Scope, DetectorIdentity):
    sourceDomain: Literal['REPLAY']
    videoId: Id
    eventId: Id
    videoTimestampMs: NonNegative
    lastVideoTimestampMs: NonNegative
    canonicalClass: CanonicalClass
    confidence: Score
    observationIds: Ids
    reviewStatus: Literal['pending', 'approved', 'rejected']


class FrameAnalysisOutcome(Scope):
    videoId: Id
    frameId: Id
    videoTimestampMs: NonNegative
    plannedSampleTimestampMs: Annotated[NonNegative | None, BeforeValidator(number)] = None
    status: Literal['analyzed', 'skipped', 'failed']


def wire(value):
    return value.model_dump(mode='json', exclude_none=True) if isinstance(value, BaseModel) else value


def parse_session(value):
    cls = VideoAnalysisSession if isinstance(value, dict) and 'videoId' in value else CaptureSession
    return wire(cls.model_validate(value))


def scope(session):
    return {key: session[key] for key in ('contractVersion', 'sessionId', 'runId', 'sourceDomain')}


def require(condition, code='invalid_contract'):
    if not condition:
        raise ApiError(422, code)


def same_scope(value, session):
    require(all(value.get(key) == expected for key, expected in scope(session).items()), 'scope_mismatch')


def same_detector(value, session):
    require(all(value.get(key) == expected for key, expected in session['detector'].items()), 'detector_mismatch')


def validate_time(value, session):
    parsed = wire(TypeAdapter(Time).validate_python(value))
    require(parsed['clockDomain'] == session['clockDomain'] and parsed['clockId'] == session['clockId'], 'clock_mismatch')
    if parsed['clockDomain'] == 'VIDEO':
        VideoAnalysisSession.model_validate(session)
        require(parsed['videoId'] == session['videoId'] and parsed['valueMs'] <= session['videoDurationMs'], 'video_time_mismatch')
    return parsed


def validate_position(value, session):
    parsed = wire(TypeAdapter(Position).validate_python(value))
    origin = session['sourceDomain']
    if origin == 'REPLAY':
        origin = session.get('recordingOrigin', 'UNKNOWN')
    require((parsed['kind'] == 'GPS' and origin == 'REAL') or (parsed['kind'] == 'SIM_LOCAL' and origin == 'SIM'), 'coordinate_domain_mismatch')
    return parsed


def validate_sample(value, session):
    parsed = wire(PositionSample.model_validate(value))
    same_scope(parsed, session)
    validate_time(parsed['capturedAt'], session)
    validate_position(parsed['position'], session)
    return parsed


def validate_frame(value, session):
    parsed = wire(ImageFrame.model_validate(value))
    same_scope(parsed, session)
    validate_time(parsed['capturedAt'], session)
    if session['contractVersion'] == 2:
        validate_video_sample(session, parsed['capturedAt']['valueMs'], parsed.get('plannedSampleTimestampMs'))
    else:
        require('plannedSampleTimestampMs' not in parsed, 'v1_has_no_planned_timestamp')
    return parsed


def validate_video_sample(session, actual, planned):
    VideoAnalysisSession.model_validate(session)
    require(type(planned) in (int, float) and math.isfinite(planned) and 0 <= planned < session['videoDurationMs'], 'planned_sample_required')
    interval = session['samplingIntervalMs']
    slot = math.floor(planned / interval + 0.5)
    require(slot * interval == planned, 'planned_sample_off_grid')
    require(planned <= actual <= planned + VIDEO_SAMPLE_TOLERANCE_MS
        and actual < min(planned + interval, session['videoDurationMs']), 'actual_sample_outside_tolerance')
    return slot


def validate_observation(value, session, frame, class_map):
    parsed = wire(DetectionObservation.model_validate(value))
    same_scope(parsed, session)
    same_detector(parsed, session)
    validate_frame(frame, session)
    validate_time(parsed['capturedAt'], session)
    mapping = wire(ClassMap.model_validate(class_map))
    require(mapping['version'] == session['detector']['classMapVersion'], 'class_map_mismatch')
    mapped = next((entry['canonicalClass'] for entry in mapping['entries'] if entry['rawClassId'] == parsed['rawClassId']), 'unknown') if mapping['approved'] else 'unknown'
    require(parsed['canonicalClass'] == mapped and parsed['frameId'] == frame['frameId'] and parsed['capturedAt']['valueMs'] == frame['capturedAt']['valueMs'], 'observation_mismatch')
    return parsed


def validate_candidate(value, session, observations):
    parsed = wire(DamageCandidate.model_validate(value))
    same_scope(parsed, session)
    same_detector(parsed, session)
    for ref in parsed['observationIds']:
        matches = [item for item in observations if item['observationId'] == ref]
        require(len(matches) == 1, 'missing_observation')
        same_scope(matches[0], session)
        same_detector(matches[0], session)
        require(matches[0]['canonicalClass'] == parsed['canonicalClass'])
    if 'vehiclePosition' in parsed:
        sample = parsed['vehiclePosition']
        same_scope(sample, session)
        validate_time(sample['capturedAt'], session)
        validate_position(sample['position'], session)
    if parsed['damageLocation']['kind'] == 'ESTIMATED':
        validate_position(parsed['damageLocation']['position'], session)
    return parsed


def validate_verified(value, session, candidate):
    parsed = wire(VerifiedDamage.model_validate(value))
    same_scope(parsed, session)
    same_detector(parsed, session)
    same_scope(candidate, session)
    same_detector(candidate, session)
    require(candidate['reviewStatus'] == 'pending' and parsed['candidateId'] == candidate['candidateId'] and parsed['canonicalClass'] == candidate['canonicalClass'])
    validate_position(parsed['damageLocation']['position'], session)
    return parsed


def validate_alert(value, session, candidate, class_map, verified=None):
    parsed = wire(AlertEvent.model_validate(value))
    same_scope(parsed, session)
    same_detector(parsed, session)
    same_scope(candidate, session)
    same_detector(candidate, session)
    mapping = wire(ClassMap.model_validate(class_map))
    require(session['status'] == 'active' and candidate['reviewStatus'] == 'pending')
    require(parsed['candidateId'] == candidate['candidateId'] and parsed['canonicalClass'] == candidate['canonicalClass'])
    require(mapping['approved'] and mapping['version'] == session['detector']['classMapVersion'])
    require(any(entry['canonicalClass'] == parsed['canonicalClass'] for entry in mapping['entries']))
    require(parsed['resultLabel'] == ('TEST_SYNTHETIC' if parsed['detectorKind'] == 'TEST' else 'YOLO_RESULT'))
    if parsed['reason'] == 'MAP_APPROACH':
        require(verified is not None)
        validate_verified(verified, session, candidate)
    return parsed


def validate_truth(value, session):
    parsed = wire(SimulationGroundTruth.model_validate(value))
    require(session['sourceDomain'] == 'SIM')
    same_scope(parsed, session)
    validate_time(parsed['capturedAt'], session)
    validate_position(parsed['position'], session)
    return parsed
