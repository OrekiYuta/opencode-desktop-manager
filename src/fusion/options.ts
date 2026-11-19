/** Plugin options (opencode.json `plugins[].options`). */

export interface FusionOptions {
  /** Anchor model id — the catalog model your fusion model impersonates on the wire. */
  readonly anchorModel?: string
  /** Routing granularity: "conversation" (sticky, default) or "prompt". */
  readonly route: "conversation" | "prompt"
  /** Drop `temperature` from routed requests (some routed models 400 on it). */
  readonly stripTemperature: boolean
  /** /auto request timeout. */
  readonly timeoutMs: number
  /** Re-route when the session token is within this many ms of expiry. */
  readonly skewMs: number
  /** Verbose logging to stderr. */
  readonly debug: boolean
}

const DEFAULTS = {
  route: "conversation",
  stripTemperature: true,
  timeoutMs: 5_000,
  skewMs: 5 * 60_000,
  debug: false,
} as const satisfies Partial<FusionOptions>

export const DEFAULT_FUSION_OPTIONS: FusionOptions = { anchorModel: undefined, ...DEFAULTS }

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function pickBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key]
  return typeof value === "boolean" ? value : fallback
}

function pickNumber(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.floor(value)
    : fallback
}

/** Lenient parse — bad values fall back to defaults, never throw. */
export function parseFusionOptions(raw: unknown): FusionOptions {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    anchorModel: pickString(record, "anchorModel"),
    route: pickString(record, "route") === "prompt" ? "prompt" : "conversation",
    stripTemperature: pickBoolean(record, "stripTemperature", DEFAULTS.stripTemperature),
    timeoutMs: pickNumber(record, "timeoutMs", DEFAULTS.timeoutMs, 500, 60_000),
    skewMs: pickNumber(record, "skewMs", DEFAULTS.skewMs, 0, 24 * 60 * 60_000),
    debug: pickBoolean(record, "debug", DEFAULTS.debug) || process.env.FUSION_DEBUG === "1",
  }
}
