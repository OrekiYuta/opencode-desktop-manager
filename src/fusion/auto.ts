/**
 * HTTP client for Copilot's private /auto, /meta and /models endpoints.
 * Everything here fails soft: no function throws, errors come back as
 * result objects or undefined.
 */
import { COPILOT_API_VERSION, parseFusionMeta, type FusionMetaTiers } from "./tiers.js"
import { wirePath, type Wire } from "./wire.js"
import type { FetchLike } from "./creds.js"

export interface RouteEntry {
  readonly modelId: string
  readonly sessionToken: string
  readonly expiresAtMs: number
  /** vision support of the picked model: null = unknown */
  readonly vision: boolean | null
  turns: number
}

export type RouteResult =
  | { readonly ok: true; readonly entry: RouteEntry }
  | { readonly ok: false; readonly reason: string; readonly code?: string }

export interface RouteRequest {
  readonly baseURL: string
  readonly token: string
  readonly credsKey: string
  readonly sessionID: string
  readonly variant: string
  readonly wire: Wire
  readonly tier: string
  readonly text: string
  readonly image: boolean
  readonly route: "conversation" | "prompt"
}

const ONE_HOUR_MS = 60 * 60_000
const META_TTL_MS = 60_000
const MAX_EXPIRY_MS = 25 * 60 * 60_000

function endpointsInclude(endpoints: unknown, wire: Wire): boolean | null {
  if (!Array.isArray(endpoints)) return null
  const list = endpoints.filter((e): e is string => typeof e === "string")
  if (list.length === 0) return null
  const path = wirePath(wire)
  if (list.includes(path)) return true
  if (wire === "messages" && list.some((e) => e.endsWith("/messages"))) return true
  return false
}

export interface AutoResponse {
  readonly modelId: string
  readonly sessionToken: string
  readonly expiresAtMs: number
  readonly endpoints: unknown
  readonly vision: boolean | null
  readonly hydraScores?: unknown
  readonly discountedCosts?: unknown
}

export function parseAutoResponse(data: unknown, now: number): AutoResponse | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const record = data as Record<string, unknown>
  const sessionToken = typeof record.session_token === "string" ? record.session_token.trim() : ""
  const selected = (record.selected_model ?? {}) as Record<string, unknown>
  const modelId = typeof selected.id === "string" ? selected.id.trim() : ""
  if (!sessionToken || !modelId) return undefined
  // expires_at is unix seconds; clamp to at most 25h ahead so a bogus/ms
  // value cannot pin a dead token forever.
  const rawSec = typeof record.expires_at === "number" && Number.isFinite(record.expires_at) ? record.expires_at : null
  const expiresAtMs = rawSec === null ? now + 24 * 3600 * 1000 : Math.min(rawSec * 1000, now + MAX_EXPIRY_MS)
  const input = (selected.capabilities as { input?: unknown } | undefined)?.input
  const vision = Array.isArray(input) ? input.includes("image") || input.includes("image_url") : null
  return {
    modelId,
    sessionToken,
    expiresAtMs,
    endpoints: selected.supported_endpoints,
    vision,
    hydraScores: record.hydra_scores,
    discountedCosts: record.discounted_costs,
  }
}

/**
 * One client, one fetch wrapper, one header set. Auth is a bearer token;
 * the API version header matches current first-party clients.
 */
