/**
 * Wire model. The wire decides which request format crosses the wire for a
 * given model; the plugin derives it from the anchor (never from the body).
 */

export type Wire = "responses" | "chat" | "messages"

export function wirePath(wire: Wire): string {
  switch (wire) {
    case "responses":
      return "/responses"
    case "chat":
      return "/chat/completions"
    case "messages":
      return "/v1/messages"
  }
}


/**
 * Derive an anchor model's wire from its package / `settings.endpoint`.
 * The gpt >= 5 / mai / grok heuristic matches the built-in Copilot provider.
 */
export function wireOfAnchor(anchor: { package?: string; settings?: Record<string, unknown>; modelID?: string }): Wire {
  const pkg = typeof anchor.package === "string" ? anchor.package : ""
  if (pkg.includes("providers/anthropic") || pkg.includes("@ai-sdk/anthropic")) return "messages"
  const endpoint = anchor.settings?.endpoint
  if (endpoint === "responses" || endpoint === "chat" || endpoint === "messages") {
    return endpoint as Wire
  }
  const id = typeof anchor.modelID === "string" ? anchor.modelID : ""
  if (/^(mai-|grok-)/.test(id)) return "responses"
  const gpt = /^gpt-(\d+)/.exec(id)
  if (gpt && Number(gpt[1]) >= 5 && !id.startsWith("gpt-5-mini")) return "responses"
  return "chat"
}
