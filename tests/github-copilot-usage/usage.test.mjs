import test from "node:test"
import assert from "node:assert/strict"
import { UsageService, parseUsage, CACHE_MS, REFRESH_INTERVAL_MS, SNAPSHOT_MAX_AGE_MS } from "../../src/github-copilot-usage/service.ts"
import { UsageRpc } from "../../src/github-copilot-usage/rpc.ts"

const payload = {
  copilot_plan: "individual_pro",
  quota_reset_date: "2026-12-01",
  quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { entitlement: 100, quota_remaining: 40, percent_remaining: 40, unlimited: false, overage_count: 2, overage_permitted: true },
    completions: { entitlement: -1, unlimited: true },
    premium_interactions: { entitlement: "300", remaining: 25, quota_remaining: 25.5, percent_remaining: 8.5, credits_used: 17.25, timestamp_utc: "2026-10-06T14:40:30.429-07:00", token_based_billing: true, has_quota: false },
  },
  secret: "must-not-leak",
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
function fixture(fetcher) {
  let time = 1_000_000
  let active = { id: "account-a", token: "token-a" }
  const integration = { connection: {
    active: async () => active && { id: active.id, label: active.label },
    resolve: async (connection) => active && connection.id === active.id
      ? { type: "oauth", refresh: active.token, access: active.access, metadata: active.metadata }
      : undefined,
  } }
  const service = new UsageService(integration, fetcher, () => time)
  return { service, integration, setTime: (t) => { time = t }, now: () => time, setActive: (v) => { active = v } }
}
const endpoints = []
function successFetch(url, options) {
  endpoints.push([url, options])
  return Promise.resolve(url.endsWith("/copilot_internal/user") ? json(payload) : json({ login: "valid-user", token: "must-not-leak" }))
}

test("RPC contract exposes the usage method", () => {
  assert.equal(UsageRpc.id, "copilot-usage")
  assert.deepEqual(UsageRpc.methods.get.input.required, ["refresh"])
  const data = UsageRpc.methods.get.output.properties.data.anyOf[1]
  assert.ok(data.required.includes("loginStatus"))
  assert.deepEqual(data.properties.loginStatus.enum, ["ok", "unauthorized", "forbidden", "rate_limited", "network_error", "invalid_response"])
})

test("parses only safe known fields and preserves missing, unlimited and non-integer values", () => {
  const parsed = parseUsage(payload)
  assert.equal(parsed.plan, "individual_pro")
  assert.equal(parsed.resetDate, "2026-12-01T00:00:00.000Z")
  assert.equal(parseUsage({ copilot_plan: "business", quota_reset_date: "2026-12-01" }).resetDate, null)
  assert.equal(parseUsage({ copilot_plan: "business", quota_reset_date_utc: "bad" }).resetDate, null)
  assert.equal(parsed.quotas.premiumInteractions.remaining, 25.5)
  assert.equal(parsed.quotas.premiumInteractions.entitlement, 300)
  assert.equal(parsed.quotas.premiumInteractions.creditsUsed, 17.25)
  assert.equal(parsed.quotas.premiumInteractions.timestampUtc, "2026-10-06T14:40:30.429-07:00")
  assert.equal(parsed.quotas.premiumInteractions.tokenBasedBilling, true)
  assert.equal(parsed.quotas.premiumInteractions.hasQuota, false)
  assert.equal(parsed.tokenBasedBilling, null)
  assert.equal(parsed.quotas.completions.entitlement, null)
  assert.equal(parsed.quotas.completions.unlimited, true)
  assert.equal(parsed.quotas.completions.remaining, null)
  assert.ok(!JSON.stringify(parsed).includes("must-not-leak"))
  const malformed = parseUsage({ copilot_plan: "secret with spaces", quota_snapshots: { chat: { remaining: "40", unlimited: 1, entitlement: Infinity } } })
  assert.equal(malformed.plan, null)
  assert.deepEqual(malformed.quotas.chat, { entitlement: null, remaining: null, percentRemaining: null, unlimited: null, overageCount: null, overagePermitted: null, creditsUsed: null, timestampUtc: null, tokenBasedBilling: null, hasQuota: null })
  assert.equal(parseUsage({}), null)
  assert.equal(parseUsage({ quota_snapshots: [] }), null)
  assert.deepEqual(parseUsage({ copilot_plan: "business" }).quotas, { chat: null, completions: null, premiumInteractions: null })
})

