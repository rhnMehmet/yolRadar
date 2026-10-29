import assert from 'node:assert/strict'
import test from 'node:test'
import {summaryMetrics} from '../src/features/video-analysis/summaryPresentation.ts'
import {video} from '../../../packages/shared/tests/m1Fixtures.ts'
import type {VideoAnalysisSummary} from '@roadsense/shared'
test('unattempted and unsuccessful coverage are different with skipped/failed',()=>{const s=video(),summary={coverage:{analyzedFrames:1,skippedFrames:1,failedFrames:1,unanalysedRanges:[{startMs:1000,endMs:4000}]}} as VideoAnalysisSummary;const m=summaryMetrics(summary,s);assert.deepEqual(m,{planned:4,analyzed:1,skipped:1,failed:1,unattempted:1,outsideSuccess:3,unanalysedMs:3000,percent:25})})
test('fractional final slot rounds planned count upward',()=>{const m=summaryMetrics({coverage:{analyzedFrames:1,skippedFrames:0,failedFrames:0,unanalysedRanges:[]}} as unknown as VideoAnalysisSummary,{...video(),videoDurationMs:4100});assert.equal(m.planned,5);assert.equal(m.unattempted,4)})
test('inconsistent counts are rejected',()=>{assert.throws(()=>summaryMetrics({coverage:{analyzedFrames:10,skippedFrames:1,failedFrames:0,unanalysedRanges:[]}} as unknown as VideoAnalysisSummary,video()))})
