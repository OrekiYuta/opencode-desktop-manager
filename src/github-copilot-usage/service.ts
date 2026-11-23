import { createHash } from "node:crypto"
import type { FetchLike, IntegrationLike } from "../github-copilot-fusion/creds.js"
import type { LoginStatus, UsageData, UsageQuota, UsageResult, UsageStatus } from "./rpc.js"

export const CACHE_MS = 60_000
export const REFRESH_INTERVAL_MS = 15_000
export const SNAPSHOT_MAX_AGE_MS = 3_600_000
const TIMEOUT_MS = 8_000

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function number(value: unknown): number | null {
  // GitHub sometimes encodes quota numbers as decimal strings.
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
}
function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}
function quota(value: unknown): UsageQuota | null {
  const item = record(value)
  if (!item) return null
  const percentRemaining = number(item.percent_remaining)
  return {
    entitlement: number(item.entitlement), remaining: number(item.quota_remaining),
    percentRemaining: percentRemaining !== null && percentRemaining <= 100 ? percentRemaining : null, unlimited: boolean(item.unlimited),
    overageCount: number(item.overage_count), overagePermitted: boolean(item.overage_permitted),
    creditsUsed: number(item.credits_used), timestampUtc: timestamp(item.timestamp_utc),
    tokenBasedBilling: boolean(item.token_based_billing), hasQuota: boolean(item.has_quota),
  }
}

/** Only known, validated fields leave the server; unfamiliar API fields are discarded. */
export function parseUsage(value: unknown): Omit<UsageData, "login" | "loginStatus"> | null {
  const root = record(value)
  if (!root || !("quota_snapshots" in root || "copilot_plan" in root || "quota_reset_date_utc" in root)) return null
  if (root.quota_snapshots != null && !record(root.quota_snapshots)) return null
  const snapshots = record(root.quota_snapshots)
  const plan = typeof root.copilot_plan === "string" && /^[a-z0-9_-]{1,80}$/i.test(root.copilot_plan) ? root.copilot_plan : null
  const resetDate = timestamp(root.quota_reset_date_utc)
  return {
    plan, resetDate, tokenBasedBilling: boolean(root.token_based_billing),
    quotas: { chat: quota(snapshots?.chat), completions: quota(snapshots?.completions), premiumInteractions: quota(snapshots?.premium_interactions) },
  }
}

function parseLogin(value: unknown): string | null {
  const login = record(value)?.login
  // Enterprise Managed Users on GitHub.com have an underscore and a shortcode.
  return typeof login === "string" && login.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:_[a-z0-9]{3,8})?$/i.test(login) ? login : null
}

type Identity = { key: string; usageToken: string; profileToken: string }
type LoginResult = Pick<UsageData, "login" | "loginStatus">
type Cache = {
  key: string
  data: UsageData | null
  fetchedAt: number | null
  lastAttempt: number | null
  retryAfter: number | null
  lastStatus: UsageStatus
  inFlight?: Promise<UsageResult>
}

export class UsageService<Connection> {
  private cache?: Cache
  private readonly integration: IntegrationLike<Connection>
  private readonly fetcher: FetchLike
  private readonly now: () => number
  constructor(integration: IntegrationLike<Connection>, fetcher: FetchLike = fetch, now: () => number = Date.now) {
    this.integration = integration
    this.fetcher = fetcher
    this.now = now
  }

  private async identity(): Promise<Identity | undefined> {
    try {
      const connection = await this.integration.connection.active("github-copilot")
      if (!connection) return undefined
      const credential = await this.integration.connection.resolve(connection)
      if (!credential || credential.type !== "oauth") return undefined
      const access = typeof credential.access === "string" && credential.access ? credential.access : undefined
      const refresh = typeof credential.refresh === "string" && credential.refresh ? credential.refresh : undefined
      const usageToken = refresh ?? access
      if (!usageToken) return undefined
      // OpenCode's built-in Copilot flow stores the same GitHub access token in
      // both slots; legacy credentials may only have refresh. Prefer access for /user.
      const profileToken = access ?? usageToken
      // The active connection and both token values must match before reusing data.
      const info = record(connection)
      const id = typeof info?.id === "string" ? info.id : ""
      const key = createHash("sha256").update(JSON.stringify([id, usageToken, profileToken])).digest("hex")
      return { key, usageToken, profileToken }
    } catch {
      return undefined
    }
  }