test("rejects negative, nonfinite, and out-of-range usage numbers without estimating", () => {
  const data = parseUsage({ token_based_billing: true, quota_snapshots: { premium_interactions: {
    entitlement: -10, quota_remaining: "-1", remaining: 8, credits_used: Infinity,
    percent_remaining: 100.01, overage_count: -1, unlimited: true, has_quota: false,
  } } })
  const q = data.quotas.premiumInteractions
  assert.equal(q.entitlement, null)
  assert.equal(q.remaining, null)
  assert.equal(q.creditsUsed, null)
  assert.equal(q.percentRemaining, null)
  assert.equal(q.overageCount, null)
  assert.equal(q.unlimited, true)
  assert.equal(q.hasQuota, false)
  assert.equal(data.tokenBasedBilling, true)
  for (const [percent, expected] of [[-1, null], [0, 0], [100, 100], [101, null]]) {
    assert.equal(parseUsage({ quota_snapshots: { premium_interactions: { percent_remaining: percent } } }).quotas.premiumInteractions.percentRemaining, expected)
  }
  assert.equal(parseUsage({ quota_snapshots: { premium_interactions: { remaining: 8 } } }).quotas.premiumInteractions.remaining, null)
})

test("only GETs the two specified GitHub endpoints; caches and rate-limits manual refresh", async () => {
  endpoints.length = 0
  const f = fixture(successFetch)
  const first = await f.service.get({ refresh: false })
  assert.equal(first.status, "ok")
  assert.equal(first.data.login, "valid-user")
  assert.equal(first.data.loginStatus, "ok")
  assert.equal(first.stale, false)
  assert.equal(first.fetchedAt, f.now())
  assert.equal(endpoints.length, 2)
  for (const [url, options] of endpoints) {
    assert.ok(["https://api.github.com/user", "https://api.github.com/copilot_internal/user"].includes(url))
    assert.equal(options.method, "GET")
    assert.equal(options.headers["User-Agent"], "opencode-copilot-usage")
    assert.equal(options.redirect, "error")
  }
  assert.ok(!JSON.stringify(first).includes("token-a"))
  assert.ok(!JSON.stringify(first).includes("must-not-leak"))
  assert.equal((await f.service.get({ refresh: false })).status, "ok")
  const limited = await f.service.get({ refresh: true })
  assert.equal(limited.status, "rate_limited")
  assert.equal(limited.retryAfter, f.now() + REFRESH_INTERVAL_MS)
  assert.equal(limited.stale, false)
  assert.equal(endpoints.length, 2)
  f.setTime(f.now() + REFRESH_INTERVAL_MS)
  assert.equal((await f.service.get({ refresh: true })).status, "ok")
  assert.equal(endpoints.length, 4)
  f.setTime(f.now() + CACHE_MS)
  assert.equal((await f.service.get({ refresh: false })).status, "ok")
  assert.equal(endpoints.length, 6)
})

test("snapshot age is marked stale even on success or cached reads; absent timestamp stays unavailable", async () => {
  const timestamp = Date.parse(payload.quota_snapshots.premium_interactions.timestamp_utc)
  const f = fixture(successFetch)
  f.setTime(timestamp + SNAPSHOT_MAX_AGE_MS - 1)
  assert.equal((await f.service.get({ refresh: false })).stale, false)
  f.setTime(timestamp + SNAPSHOT_MAX_AGE_MS + 1)
  const cached = await f.service.get({ refresh: false })
  assert.equal(cached.status, "ok")
  assert.equal(cached.stale, true)
  const absent = fixture(async (url) => url.includes("copilot_internal") ? json({ quota_snapshots: { premium_interactions: { quota_remaining: 3 } } }) : json({ login: "user" }))
  const result = await absent.service.get({ refresh: false })
  assert.equal(result.data.quotas.premiumInteractions.timestampUtc, null)
  assert.equal(result.stale, false)
})