export class CopilotClient {
  constructor(
    private readonly options: {
      readonly fetchImpl?: FetchLike
      readonly timeoutMs?: number
      readonly now?: () => number
    } = {},
  ) {}

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 5_000
  }

  /**
   * Retry transient connect/TLS failures. Some networks (and Bun's fetch)
   * regularly drop the first connection to the Copilot API; one retry usually
   * succeeds where the first attempt times out.
   */
  private async requestWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let last: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
      } catch (error) {
        last = error
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
      }
    }
    throw last
  }

  private async postJson(url: string, token: string, body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; reason: string; code?: string }> {
    let response: Response
    try {
      response = await this.requestWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": COPILOT_API_VERSION,
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      return { ok: false, reason: `network error: ${describeError(error)}`, code: "network" }
    }
    if (!response.ok) {
      // Do not echo the upstream body: it can contain prompt fragments.
      return { ok: false, reason: `HTTP ${response.status}`, code: `http_${response.status}` }
    }
    try {
      return { ok: true, data: await response.json() }
    } catch {
      return { ok: false, reason: "response was not JSON", code: "bad_json" }
    }
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    try {
      const response = await this.requestWithRetry(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": COPILOT_API_VERSION,
        },
      })
      if (!response.ok) return undefined
      return await response.json()
    } catch {
      return undefined
    }
  }

  /** Route a prompt via /auto. Never throws. */
  async selectModel(input: {
    baseURL: string
    token: string
    prompt: string
    hasImage: boolean
    tier: string
    turnsSinceAnchor: number
  }): Promise<{ ok: true; auto: AutoResponse } | { ok: false; reason: string; code?: string }> {
    const payload: Record<string, unknown> = {
      prompt: input.prompt.trim() === "" ? "Continue." : input.prompt,
      tier: input.tier,
      multi_turn: { routing_intent: "anchor", turns_since_anchor: input.turnsSinceAnchor },
    }
    if (input.hasImage) payload.has_image = true
    const result = await this.postJson(`${input.baseURL}/auto`, input.token, payload)
    if (!result.ok) return result
    const parsed = parseAutoResponse(result.data, this.now)
    if (!parsed) return { ok: false, reason: "response missing session_token or selected_model.id", code: "bad_shape" }
    return { ok: true, auto: parsed }
  }

  private metaCache: { value: FusionMetaTiers | undefined; at: number; baseURL: string } | undefined
  private catalogCache: { value: Map<string, string[] | null>; at: number; baseURL: string } | undefined

  /** GET /meta (cached briefly, keyed by host). Undefined on failure. */
  async getMeta(baseURL: string, token: string): Promise<FusionMetaTiers | undefined> {
    if (this.metaCache && this.now - this.metaCache.at < META_TTL_MS && this.metaCache.baseURL === baseURL) {
      return this.metaCache.value
    }
    const value = await this.getJson(`${baseURL}/meta`, token).then(parseFusionMeta)
    this.metaCache = { value, at: this.now, baseURL }
    return value
  }

  /** GET /models (cached an hour, keyed by host). Empty map on failure. */
  private async getCatalog(baseURL: string, token: string): Promise<Map<string, string[] | null>> {
    if (this.catalogCache && this.now - this.catalogCache.at < ONE_HOUR_MS && this.catalogCache.baseURL === baseURL) {
      return this.catalogCache.value
    }
    const value = new Map<string, string[] | null>()
    const payload = (await this.getJson(`${baseURL}/models`, token)) as { data?: unknown } | undefined
    if (Array.isArray(payload?.data)) {
      for (const raw of payload.data) {
        if (typeof raw !== "object" || raw === null) continue
        const item = raw as { id?: unknown; supported_endpoints?: unknown }
        if (typeof item.id !== "string") continue
        const endpoints = Array.isArray(item.supported_endpoints)
          ? item.supported_endpoints.filter((e): e is string => typeof e === "string")
          : null
        value.set(item.id, endpoints)
      }
    }
    this.catalogCache = { value, at: this.now, baseURL }
    return value
  }

  /** true / false / null when unknown. */
  async supportsWire(baseURL: string, token: string, modelId: string, wire: Wire, endpointsFromAuto: unknown): Promise<boolean | null> {
    const direct = endpointsInclude(endpointsFromAuto, wire)
    if (direct !== null) return direct
    const catalog = await this.getCatalog(baseURL, token)
    return endpointsInclude(catalog.get(modelId) ?? null, wire)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
