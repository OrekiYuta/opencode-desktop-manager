import { createHash } from "node:crypto"

/**
 * Sanitize call_id fields in request bodies for OpenAI / GitHub Copilot.
 * Some models (notably Gemini with reasoning/thinking enabled) produce
 * call_id values containing hundreds or thousands of characters (e.g. `call_xxx__thought__<base64>`).
 * When switching models in the same session to Copilot / OpenAI, Copilot's schema
 * validation rejects the request:
 *   "Invalid 'input[x].call_id': string too long. Expected a string with maximum length 64"
 *
 * This function deterministically maps any call_id > 64 chars to `call_<sha256(id).slice(0, 40)>`
 * (45 chars <= 64), updating both the tool call and the corresponding tool result.
 */
export function sanitizeCallIds(body: Record<string, unknown>): boolean {
  let changed = false
  const idMap = new Map<string, string>()

  function getShortId(id: string): string {
    let shortId = idMap.get(id)
    if (!shortId) {
      const hash = createHash("sha256").update(id).digest("hex").slice(0, 40)
      shortId = `call_${hash}`
      idMap.set(id, shortId)
    }
    return shortId
  }

  function cleanString(val: string): string {
    if (val.length > 64) {
      changed = true
      return getShortId(val)
    }
    return val
  }

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item)
      }
      return
    }

    const record = node as Record<string, unknown>
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === "string") {
        if (key === "call_id" || key === "tool_call_id") {
          record[key] = cleanString(val)
        } else if (
          key === "id" &&
          val.length > 64 &&
          (val.startsWith("call_") ||
            record.type === "function_call" ||
            record.type === "tool_call" ||
            record.type === "function")
        ) {
          record[key] = cleanString(val)
        }
      } else if (typeof val === "object" && val !== null) {
        walk(val)
      }
    }
  }

  walk(body)
  return changed
}
