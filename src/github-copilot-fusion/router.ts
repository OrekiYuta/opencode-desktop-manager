/**
 * Sticky Fusion router. Holds the per-session model decision and the turn
 * bookkeeping (`turns_since_anchor`). All network access lives in
 * CopilotClient; this class owns caching and policy only.
 */
import { createHash } from "node:crypto"
import { LruMap } from "./cache.js"
import type { FetchLike } from "./creds.js"
import { CopilotClient, type RouteRequest, type RouteResult, type RouteEntry } from "./auto.js"

export { type RouteRequest, type RouteResult, type RouteEntry }

const FIVE_MINUTES_MS = 5 * 60_000

function hashPrompt(text: string): string | undefined {
  try {
    return createHash("sha256").update(text).digest("hex")
  } catch {
    // Do not fall back to a weaker hash: skip the cache instead.
    return undefined
  }
}

/** Short stable id for a credential, so re-auth invalidates pins. */
export function credsKey(token: string, baseURL: string): string {
  return createHash("sha256").update(`${token} ${baseURL}`).digest("hex").slice(0, 16)
}

export class FusionRouter {
  private readonly cache = new LruMap<string, RouteEntry>(256)
  private readonly inflight = new Map<string, Promise<RouteResult>>()
  private readonly client: CopilotClient

  constructor(
    private readonly options: {
      readonly fetchImpl?: FetchLike
      readonly timeoutMs?: number
      readonly skewMs?: number
      readonly now?: () => number
      readonly log?: (...args: string[]) => void
    } = {},
  ) {
    this.client = new CopilotClient({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, now: options.now })
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get skewMs(): number {
    return this.options.skewMs ?? FIVE_MINUTES_MS
  }

  private log(...args: string[]): void {
    this.options.log?.(...args)
  }

  /** Access to /meta for setup-time variant gating. */
  getMeta(baseURL: string, token: string) {
    return this.client.getMeta(baseURL, token)
  }

  private static readonly SEP = "\u0000"

  private static key(
    credsKey: string,
    sessionID: string,
    variant: string,
    route: "conversation" | "prompt",
    text: string,
  ): string | undefined {
    const SEP = FusionRouter.SEP
    // NUL-separated segments: cannot collide with real session ids or variants.
    if (route === "prompt") {
      const hash = hashPrompt(text)
      return hash ? [credsKey, sessionID, variant, hash].join(SEP) : undefined
    }
    return [credsKey, sessionID, variant].join(SEP)
  }

  /** Drop every cached route for a session (used after compaction). */
  invalidateSession(sessionID: string, creds: string): void {
    const SEP = FusionRouter.SEP
    if (creds) {
      const prefix = [creds, sessionID].join(SEP) + SEP
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(prefix)) this.cache.delete(key)
      }
      return
    }
    const needle = `${SEP}${sessionID}${SEP}`
    for (const key of [...this.cache.keys()]) {
      if (key.includes(needle)) this.cache.delete(key)
    }
  }

  private static isFresh(entry: RouteEntry, now: number, skewMs: number): boolean {
    return entry.expiresAtMs - now > skewMs
  }

  /**
   * Route a prompt. Non-throwing: failures are reported as
   * `{ ok: false, reason }` so callers degrade to the anchor. Concurrent
   * turns for the same key share one /auto call.
   */
  async route(request: RouteRequest): Promise<RouteResult> {
    const { credsKey: k, sessionID, variant, text, route } = request
    const key = FusionRouter.key(k, sessionID, variant, route, text)
    if (key === undefined) {
      return this.routeFresh(request, undefined)
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const promise = this.routePinned(request, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  private async routePinned(request: RouteRequest, key: string): Promise<RouteResult> {
    const cached = this.cache.get(key)
    if (cached && FusionRouter.isFresh(cached, this.now, this.skewMs)) {
      if (!request.image || cached.vision !== false) {
        cached.turns += 1
        return { ok: true, entry: cached }
      }
      this.log(`fusion: re-routing ${key} - image prompt vs pinned model without vision support`)
      this.cache.delete(key)
      // Fresh pick required; do not reuse the stale entry.
      const result = await this.routeFresh(request, undefined)
      return result
    }
    return this.routeFresh(request, cached)
  }

  private async routeFresh(request: RouteRequest, cached: RouteEntry | undefined): Promise<RouteResult> {
    const { baseURL, token, sessionID, variant, tier, text, image, route } = request
    const previousTurns = cached?.turns ?? 0
    const result = await this.client.selectModel({
      baseURL,
      token,
      prompt: text,
      hasImage: image,
      tier,
      turnsSinceAnchor: previousTurns,
    })
    if (!result.ok) return this.previousOrFail(cached, result.reason, result.code)

    const auto = result.auto
    if (image && auto.vision === false) {
      this.log(`fusion: picked ${auto.modelId} but prompt carries an image; falling back to anchor`)
      return { ok: false, reason: `fusion picked ${auto.modelId} without vision support`, code: "no_vision" }
    }

    const allowed = await this.client.supportsWire(baseURL, token, auto.modelId, request.wire, auto.endpoints)
    if (allowed === false) {
      return this.previousOrFail(cached, `selected model ${auto.modelId} does not serve ${request.wire} wire`, "wrong_wire")
    }

    if (this.options.log) {
      this.log(
        `fusion /auto picked ${auto.modelId}${auto.hydraScores ? `; hydra_scores=${JSON.stringify(auto.hydraScores)}` : ""}${auto.discountedCosts ? `; discounted_costs=${JSON.stringify(auto.discountedCosts)}` : ""}`,
      )
    }

    const entry: RouteEntry = {
      modelId: auto.modelId,
      sessionToken: auto.sessionToken,
      expiresAtMs: auto.expiresAtMs,
      vision: auto.vision,
      turns: previousTurns + 1,
    }
    const key = FusionRouter.key(request.credsKey, sessionID, variant, route, text)
    if (key !== undefined) this.cache.set(key, entry)
    return { ok: true, entry }
  }

  /** Reuse the previous route while it is still valid; otherwise fail. */
  private previousOrFail(
    cached: RouteEntry | undefined,
    reason: string,
    code: string | undefined,
  ): RouteResult {
    if (cached && FusionRouter.isFresh(cached, this.now, this.skewMs)) {
      this.log(`fusion: /auto unavailable (${reason}); reusing previous route to ${cached.modelId}`)
      return { ok: true, entry: cached }
    }
    this.log(`fusion: route unavailable (${reason})`)
    return code ? { ok: false, reason, code } : { ok: false, reason }
  }
}
