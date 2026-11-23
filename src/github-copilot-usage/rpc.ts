import { Rpc } from "@opencode/plugin/rpc"

export type LoginStatus = "ok" | "unauthorized" | "forbidden" | "network_error" | "invalid_response" | "rate_limited"
export type UsageStatus = LoginStatus | "not_authenticated"
export interface UsageQuota {
  entitlement: number | null
  remaining: number | null
  percentRemaining: number | null
  unlimited: boolean | null
  overageCount: number | null
  overagePermitted: boolean | null
  creditsUsed: number | null
  timestampUtc: string | null
  tokenBasedBilling: boolean | null
  hasQuota: boolean | null
}
export interface UsageData {
  /** Authenticated GitHub login; null if unavailable, even when quotas were fetched. */
  login: string | null
  /** Profile lookup outcome for this usage snapshot; independent of quota status. */
  loginStatus: LoginStatus
  plan: string | null
  resetDate: string | null
  tokenBasedBilling: boolean | null
  quotas: { chat: UsageQuota | null; completions: UsageQuota | null; premiumInteractions: UsageQuota | null }
}
export interface UsageResult {
  status: UsageStatus
  data: UsageData | null
  stale: boolean
  /** Unix milliseconds of the last successful usage response. */
  fetchedAt: number | null
  /** Unix milliseconds when another request may be attempted. */
  retryAfter: number | null
}

const nullableNumber = { type: ["number", "null"] }
const nullableBoolean = { type: ["boolean", "null"] }
const nullableString = { type: ["string", "null"] }
const quota = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        entitlement: nullableNumber, remaining: nullableNumber, percentRemaining: nullableNumber,
        unlimited: nullableBoolean, overageCount: nullableNumber, overagePermitted: nullableBoolean,
        creditsUsed: nullableNumber, timestampUtc: nullableString, tokenBasedBilling: nullableBoolean, hasQuota: nullableBoolean,
      },
      required: ["entitlement", "remaining", "percentRemaining", "unlimited", "overageCount", "overagePermitted", "creditsUsed", "timestampUtc", "tokenBasedBilling", "hasQuota"],
      additionalProperties: false,
    },
  ],
}

export const UsageRpc = Rpc.define({
  id: "copilot-usage",
  events: {},
  methods: {
    get: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        required: ["refresh"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "not_authenticated", "unauthorized", "forbidden", "network_error", "invalid_response", "rate_limited"] },
          data: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  login: nullableString,
                  loginStatus: { type: "string", enum: ["ok", "unauthorized", "forbidden", "rate_limited", "network_error", "invalid_response"] },
                  plan: nullableString, resetDate: nullableString, tokenBasedBilling: nullableBoolean,
                  quotas: {
                    type: "object",
                    properties: { chat: quota, completions: quota, premiumInteractions: quota },
                    required: ["chat", "completions", "premiumInteractions"],
                    additionalProperties: false,
                  },
                },
                required: ["login", "loginStatus", "plan", "resetDate", "tokenBasedBilling", "quotas"],
                additionalProperties: false,
              },
            ],
          },
          stale: { type: "boolean" }, fetchedAt: nullableNumber, retryAfter: nullableNumber,
        },
        required: ["status", "data", "stale", "fetchedAt", "retryAfter"],
        additionalProperties: false,
      },
    },
  },
})
