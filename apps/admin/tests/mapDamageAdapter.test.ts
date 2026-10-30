import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {adaptMapDamage,MAX_MAP_LATITUDE,mapReference,validateMapReference} from '../src/features/damage-map/mapDamageAdapter.ts'
const cases=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m4-review-cases.json',import.meta.url),'utf8')).cases
const real=()=>structuredClone(cases.find((c:{id:string})=>c.id==='real-verified-remains-test').value)
const origin='http://127.0.0.1:8003'
test('valid GPS verified point preserves separate accuracy/uncertainty and narrow reference',()=>{const i=real(),p=adaptMapDamage(i,'test',origin)!;assert.ok(p);assert.equal(p.latitude,i.verifiedDamage.damageLocation.position.latitude);assert.equal(p.accuracyM,i.verifiedDamage.damageLocation.position.accuracyM);assert.equal(p.uncertaintyM,i.verifiedDamage.damageLocation.uncertaintyM);assert.deepEqual(Object.keys(p.reference).sort(),['candidateId','origin','runId','sessionId','sourceDomain','verifiedId']);assert.equal(p.item.environment,'TEST')})
for(const c of cases.filter((c:{kind:string})=>c.kind==='item'))test('map policy fixture '+c.id,()=>{const adapted=adaptMapDamage(c.value,'test',origin);assert.equal(!!adapted,c.mapEligibleTest);assert.equal(adaptMapDamage(c.value,'production',origin),null)})
for(const v of [null,undefined,'37',true,NaN,Infinity,-91,91])test('reject malformed latitude '+String(v),()=>{const i=real();i.verifiedDamage.damageLocation.position.latitude=v;assert.equal(adaptMapDamage(i,'test',origin),null)})
for(const v of [null,'30',true,NaN,Infinity,-181,181])test('reject malformed longitude '+String(v),()=>{const i=real();i.verifiedDamage.damageLocation.position.longitude=v;assert.equal(adaptMapDamage(i,'test',origin),null)})
for(const latitude of [0,MAX_MAP_LATITUDE,-MAX_MAP_LATITUDE])test('zero/boundary coordinates accepted '+latitude,()=>{const i=real();Object.assign(i.verifiedDamage.damageLocation.position,{latitude,longitude:0});assert.equal(adaptMapDamage(i,'test',origin)?.latitude,latitude)})
for(const latitude of [90,-90,MAX_MAP_LATITUDE+.000000001])test('projection clamp prohibited '+latitude,()=>{const i=real();i.verifiedDamage.damageLocation.position.latitude=latitude;assert.equal(adaptMapDamage(i,'test',origin),null)})
test('unverified vehicle position cannot become damage position',()=>{const i=real();i.locationStatus='UNKNOWN';delete i.verifiedDamage;i.vehiclePosition={kind:'GPS',latitude:37,longitude:30,accuracyM:1};assert.equal(adaptMapDamage(i,'test',origin),null)})
test('HTML-shaped model identity is rejected by the shared guard',()=>{const i=real();i.modelVersion='<img onerror=alert(1)>';assert.equal(adaptMapDamage(i,'test',origin),null)})
test('reference rejects tokens, snapshots, blob and untrusted origin',()=>{const ref=mapReference(origin,real());assert.deepEqual(validateMapReference(ref),ref);for(const extra of ['token','latitude','blobUrl'])assert.throws(()=>validateMapReference({...ref,[extra]:'forbidden'}));assert.throws(()=>validateMapReference({...ref,origin:'https://example.com'}))})
