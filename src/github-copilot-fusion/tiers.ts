/**
 * Fusion tier vocabulary.
 *
 * Copilot Fusion is presented to users as three effort levels — Standard,
 * High, Max — but on the wire they are carried by the virtual `auto` model
 * and selected with the `tier` field of `POST /auto`:
 *
 *   Fusion Standard -> balance
 *   Fusion High     -> hydrafusion (falls back to `intelligence` when
 *                      HydraFusion is not offered on the account)
 *   Fusion Max      -> hydrafusion-max (no fallback)
 *
 * Those values come from VS Code's own managed `fusionTier` mapping
 * (`copilotManagedModelConfiguration.ts`): standard -> [balance],
 * high -> [hydrafusion, intelligence], max -> [hydrafusion-max].
 * `efficiency` / `balance` / `intelligence` / `fast` are the classic Auto
 * tiers; only `balance` doubles as a Fusion tier.
 *
 * The 30% Fusion discount (paid plans, through 2026-11-30) is applied
 * server-side to Fusion tier usage; clients never send a discount flag.
 */

export type FusionVariant = "standard" | "high" | "max"

export interface FusionTierSpec {
  /** opencode model variant id (also shown in the TUI variant dialog) */
  readonly variant: FusionVariant
  /** /auto `tier` value to send */
  readonly wire: string
  /** used when `wire` is not enabled on the account (High only) */
  readonly fallbackWire?: string
  /** value for the variant's `reasoningEffort` setting */
  readonly effort: "low" | "high" | "xhigh"
  readonly label: string
}

export const FUSION_TIERS: ReadonlyArray<FusionTierSpec> = [
  { variant: "standard", wire: "balance", effort: "low", label: "Fusion Standard" },
  { variant: "high", wire: "hydrafusion", fallbackWire: "intelligence", effort: "high", label: "Fusion High" },
  { variant: "max", wire: "hydrafusion-max", effort: "xhigh", label: "Fusion Max" },
]

export function isFusionVariant(value: unknown): value is FusionVariant {
  return value === "standard" || value === "high" || value === "max"
}

/** Returns the variant or undefined for anything unrecognized. */
export function normalizeVariant(value: unknown): FusionVariant | undefined {
  return isFusionVariant(value) ? value : undefined
}

export interface TierAvailability {
  /** tier id -> enabled flag from /meta; undefined when unknown */
  readonly byId?: Readonly<Record<string, boolean>>
}

export interface ResolvedTier {
  /** wire tier to send to /auto */
  readonly wire: string
  /** true when `wire` is the fallback (High running on classic Auto `intelligence`) */
  readonly degraded: boolean
}

/**
 * Resolve the wire tier for a variant against /meta tier availability.
 * Unknown / missing / failing /meta never blocks routing — the server gets
 * the canonical tier and will reject it with a clear error if the account
 * cannot run it.
 * Returns null only when /meta is reachable AND the tier is known to be
 * disabled with no usable fallback.
 */
export function resolveWireTier(variant: FusionVariant, byId: TierAvailability["byId"]): ResolvedTier | null {
  const spec = FUSION_TIERS.find((t) => t.variant === variant)!
  if (!byId) return { wire: spec.wire, degraded: false }
  const enabled = (id: string): boolean | undefined => byId[id]
  if (enabled(spec.wire)) return { wire: spec.wire, degraded: false }
  if (variant === "high" && spec.fallbackWire && enabled(spec.fallbackWire) === true) {
    return { wire: spec.fallbackWire, degraded: true }
  }
  if (enabled(spec.wire) === false) return null
  // Not listed by /meta at all — let the server decide.
  return { wire: spec.wire, degraded: false }
}

export interface FusionMetaTiers {
  /** tier id -> enabled */
  readonly byId: Readonly<Record<string, boolean>>
  /** true when at least one type:fusion tier is enabled */
  readonly fusionOffered: boolean
}

/**
 * Parse GET /meta into tier availability. Returns undefined when the document
 * is absent/unrecognised (caller treats tiers as "unknown", not "disabled").
 */
export function parseFusionMeta(payload: unknown): FusionMetaTiers | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const tiers = (payload as { auto?: { tiers?: unknown } }).auto?.tiers
  if (!Array.isArray(tiers)) return undefined
  const byId: Record<string, boolean> = {}
  let fusionOffered = false
  for (const raw of tiers) {
    if (typeof raw !== "object" || raw === null) continue
    const tier = raw as { id?: unknown; type?: unknown; status?: { enabled?: unknown } }
    if (typeof tier.id !== "string") continue
    // Unknown shape is not "disabled" — only a real boolean counts.
    if (typeof tier.status?.enabled === "boolean") {
      byId[tier.id] = tier.status.enabled
      if (tier.type === "fusion" && tier.status.enabled) fusionOffered = true
    }
  }
  return { byId, fusionOffered }
}

/** /auto `X-GitHub-Api-Version` used by the current first-party clients. */
export const COPILOT_API_VERSION = "2026-08-01"
