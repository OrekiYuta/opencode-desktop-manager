import type { UsageQuota } from "./rpc.js"

/** Render the instant in the user's local time zone, independent of OS language. */
export function formatUsageDate(value: string | null | undefined, timeZone?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  const [year, month, day, hour, minute] = [part("year"), part("month"), part("day"), part("hour"), part("minute")]
  return year && month && day && hour && minute ? `${year}-${month}-${day} ${hour}:${minute}` : undefined
}

/** A quota is labelled as AI credits only when its billing and quota modes are explicit. */
export function isCreditQuota(quota: UsageQuota | null | undefined): boolean {
  return quota?.tokenBasedBilling === true && quota.unlimited === false && quota.hasQuota === true
}

/** The API reports percent remaining; do not infer a percentage from request counts. */
export function usedPercentage(quota: UsageQuota | null | undefined): number | undefined {
  const remaining = quota?.percentRemaining
  return isCreditQuota(quota) && typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    ? 100 - remaining
    : undefined
}
