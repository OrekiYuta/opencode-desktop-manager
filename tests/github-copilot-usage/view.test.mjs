import test from "node:test"
import assert from "node:assert/strict"
import { formatUsageDate, isCreditQuota, usedPercentage } from "../../src/github-copilot-usage/view.ts"

const credits = { tokenBasedBilling: true, unlimited: false, hasQuota: true, percentRemaining: 57.5 }

test("shows AI credits only for an explicitly finite token-based quota", () => {
  assert.equal(isCreditQuota(credits), true)
  assert.equal(usedPercentage(credits), 42.5)
  for (const change of [
    { tokenBasedBilling: false }, { tokenBasedBilling: null },
    { unlimited: true }, { unlimited: null }, { hasQuota: false }, { hasQuota: null },
  ]) {
    assert.equal(isCreditQuota({ ...credits, ...change }), false)
    assert.equal(usedPercentage({ ...credits, ...change }), undefined)
  }
  assert.equal(isCreditQuota(null), false)
})

test("formats dates without locale-dependent month or year text", () => {
  assert.equal(formatUsageDate("2026-12-01T08:00:00.000Z", "UTC"), "2026-12-01 08:00")
  assert.equal(formatUsageDate("2026-11-23T11:39:00.000Z", "UTC"), "2026-11-23 11:39")
  assert.equal(formatUsageDate("bad", "UTC"), undefined)
  assert.equal(formatUsageDate(null, "UTC"), undefined)
})

test("missing and invalid percentages are not inferred", () => {
  for (const percentRemaining of [null, -1, 101, Infinity, NaN]) {
    assert.equal(usedPercentage({ ...credits, percentRemaining }), undefined)
  }
  assert.equal(usedPercentage({ ...credits, percentRemaining: 0 }), 100)
  assert.equal(usedPercentage({ ...credits, percentRemaining: 100 }), 0)
})