  private result(cache: Cache, status: UsageStatus, stale: boolean, retryAfter: number | null = null): UsageResult {
    const snapshotTime = cache.data?.quotas.premiumInteractions?.timestampUtc
    const snapshotStale = snapshotTime != null && this.now() - Date.parse(snapshotTime) > SNAPSHOT_MAX_AGE_MS
    return { status, data: cache.data, stale: cache.data !== null && (stale || snapshotStale), fetchedAt: cache.fetchedAt, retryAfter }
  }

  async get(input: { refresh: boolean }): Promise<UsageResult> {
    return this.getCurrent(input, 0)
  }

  private async getCurrent(input: { refresh: boolean }, changes: number): Promise<UsageResult> {
    const identity = await this.identity()
    if (!identity) {
      this.cache = undefined
      return { status: "not_authenticated", data: null, stale: false, fetchedAt: null, retryAfter: null }
    }
    if (!this.cache || this.cache.key !== identity.key) {
      this.cache = { key: identity.key, data: null, fetchedAt: null, lastAttempt: null, retryAfter: null, lastStatus: "network_error" }
    }
    const cache = this.cache
    let result: UsageResult
    const now = this.now()
    if (cache.inFlight) {
      result = await cache.inFlight
    } else if (cache.retryAfter !== null && now < cache.retryAfter) {
      result = this.result(cache, input.refresh ? "rate_limited" : cache.lastStatus, cache.lastStatus !== "ok", cache.retryAfter)
    } else if (!input.refresh && cache.data && cache.fetchedAt !== null && now - cache.fetchedAt < CACHE_MS && cache.lastStatus === "ok") {
      result = this.result(cache, "ok", false)
    } else {
      cache.lastAttempt = now
      cache.retryAfter = now + REFRESH_INTERVAL_MS
      const pending = this.fetchUsage(cache, identity)
      cache.inFlight = pending
      try { result = await pending } finally { if (cache.inFlight === pending) cache.inFlight = undefined }
    }
    // Do not return an old account's data when the active credential changes while requests run.
    const current = await this.identity()
    if (!current || current.key !== identity.key || this.cache !== cache) {
      if (changes < 2) return this.getCurrent({ refresh: false }, changes + 1)
      this.cache = undefined
      return { status: "not_authenticated", data: null, stale: false, fetchedAt: null, retryAfter: null }
    }
    return result
  }

  private request(path: "/user" | "/copilot_internal/user", token: string): Promise<Response> {
    return this.fetcher(`https://api.github.com${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "opencode-copilot-usage" },
    })
  }

  private async fetchLogin(identity: Identity): Promise<LoginResult> {
    const failure = (loginStatus: Exclude<LoginStatus, "ok">): LoginResult => ({ login: null, loginStatus })
    try {
      const response = await this.request("/user", identity.profileToken)
      if (response.status === 401) return failure("unauthorized")
      if (response.status === 429 || (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) return failure("rate_limited")
      if (response.status === 403) return failure("forbidden")
      if (!response.ok) return failure("network_error")
      // OpenCode labels can be edited; Copilot organization logins aren't users.
      const login = parseLogin(await response.json())
      if (!login || login === identity.profileToken || login === identity.usageToken) return failure("invalid_response")
      return { login, loginStatus: "ok" }
    } catch (error) {
      return failure(error instanceof SyntaxError ? "invalid_response" : "network_error")
    }
  }

  private async fetchUsage(cache: Cache, identity: Identity): Promise<UsageResult> {
    const login = this.fetchLogin(identity)
    let status: UsageStatus = "network_error"
    let data: Omit<UsageData, "login" | "loginStatus"> | null = null
    try {
      const response = await this.request("/copilot_internal/user", identity.usageToken)
      if (response.status === 401) status = "unauthorized"
      else if (response.status === 403) status = "forbidden"
      else if (response.status === 429) {
        status = "rate_limited"
        const header = response.headers.get("retry-after")
        if (header) {
          const seconds = Number(header)
          const date = Date.parse(header)
          const retry = Number.isFinite(seconds) && seconds >= 0 ? this.now() + seconds * 1000 : date
          if (Number.isFinite(retry)) cache.retryAfter = Math.max(cache.retryAfter ?? 0, Math.min(retry, this.now() + 3_600_000))
        }
      } else if (!response.ok) status = "network_error"
      else {
        try { data = parseUsage(await response.json()) } catch { data = null }
        status = data ? "ok" : "invalid_response"
      }
    } catch { status = "network_error" }
    const profile = await login
    cache.lastStatus = status
    if (data && status === "ok") {
      cache.data = { ...profile, ...data }
      cache.fetchedAt = this.now()
    }
    return this.result(cache, status, status !== "ok", status === "ok" ? null : cache.retryAfter)
  }
}
