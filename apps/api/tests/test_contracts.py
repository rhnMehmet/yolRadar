import copy
import json
from pathlib import Path
import pytest
from app import contracts as c
from app.video import make_event, summarize

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/fixtures/m1-cases.json').read_text(encoding='utf8'))['cases']


def revive(value):
    if isinstance(value, list):
        return [revive(item) for item in value]
    if isinstance(value, dict):
        if value.get('$number') == 'NaN':
            return float('nan')
        if value.get('$number') == 'Infinity':
            return float('inf')
        return {key: revive(item) for key, item in value.items()}
    return value


@pytest.mark.parametrize('original', FIXTURES, ids=[case['id'] for case in FIXTURES])
def test_m1_python_fixture_parity(original):
    case = revive(original)
    value, kind = case['value'], case['kind']
    summary = None
    accepted = True
    try:
        if kind == 'session':
            c.CaptureSession.model_validate(value)
        elif kind == 'videoSession':
            c.VideoAnalysisSession.model_validate(value)
        elif kind == 'classMap':
            c.ClassMap.model_validate(value)
        elif kind == 'time':
            c.validate_time(value, case['session'])
        elif kind == 'position':
            c.validate_position(value, case['session'])
        elif kind == 'frame':
            c.validate_frame(value, case['session'])
        elif kind == 'sample':
            c.validate_sample(value, case['session'])
        elif kind == 'observation':
            c.validate_observation(value, case['session'], case['frame'], case['map'])
        elif kind == 'candidate':
            c.validate_candidate(value, case['session'], case['observations'])
        elif kind == 'verified':
            c.validate_verified(value, case['session'], case['candidate'])
        elif kind == 'alert':
            c.validate_alert(value, case['session'], case['candidate'], case['map'], case.get('verified'))
        elif kind == 'truth':
            c.validate_truth(value, case['session'])
        elif kind in ('event', 'summary'):
            evidence, session = case['evidence'], case['session']
            frame_index = {}
            for frame in evidence['frames']:
                c.validate_frame(frame, session)
                assert frame['frameId'] not in frame_index
                frame_index[frame['frameId']] = frame
            for observation in evidence['observations']:
                c.validate_observation(observation, session, frame_index[observation['frameId']], evidence['classMap'])
            if kind == 'event':
                expected = make_event(session, value['eventId'], value['observationIds'], evidence['observations'], value['reviewStatus'])
                accepted = c.wire(c.VideoTimelineEvent.model_validate(value)) == expected
            else:
                frames = []
                for outcome in value['outcomes']:
                    c.same_scope(outcome, session)
                    frame = frame_index[outcome['frameId']]
                    assert frame['capturedAt']['valueMs'] == outcome['videoTimestampMs']
                    frames.append({'frame': frame, 'outcome': outcome['status']})
                summary = summarize(session, value['events'], evidence['observations'], frames)
        else:
            raise AssertionError('Unsupported fixture kind')
    except Exception:
        accepted = False
    assert accepted == case['expected']
    if accepted and case.get('expectedSummary'):
        for key, expected in case['expectedSummary'].items():
            assert summary[key] == expected
