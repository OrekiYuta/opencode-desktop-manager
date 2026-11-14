import { test } from "node:test"
import assert from "node:assert/strict"
import {
  modelKey,
  formatLatency,
  formatTime,
  formatDateTime,
  computeSummary,
  findModelForElement,
  isFreeUsageLimitError,
  testSingleModel,
  testMultipleModels,
} from "../src/model-tester.ts"

test("modelKey formats providerID and modelID", () => {
  assert.equal(modelKey("openai", "gpt-4o"), "openai:gpt-4o")
  assert.equal(modelKey("anthropic", "claude-3-5-sonnet"), "anthropic:claude-3-5-sonnet")
})

test("formatLatency formats milliseconds and seconds appropriately", () => {
  assert.equal(formatLatency(undefined), "")
  assert.equal(formatLatency(NaN), "")
  assert.equal(formatLatency(245), "245ms")
  assert.equal(formatLatency(999), "999ms")
  assert.equal(formatLatency(1000), "1.0s")
  assert.equal(formatLatency(1240), "1.2s")
  assert.equal(formatLatency(2500), "2.5s")
})

test("formatTime formats timestamps correctly", () => {
  assert.equal(formatTime(undefined), "")
  assert.equal(formatTime(NaN), "")
  const ts = new Date("2026-03-30T14:05:09Z").getTime()
  assert.match(formatTime(ts), /\d{2}:\d{2}:\d{2}/)
})

test("formatDateTime formats date and time correctly", () => {
  assert.equal(formatDateTime(undefined), "")
  assert.equal(formatDateTime(NaN), "")
  const ts = new Date(2026, 2, 30, 14, 5, 9).getTime()
  assert.equal(formatDateTime(ts), "2026-03-30 14:05:09")
})

test("computeSummary aggregates test results", () => {
  const results = [
    { key: "a:1", providerID: "a", modelID: "1", modelName: "M1", status: "success", testedAt: 100 },
    { key: "a:2", providerID: "a", modelID: "2", modelName: "M2", status: "error", testedAt: 200, error: "Failed" },
    { key: "b:1", providerID: "b", modelID: "1", modelName: "M3", status: "success", testedAt: 150 },
  ]
  const summary = computeSummary(results)
  assert.equal(summary.total, 3)
  assert.equal(summary.success, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.testedAt, 200)
})

test("findModelForElement matches row title to model metadata", () => {
  const models = [
    { id: "gpt-4o", modelID: "gpt-4o", providerID: "openai", name: "GPT-4o" },
    { id: "claude-3-5-sonnet", modelID: "claude-3-5-sonnet", providerID: "anthropic", name: "Claude 3.5 Sonnet" },
    { id: "copilot-gpt-4o", modelID: "gpt-4o", providerID: "github-copilot", name: "GPT-4o" },
  ]
  const providers = [
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
    { id: "github-copilot", name: "GitHub Copilot" },
  ]

  // Unique name match
  const match1 = findModelForElement("Claude 3.5 Sonnet", "Anthropic", models, providers)
  assert.equal(match1?.id, "claude-3-5-sonnet")

  // Disambiguate duplicate names via provider
  const match2 = findModelForElement("GPT-4o", "GitHub Copilot", models, providers)
  assert.equal(match2?.id, "copilot-gpt-4o")

  const match3 = findModelForElement("GPT-4o", "OpenAI", models, providers)
  assert.equal(match3?.id, "gpt-4o")

  // Return undefined for unknown model
  assert.equal(findModelForElement("Unknown-Model-X", "OpenAI", models, providers), undefined)
})

test("testSingleModel calls experimental.generate.text and returns success", async () => {
  let calledPrompt = ""
  let calledModel = null

  const mockClient = {
    experimental: {
      generate: {
        text: async ({ prompt, model }) => {
          calledPrompt = prompt
          calledModel = model
          return { text: "2" }
        },
      },
    },
  }

  const model = { id: "gpt-4o", modelID: "gpt-4o", providerID: "openai", name: "GPT-4o" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "success")
  assert.equal(result.providerID, "openai")
  assert.equal(result.modelID, "gpt-4o")
  assert.equal(result.reply, "2")
  assert.ok(result.latency && result.latency > 0)
  assert.equal(calledModel.id, "gpt-4o")
  assert.equal(calledModel.providerID, "openai")
})

test("testSingleModel handles client failure as error result", async () => {
  const mockClient = {
    experimental: {
      generate: {
        text: async () => {
          throw new Error("API Key Invalid")
        },
      },
    },
  }

  const model = { id: "gpt-4o", modelID: "gpt-4o", providerID: "openai", name: "GPT-4o" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "error")
  assert.equal(result.error, "API Key Invalid")
})

test("isFreeUsageLimitError recognizes the OpenCode free-tier rejection", () => {
  assert.equal(isFreeUsageLimitError("Free usage limit reached. Free models work in OpenCode"), true)
  assert.equal(isFreeUsageLimitError(new Error("Free usage limit reached. Free models work in OpenCode")), true)
  assert.equal(isFreeUsageLimitError(new Error("API Key Invalid")), false)
  assert.equal(isFreeUsageLimitError(undefined), false)
})