test("uses the Copilot OAuth access token for the GitHub profile request", async () => {
  const f = fixture(async (url, options) => {
    if (url.endsWith("/copilot_internal/user")) {
      assert.equal(options.headers.Authorization, "Bearer quota-token")
      return json(payload)
    }
    return options.headers.Authorization === "Bearer profile-token" ? json({ login: "profile-user" }) : json({}, 403)
  })
  f.setActive({ id: "account-a", token: "quota-token", access: "profile-token" })
  const result = await f.service.get({ refresh: false })
  assert.equal(result.status, "ok")
  assert.equal(result.data.login, "profile-user")
  assert.doesNotMatch(JSON.stringify(result), /quota-token|profile-token/)
})

test("accepts documented GitHub Enterprise Managed User logins", async () => {
  const f = fixture(async (url) => url.endsWith("/copilot_internal/user") ? json(payload) : json({ login: "Mona-Cat_octo" }))
  assert.equal((await f.service.get({ refresh: false })).data.login, "Mona-Cat_octo")
})

test("Business usage and profile calls stay on api.github.com regardless of enterprise metadata", async () => {
  for (const enterpriseUrl of ["https://Example.ghe.com/", "example.invalid", "attacker@example.ghe.com"]) {
    const urls = []
    const f = fixture(async (url, options) => {
      urls.push(url)
      assert.equal(options.headers.Authorization, "Bearer token-a")
      assert.equal(options.redirect, "error")
      return url === "https://api.github.com/copilot_internal/user" ? json({ ...payload, copilot_plan: "business" }) : json({}, 403)
    })
    f.setActive({ id: "account-a", access: "token-a", metadata: { enterpriseUrl, apiEndpoint: "https://example.invalid" } })
    const result = await f.service.get({ refresh: false })
    assert.equal(result.status, "ok")
    assert.equal(result.data.plan, "business")
    assert.equal(result.data.login, null)
    assert.equal(result.data.loginStatus, "forbidden")
    assert.deepEqual(urls.sort(), ["https://api.github.com/copilot_internal/user", "https://api.github.com/user"])
  }
})

test("profile status is sanitized and never invalidates successful quotas", async () => {
  for (const [mode, expected] of [
    [401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network_error"],
    ["rate-limit-remaining", "rate_limited"], ["retry-after", "rate_limited"], ["network", "network_error"],
    ["bad-json", "invalid_response"], ["invalid-login", "invalid_response"],
    ["missing-login", "invalid_response"], ["echoed-token", "invalid_response"],
  ]) {
    const f = fixture(async (url) => {
      if (url.endsWith("/copilot_internal/user")) return json({ ...payload, organization_list: [{ login: "not-the-user" }] })
      if (typeof mode === "number") return json({ login: "not-a-success", message: "private-response" }, mode)
      if (mode === "rate-limit-remaining") return json({}, 403, { "x-ratelimit-remaining": "0" })
      if (mode === "retry-after") return json({}, 403, { "retry-after": "60" })
      if (mode === "network") throw new Error("private-exception")
      if (mode === "bad-json") return new Response("{", { status: 200 })
      if (mode === "missing-login") return json({ name: "not-a-login", username: "not-a-login" })
      if (mode === "echoed-token") return json({ login: "token-a" })
      return json({ login: "invalid user" })
    })
    f.setActive({ id: "account-a", token: "token-a", label: "custom-label", metadata: { login: "not-verified" } })
    const result = await f.service.get({ refresh: false })
    assert.equal(result.status, "ok", mode)
    assert.equal(result.data.login, null, mode)
    assert.equal(result.data.loginStatus, expected, mode)
    assert.equal(result.data.plan, "individual_pro", mode)
    assert.equal(result.retryAfter, null, mode)
    assert.doesNotMatch(JSON.stringify(result), /private-response|private-exception|not-a-success|token-a/)
  }
})

test("classifies failures, retains stale data, backs off, then recovers", async () => {
  for (const [mode, expected] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network_error"], ["network", "network_error"], ["json", "invalid_response"], ["shape", "invalid_response"]]) {
    let next = "ok"
    let calls = 0
    const f = fixture(async (url) => {
      if (url.endsWith("/user") && !url.includes("copilot_internal")) return json({ login: "user" })
      calls++
      if (next === "network") throw new Error("sensitive message")
      if (next === "json") return new Response("{")
      if (next === "shape") return json({ changed_api: true })
      if (next !== "ok") return json({}, next, next === 429 ? { "retry-after": "60" } : {})
      return json(payload)
    })
    const first = await f.service.get({ refresh: false })
    f.setTime(f.now() + REFRESH_INTERVAL_MS)
    next = mode
    const failure = await f.service.get({ refresh: true })
    assert.equal(failure.status, expected, String(mode))
    assert.deepEqual(failure.data, first.data)
    assert.equal(failure.stale, true)
    assert.equal(failure.fetchedAt, first.fetchedAt)
    assert.ok(failure.retryAfter > f.now())
    assert.ok(!JSON.stringify(failure).includes("sensitive"))
    assert.equal((await f.service.get({ refresh: false })).status, expected)
    assert.equal(calls, 2)
    next = "ok"
    f.setTime(failure.retryAfter)
    assert.equal((await f.service.get({ refresh: true })).status, "ok")
  }
})

test("first-fetch errors have no stale data and preserve status", async () => {
  for (const [code, status] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "network_error"]]) {
    const f = fixture(async (url) => url.includes("copilot_internal") ? json({}, code) : json({}, 401))
    const result = await f.service.get({ refresh: false })
    assert.equal(result.status, status)
    assert.equal(result.data, null)
    assert.equal(result.fetchedAt, null)
    assert.equal(result.stale, false)
    assert.ok(result.retryAfter > f.now())
  }
})

