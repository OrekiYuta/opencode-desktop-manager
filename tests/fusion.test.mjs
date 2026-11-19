import test from "node:test"
import assert from "node:assert/strict"
import { wireOfAnchor } from "../src/fusion/wire.ts"
import { parseFusionOptions, DEFAULT_FUSION_OPTIONS } from "../src/fusion/options.ts"
import { extractPromptFromBody } from "../src/fusion/prompt.ts"
import { normalizeVariant, FUSION_TIERS } from "../src/fusion/tiers.ts"
import { copilotBaseURLFromMetadata, copilotCredentialsFromCredential } from "../src/fusion/creds.ts"
import { sanitizeCallIds } from "../src/fusion/sanitize.ts"

test("sanitizeCallIds: leaves valid call_ids <= 64 chars untouched", () => {
  const body = {
    input: [
      { type: "function_call", call_id: "call_valid_short_id_12345", name: "test" },
      { type: "function_call_output", call_id: "call_valid_short_id_12345", output: "{}" }
    ]
  }
  const changed = sanitizeCallIds(body)
  assert.equal(changed, false)
  assert.equal(body.input[0].call_id, "call_valid_short_id_12345")
  assert.equal(body.input[1].call_id, "call_valid_short_id_12345")
})

test("sanitizeCallIds: shortens overly long call_ids and preserves pair matching", () => {
  const longId = "call_8324482681828700314__thought__" + "A".repeat(1100)
  const otherLongId = "call_9999999999999999999__thought__" + "B".repeat(1100)
  const body = {
    input: [
      { type: "function_call", call_id: longId, name: "my_func" },
      { type: "function_call_output", call_id: longId, output: "ok" },
      { type: "function_call", call_id: otherLongId, name: "other_func" },
      { type: "function_call_output", call_id: otherLongId, output: "done" }
    ],
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: longId, type: "function" }]
      },
      {
        role: "tool",
        tool_call_id: longId,
        content: "ok"
      }
    ]
  }

  const changed = sanitizeCallIds(body)
  assert.equal(changed, true)

  // Under 64 chars
  assert.ok(body.input[0].call_id.length <= 64)
  assert.ok(body.input[0].call_id.startsWith("call_"))

  // Pair matching preserved in Responses format
  assert.equal(body.input[0].call_id, body.input[1].call_id)
  assert.equal(body.input[2].call_id, body.input[3].call_id)
  assert.notEqual(body.input[0].call_id, body.input[2].call_id)

  // Pair matching preserved in Chat format
  assert.equal(body.messages[0].tool_calls[0].id, body.messages[1].tool_call_id)
  assert.equal(body.messages[0].tool_calls[0].id, body.input[0].call_id)
})

test("wireOfAnchor: resolves anthropic wire to messages", () => {
  assert.equal(wireOfAnchor({ package: "@opencode/ai/providers/anthropic", modelID: "claude-opus-5.5" }), "messages")
  assert.equal(wireOfAnchor({ package: "@ai-sdk/anthropic", modelID: "claude-sonnet-5.5" }), "messages")
})

test("wireOfAnchor: resolves modern gpt to responses, mini to chat", () => {
  assert.equal(wireOfAnchor({ modelID: "gpt-6-luna" }), "responses")
  assert.equal(wireOfAnchor({ modelID: "gpt-5.4" }), "responses")
  assert.equal(wireOfAnchor({ modelID: "gpt-5-mini" }), "chat")
  assert.equal(wireOfAnchor({ modelID: "mai-code-1.1-flash" }), "responses")
})

test("wireOfAnchor: honours explicit endpoint setting", () => {
  assert.equal(wireOfAnchor({ settings: { endpoint: "responses" } }), "responses")
  assert.equal(wireOfAnchor({ settings: { endpoint: "chat" } }), "chat")
  assert.equal(wireOfAnchor({ settings: { endpoint: "messages" } }), "messages")
})

test("parseFusionOptions: applies defaults and overrides", () => {
  assert.deepEqual(parseFusionOptions(undefined), DEFAULT_FUSION_OPTIONS)
  const custom = parseFusionOptions({ timeoutMs: 40000, route: "conversation", debug: true })
  assert.equal(custom.timeoutMs, 40000)
  assert.equal(custom.route, "conversation")
  assert.equal(custom.debug, true)
})

test("normalizeVariant: recognizes standard, high, max", () => {
  assert.equal(normalizeVariant("standard"), "standard")
  assert.equal(normalizeVariant("high"), "high")
  assert.equal(normalizeVariant("max"), "max")
  assert.equal(normalizeVariant("unknown"), undefined)
  assert.equal(FUSION_TIERS.length, 3)
})

test("extractPromptFromBody: extracts user text from responses or chat messages", () => {
  const responsesBody = {
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello Fusion" }
    ]
  }
  assert.deepEqual(extractPromptFromBody(responsesBody), { text: "Hello Fusion", image: false })

  const chatBody = {
    messages: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Explain relativity" }
    ]
  }
  assert.deepEqual(extractPromptFromBody(chatBody), { text: "Explain relativity", image: false })
})

test("copilotCredentialsFromCredential: parses token and baseURL", () => {
  const cred = {
    type: "oauth",
    refresh: "gho_test123",
    metadata: { apiEndpoint: "https://api.business.githubcopilot.com" }
  }
  const result = copilotCredentialsFromCredential(cred)
  assert.ok(result)
  assert.equal(result.token, "gho_test123")
  assert.equal(result.baseURL, "https://api.business.githubcopilot.com")
})