test("testSingleModel falls back to a temporary session on the free usage limit", async () => {
  const calls = []
  const mockClient = {
    experimental: {
      generate: {
        text: async () => {
          throw new Error("Free usage limit reached. Free models work in OpenCode (https://opencode.ai)")
        },
      },
    },
    session: {
      create: async ({ title, model }) => {
        calls.push({ step: "create", title, model })
        return { id: "ses_probe" }
      },
      generate: async ({ sessionID, prompt }) => {
        calls.push({ step: "generate", sessionID, prompt })
        return { text: "2" }
      },
      remove: async ({ sessionID }) => {
        calls.push({ step: "remove", sessionID })
      },
    },
  }

  const model = { id: "deepseek-free", modelID: "deepseek-free", providerID: "opencode", name: "DeepSeek Free" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "success")
  assert.equal(result.reply, "2")
  assert.ok(result.latency && result.latency > 0)
  assert.deepEqual(calls.map((call) => call.step), ["create", "generate", "remove"])
  assert.equal(calls[0].model.id, "deepseek-free")
  assert.equal(calls[0].model.providerID, "opencode")
  assert.equal(calls[1].sessionID, "ses_probe")
  assert.equal(calls[2].sessionID, "ses_probe")
})

test("testSingleModel removes the probe session when the fallback fails", async () => {
  const removed = []
  const mockClient = {
    experimental: {
      generate: {
        text: async () => {
          throw new Error("Free usage limit reached. Free models work in OpenCode (https://opencode.ai)")
        },
      },
    },
    session: {
      create: async () => ({ id: "ses_probe" }),
      generate: async () => {
        throw new Error("Quota still exhausted")
      },
      remove: async ({ sessionID }) => {
        removed.push(sessionID)
      },
    },
  }

  const model = { id: "deepseek-free", modelID: "deepseek-free", providerID: "opencode", name: "DeepSeek Free" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "error")
  assert.equal(result.error, "Quota still exhausted")
  assert.deepEqual(removed, ["ses_probe"])
})

test("testSingleModel does not create a session for unrelated errors", async () => {
  let created = false
  const mockClient = {
    experimental: {
      generate: {
        text: async () => {
          throw new Error("API Key Invalid")
        },
      },
    },
    session: {
      create: async () => {
        created = true
        return { id: "ses_probe" }
      },
      generate: async () => ({ text: "2" }),
      remove: async () => {},
    },
  }

  const model = { id: "deepseek-free", modelID: "deepseek-free", providerID: "opencode", name: "DeepSeek Free" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "error")
  assert.equal(result.error, "API Key Invalid")
  assert.equal(created, false)
})

test("testSingleModel keeps the free usage limit error when no session API exists", async () => {
  const mockClient = {
    experimental: {
      generate: {
        text: async () => {
          throw new Error("Free usage limit reached. Free models work in OpenCode (https://opencode.ai)")
        },
      },
    },
  }

  const model = { id: "deepseek-free", modelID: "deepseek-free", providerID: "opencode", name: "DeepSeek Free" }
  const result = await testSingleModel(mockClient, model)

  assert.equal(result.status, "error")
  assert.match(result.error, /free usage limit/i)
})

test("testSingleModel reports a missing stateless API instead of guessing", async () => {
  let created = false
  const mockClient = {
    session: {
      create: async () => {
        created = true
        return { id: "ses_probe" }
      },
      generate: async () => ({ text: "2" }),
      remove: async () => {},
    },
  }

  const model = { id: "gpt-4o", modelID: "gpt-4o", providerID: "openai", name: "GPT-4o" }
  const result = await testSingleModel(mockClient, model)

  // Without a stateless call there is no free-limit error to match, so the
  // original "generate.text API unavailable" error is reported.
  assert.equal(result.status, "error")
  assert.match(result.error, /generate\.text API unavailable/)
  assert.equal(created, false)
})

test("testMultipleModels tests models concurrently and calls callbacks", async () => {
  const models = [
    { id: "m1", modelID: "m1", providerID: "p1", name: "M1" },
    { id: "m2", modelID: "m2", providerID: "p2", name: "M2" },
    { id: "m3", modelID: "m3", providerID: "p3", name: "M3" },
  ]

  const started = []
  const completed = []

  const mockClient = {
    experimental: {
      generate: {
        text: async ({ model }) => {
          if (model.id === "m2") throw new Error("Connection Refused")
          return { text: "OK" }
        },
      },
    },
  }

  const results = await testMultipleModels(mockClient, models, {
    concurrency: 2,
    onStartModel: (m) => started.push(m.id),
    onModelResult: (r) => completed.push(r.key),
  })

  assert.equal(results.length, 3)
  assert.deepEqual(started, ["m1", "m2", "m3"])
  assert.equal(completed.length, 3)
  assert.equal(results.filter((r) => r.status === "success").length, 2)
  assert.equal(results.filter((r) => r.status === "error").length, 1)
})