test("concurrent requests are merged", async () => {
  let resolve
  let calls = 0
  const wait = new Promise((r) => { resolve = r })
  const f = fixture(async (url) => {
    if (!url.includes("copilot_internal")) return json({ login: "user" })
    calls++
    await wait
    return json(payload)
  })
  const a = f.service.get({ refresh: false })
  const b = f.service.get({ refresh: true })
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  resolve()
  assert.deepEqual(await a, await b)
})

test("account switch and sign out isolate the cache, including in-flight requests", async () => {
  let release
  const wait = new Promise((r) => { release = r })
  const f = fixture(async (url, options) => {
    if (!url.includes("copilot_internal")) return options.headers.Authorization === "Bearer token-a" ? json({}, 403) : json({ login: "bob" })
    if (options.headers.Authorization === "Bearer token-a") await wait
    return json(payload)
  })
  const old = f.service.get({ refresh: false })
  await new Promise((r) => setImmediate(r))
  f.setActive({ id: "account-b", token: "token-b" })
  const current = await f.service.get({ refresh: false })
  assert.equal(current.data.login, "bob")
  assert.equal(current.data.loginStatus, "ok")
  release()
  assert.deepEqual((await old).data, current.data)
  f.setActive(null)
  assert.deepEqual(await f.service.get({ refresh: false }), { status: "not_authenticated", data: null, stale: false, fetchedAt: null, retryAfter: null })
})

test("a profile token change invalidates the username cache even if the quota token stays the same", async () => {
  const f = fixture(async (url, options) => {
    if (url.endsWith("/copilot_internal/user")) return json(payload)
    return options.headers.Authorization === "Bearer token-a" ? json({ login: "alice" }) : json({}, 403)
  })
  assert.equal((await f.service.get({ refresh: false })).data.login, "alice")
  f.setActive({ id: "account-a", token: "token-a", access: "new-token" })
  const result = await f.service.get({ refresh: false })
  assert.equal(result.status, "ok")
  assert.equal(result.data.login, null)
  assert.equal(result.data.loginStatus, "forbidden")
})

test("non-OAuth credentials and no connection are not authenticated", async () => {
  const service = new UsageService({ connection: { active: async () => ({ id: "x" }), resolve: async () => ({ type: "key", key: "secret" }) } }, () => { throw new Error("must not call") })
  assert.equal((await service.get({ refresh: false })).status, "not_authenticated")
})
