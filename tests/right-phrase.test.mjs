import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import test from "node:test"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temp = await mkdtemp(path.join(tmpdir(), "right-phrase-test-"))
const bundle = path.join(temp, "service.mjs")

await build({
  entryPoints: [path.join(root, "src/right-phrase/service.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile: bundle,
  logLevel: "silent",
})

const { generateRightPhrase, modelFromComposer } = await import(pathToFileURL(bundle).href)
test.after(() => rm(temp, { recursive: true, force: true }))

const validOption = (index) => ({
  tone: `Tone ${index}`,
  english: `English ${index}`,
  meaning: `含义 ${index}`,
})

test("maps the current composer model without guessing a variant", () => {
  assert.deepEqual(modelFromComposer({ providerID: "provider", modelID: "model" }), { providerID: "provider", id: "model" })
  assert.deepEqual(modelFromComposer({ providerID: "provider", modelID: "model", variant: "high" }), { providerID: "provider", id: "model", variant: "high" })
})

function clientReturning(text) {
  const calls = []
  return {
    calls,
    client: {
      experimental: {
        generate: {
          text: async (input, options) => {
            calls.push({ input, options })
            return { text }
          },
        },
      },
    },
  }
}

test("say mode asks for five ordered options and passes the model through", async () => {
  const { client, calls } = clientReturning(
    JSON.stringify({ options: [1, 2, 3, 4, 5, 6].map(validOption) }),
  )
  const model = { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "high" }

  const result = await generateRightPhrase(client, {
    mode: "say",
    input: "  帮我把这件事说清楚  ",
    model,
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].input.prompt, /帮我把这件事说清楚/)
  assert.match(calls[0].input.prompt, /exactly 5/)
  assert.match(calls[0].input.prompt, /casual to formal/)
  assert.deepEqual(calls[0].input.model, model)
  assert.equal(result.translation, undefined)
  assert.equal(result.options.length, 5)
  assert.deepEqual(result.options[4], {
    tone: "Tone 5",
    english: "English 5",
    meaning: "含义 5",
  })
})

test("reply mode returns a translation and parses JSON inside prose", async () => {
  const payload = {
    translation: "这是中文翻译。",
    options: [1, 2].map(validOption),
  }
  const { client, calls } = clientReturning(
    `Here is the result:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nThanks.`,
  )

  const result = await generateRightPhrase(client, {
    mode: "reply",
    input: "Could you send the report by Friday?",
  })

  assert.match(calls[0].input.prompt, /Translate/)
  assert.match(calls[0].input.prompt, /Could you send the report by Friday\?/)
  assert.equal(calls[0].input.model, null)
  assert.equal(result.translation, "这是中文翻译。")
  assert.equal(result.options.length, 2)
})

test("trims whitespace and drops options without usable text", async () => {
  const { client } = clientReturning(
    JSON.stringify({
      options: [
        { tone: "  Casual  ", english: "  Hey there  ", meaning: "  你好  " },
        { tone: "Empty", english: "   ", meaning: "" },
        { tone: "Missing" },
      ],
    }),
  )

  const result = await generateRightPhrase(client, { mode: "say", input: "你好" })

  assert.deepEqual(result.options, [{ tone: "Casual", english: "Hey there", meaning: "你好" }])
})

test("rejects empty input before calling the model", async () => {
  const { client, calls } = clientReturning("{}")

  await assert.rejects(
    generateRightPhrase(client, { mode: "say", input: "   " }),
    /Enter text before generating/,
  )
  assert.equal(calls.length, 0)
})

test("rejects unparseable output", async () => {
  const { client } = clientReturning("not json at all")

  await assert.rejects(
    generateRightPhrase(client, { mode: "say", input: "你好" }),
    /could not be parsed/,
  )
})

test("rejects a result without options", async () => {
  const { client } = clientReturning(JSON.stringify({ translation: "只有翻译" }))

  await assert.rejects(
    generateRightPhrase(client, { mode: "reply", input: "Hello" }),
    /did not return any phrase options/,
  )
})

test("rejects a result whose options are all unusable", async () => {
  const { client } = clientReturning(JSON.stringify({ options: [{ tone: "x" }] }))

  await assert.rejects(
    generateRightPhrase(client, { mode: "say", input: "你好" }),
    /usable phrase options/,
  )
})

test("falls back to the deprecated generate.text endpoint", async () => {
  const client = {
    generate: {
      text: async () => ({ text: JSON.stringify({ options: [validOption(1)] }) }),
    },
  }

  const result = await generateRightPhrase(client, { mode: "say", input: "你好" })

  assert.equal(result.options.length, 1)
})

test("reports a missing generation endpoint", async () => {
  await assert.rejects(
    generateRightPhrase({}, { mode: "say", input: "你好" }),
    /Text generation is unavailable/,
  )
})

test("forwards the abort signal", async () => {
  const controller = new AbortController()
  const { client, calls } = clientReturning(
    JSON.stringify({ options: [validOption(1)] }),
  )

  await generateRightPhrase(client, {
    mode: "say",
    input: "你好",
    signal: controller.signal,
  })

  assert.equal(calls[0].options.signal, controller.signal)
})

test("cancelling settles even if the client ignores the signal", async () => {
  const controller = new AbortController()
  let called = false
  const client = { experimental: { generate: { text: () => {
    called = true
    return new Promise(() => {})
  } } } }
  const request = generateRightPhrase(client, { mode: "say", input: "你好", signal: controller.signal })
  await Promise.resolve()
  assert.equal(called, true)
  controller.abort()
  await assert.rejects(request, { name: "AbortError" })
})

test("does not start a request if the signal was already aborted", async () => {
  const controller = new AbortController()
  controller.abort()
  const { client, calls } = clientReturning("{}")
  await assert.rejects(generateRightPhrase(client, { mode: "say", input: "你好", signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls.length, 0)
})
