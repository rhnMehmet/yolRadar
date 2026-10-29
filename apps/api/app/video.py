"""M1 video event and declared-sampling-grid summary policies."""
import math
from .contracts import (ApiError, CLASSES, FrameAnalysisOutcome, VideoAnalysisSession,
    VideoTimelineEvent, require, same_detector, same_scope, scope, unique_ids, validate_time, wire)


def make_event(session, event_id, observation_ids, observations, review_status='pending'):
    VideoAnalysisSession.model_validate(session)
    unique_ids(observation_ids)
    index = {item['observationId']: item for item in observations}
    require(len(index) == len(observations), 'duplicate_observation')
    require(all(ref in index for ref in observation_ids), 'missing_observation')
    selected = [index[ref] for ref in observation_ids]
    for item in selected:
        same_scope(item, session)
        same_detector(item, session)
        validate_time(item['capturedAt'], session)
    require(len({item['frameId'] for item in selected}) == len(selected), 'same_frame_cannot_be_one_hazard')
    require(len({item['canonicalClass'] for item in selected}) == 1, 'mixed_event_classes')
    times = [item['capturedAt']['valueMs'] for item in selected]
    result = {**scope(session), **session['detector'], 'videoId': session['videoId'], 'eventId': event_id,
        'videoTimestampMs': min(times), 'lastVideoTimestampMs': max(times),
        'canonicalClass': selected[0]['canonicalClass'], 'confidence': max(item['confidence'] for item in selected),
        'observationIds': sorted(observation_ids), 'reviewStatus': review_status}
    return wire(VideoTimelineEvent.model_validate(result))


def coverage(session, outcomes):
    VideoAnalysisSession.model_validate(session)
    interval, duration = session['samplingIntervalMs'], session['videoDurationMs']
    slots, ids = {}, set()
    for value in outcomes:
        item = wire(FrameAnalysisOutcome.model_validate(value))
        same_scope(item, session)
        timestamp = item['videoTimestampMs']
        require(item['videoId'] == session['videoId'] and timestamp < duration, 'invalid_outcome_time')
        slot = math.floor(timestamp / interval + 0.5)
        require(abs(slot * interval - timestamp) <= 0.000001, 'outcome_off_sampling_grid')
        if slot in slots:
            require(slots[slot] == item, 'conflicting_outcome')
            continue
        require(item['frameId'] not in ids, 'reused_frame')
        slots[slot] = item
        ids.add(item['frameId'])
    counts = {'analyzed': 0, 'skipped': 0, 'failed': 0}
    covered, gaps = [], []
    for index in range(math.ceil(duration / interval)):
        status = slots.get(index, {}).get('status')
        if status:
            counts[status] += 1
        target = covered if status == 'analyzed' else gaps
        start, end = index * interval, min((index + 1) * interval, duration)
        if target and target[-1]['endMs'] == start:
            target[-1]['endMs'] = end
        else:
            target.append({'startMs': start, 'endMs': end})
    return {'basis': 'DECLARED_SAMPLING_GRID', 'samplingIntervalMs': interval,
        'status': 'complete' if not gaps else 'partial' if covered else 'none',
        'analyzedFrames': counts['analyzed'], 'skippedFrames': counts['skipped'], 'failedFrames': counts['failed'],
        'coveredRanges': covered, 'unanalysedRanges': gaps}


def summarize(session, events, observations, frames):
    outcomes = []
    analyzed = {}
    for item in frames:
        if item.get('outcome') not in ('analyzed', 'skipped', 'failed'):
            continue
        frame = item['frame']
        timestamp = frame['capturedAt']['valueMs']
        outcomes.append({**scope(session), 'videoId': session['videoId'], 'frameId': frame['frameId'],
            'videoTimestampMs': timestamp, 'status': item['outcome']})
        if item['outcome'] == 'analyzed':
            analyzed[frame['frameId']] = timestamp
    result_coverage = coverage(session, outcomes)
    require(session['analysisStatus'] != 'completed' or result_coverage['status'] == 'complete', 'incomplete_sampling_coverage')
    event_ids, used = set(), set()
    index = {item['observationId']: item for item in observations}
    require(len(index) == len(observations))
    accepted = []
    for event in events:
        expected = make_event(session, event['eventId'], event['observationIds'], observations, event['reviewStatus'])
        require(wire(VideoTimelineEvent.model_validate(event)) == expected and event['eventId'] not in event_ids, 'invalid_timeline_event')
        event_ids.add(event['eventId'])
        for ref in event['observationIds']:
            obs = index[ref]
            require(ref not in used and analyzed.get(obs['frameId']) == obs['capturedAt']['valueMs'], 'duplicate_or_unanalyzed_event')
            used.add(ref)
        if event['reviewStatus'] != 'rejected':
            accepted.append(expected)
    accepted.sort(key=lambda event: (event['videoTimestampMs'], event['eventId']))
    counts = dict.fromkeys(CLASSES, 0)
    for event in accepted:
        counts[event['canonicalClass']] += 1
    return {**scope(session), **session['detector'], 'videoId': session['videoId'],
        'resultLabel': 'TEST_SYNTHETIC' if session['detector']['detectorKind'] == 'TEST' else 'YOLO_RESULT',
        'analysisStatus': session['analysisStatus'], 'coverage': result_coverage,
        'totalEvents': len(accepted), 'rawObservationCount': sum(analyzed.get(obs['frameId']) == obs['capturedAt']['valueMs'] for obs in observations),
        'classCounts': counts, 'firstDamageTimestampMs': accepted[0]['videoTimestampMs'] if accepted else None,
        'lastDamageTimestampMs': max(event['lastVideoTimestampMs'] for event in accepted) if accepted else None,
        'events': accepted, 'deduplication': 'EXPLICIT_OBSERVATION_GROUPS'}
