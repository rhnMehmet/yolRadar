import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isReviewItem, isReviewSession, isReviewFrame, isReviewSummary, isReviewMapEligible } from '../src/index.ts'

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m4-review-cases.json', import.meta.url), 'utf8'))
for (const c of fixtures.cases) test(`M4A review parity: ${c.id}`, () => {
  const guards: Record<string,(v: unknown)=>boolean> = {session:isReviewSession,item:isReviewItem,frame:isReviewFrame,summary:isReviewSummary}
  assert.equal(guards[c.kind](c.value), c.valid)
  assert.equal(isReviewMapEligible(c.value, 'test'), c.mapEligibleTest)
  assert.equal(isReviewMapEligible(c.value, 'production'), c.mapEligibleProduction)
})
