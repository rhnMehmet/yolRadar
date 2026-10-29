import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {evidenceBoxes,imageDimensionsMatch} from '../src/features/review/evidenceGeometry.ts'
const data=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m4-review-cases.json',import.meta.url),'utf8')).cases.find((c:{id:string})=>c.id==='m4b-recorded-box').value
test('recorded normalized boxes map to image percentages without synthesizing positions',()=>{const boxes=evidenceBoxes(data);assert.deepEqual(boxes,[{id:'obs-1',left:10,top:20,width:20,height:30}]);assert.equal(imageDimensionsMatch(data,640,360),true);assert.equal(imageDimensionsMatch(data,360,640),false)})
test('portrait dimensions preserve normalized location and reject unrelated frame',()=>{const f=structuredClone(data);f.frame.width=f.evidence.width=360;f.frame.height=f.evidence.height=640;assert.equal(imageDimensionsMatch(f,360,640),true);assert.deepEqual(evidenceBoxes(f),evidenceBoxes(data));f.observations[0].frameId='other';assert.throws(()=>evidenceBoxes(f))})
