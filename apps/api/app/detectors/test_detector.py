"""Explicit synthetic fixtures, not predictions about the submitted image."""
import hashlib
import json
from ..contracts import scope

__test__ = False
IDENTITY = {'detectorKind': 'TEST', 'modelVersion': 'synthetic-v1', 'classMapVersion': 'synthetic-map-v1'}
CLASS_MAP = {'version': IDENTITY['classMapVersion'], 'approved': True, 'entries': [
    {'rawClassId': 'synthetic-pothole', 'canonicalClass': 'pothole'},
    {'rawClassId': 'synthetic-crack', 'canonicalClass': 'longitudinal_crack'},
]}
PROFILES = ('synthetic_empty', 'synthetic_one', 'synthetic_two')


class TestDetector:
    detector_kind = 'TEST'
    model_version = IDENTITY['modelVersion']
    class_map_version = IDENTITY['classMapVersion']

    def detect(self, frame, profile):
        if profile not in PROFILES:
            raise ValueError('Unapproved synthetic profile')
        count = {'synthetic_empty': 0, 'synthetic_one': 1, 'synthetic_two': 2}[profile]
        result = []
        for index in range(count):
            raw = 'synthetic-pothole' if index == 0 else 'synthetic-crack'
            key = json.dumps([frame['sessionId'], frame['runId'], frame['frameId'], raw])
            result.append({**scope(frame), **IDENTITY, 'observationId': 'obs-' + hashlib.sha256(key.encode()).hexdigest()[:32],
                'frameId': frame['frameId'], 'capturedAt': frame['capturedAt'], 'rawClassId': raw,
                'canonicalClass': 'pothole' if index == 0 else 'longitudinal_crack', 'confidence': 0.75,
                'box': {'x': 0.1 + index * 0.4, 'y': 0.2, 'width': 0.2, 'height': 0.3}})
        return result
