export type ModelTestStatus = "idle" | "testing" | "success" | "error"

export interface ModelTarget {
  id: string
  modelID: string
  providerID: string
  name: string
}

export interface ModelTestResult {
  key: string // e.g. "providerID:modelID"
  providerID: string
  modelID: string
  modelName: string
  status: ModelTestStatus
  latency?: number // response time in ms
  error?: string
  testedAt?: number // timestamp in ms
  reply?: string
}

export interface ModelTesterSummary {
  total: number
  success: number
  failed: number
  testedAt?: number
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`
}

export function formatLatency(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatTime(timestamp?: number): string {
  if (!timestamp) return ""
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatDateTime(timestamp?: number): string {
  if (!timestamp) return ""
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface MinimalGenerateInput {
  prompt: string
  model: { id: string; providerID: string }
}

interface MinimalRequestOptions {
  signal?: AbortSignal
}

export interface MinimalSessionClient {
  create: (
    input: { title?: string; model: { id: string; providerID: string } },
    options?: MinimalRequestOptions,
  ) => Promise<{ id: string }>
  generate: (
    input: { sessionID: string; prompt: string },
    options?: MinimalRequestOptions,
  ) => Promise<{ text: string }>
  remove: (input: { sessionID: string }, options?: MinimalRequestOptions) => Promise<unknown>
}

export interface MinimalOpenCodeClient {
  generate?: {
    text: (input: MinimalGenerateInput, options?: MinimalRequestOptions) => Promise<{ text: string }>
  }
  experimental?: {
    generate?: {
      text: (input: MinimalGenerateInput, options?: MinimalRequestOptions) => Promise<{ text: string }>
    }
  }
  session?: MinimalSessionClient
}

export interface TestSingleModelOptions {
  timeoutMs?: number
  signal?: AbortSignal
  prompt?: string
}

const DEFAULT_TEST_PROMPT = "1+1=? Answer with only the number."

/** OpenCode's free models reject stateless generation but work inside a session. */
export function isFreeUsageLimitError(error: unknown): boolean {
  if (typeof error === "string") return /free usage limit/i.test(error)
  if (!error || typeof error !== "object") return false
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && /free usage limit/i.test(message)
}

type GenerationOutcome =
  | { status: "success"; text?: string; latency: number }
  | { status: "error"; error: string; latency: number }

function elapsedMs(start: number): number {
  return Math.max(1, Math.round(performance.now() - start))
}

function createRequestScope(timeoutMs: number, outer?: AbortSignal) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const abortListener = () => controller.abort()

  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener("abort", abortListener, { once: true })
  }

  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted && !outer?.aborted,
    dispose() {
      clearTimeout(timeoutId)
      outer?.removeEventListener("abort", abortListener)
    },
  }
}

function describeError(error: unknown, timedOut: boolean, outer: AbortSignal | undefined, timeoutMs: number): string {
  if (outer?.aborted) return "Test cancelled"
  if (timedOut) return `Request timed out (${Math.round(timeoutMs / 1000)}s)`
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown error"
}

async function generateStateless(
  client: MinimalOpenCodeClient,
  model: ModelTarget,
  prompt: string,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<GenerationOutcome> {
  const start = performance.now()
  const scope = createRequestScope(timeoutMs, outer)
  try {
    const generateFn = client.generate?.text || client.experimental?.generate?.text
    if (!generateFn) throw new Error("generate.text API unavailable on client")

    const res = await generateFn(
      {
        prompt,
        model: { id: model.id, providerID: model.providerID },
      },
      { signal: scope.signal },
    )
    return { status: "success", text: res?.text, latency: elapsedMs(start) }
  } catch (error) {
    return {
      status: "error",
      error: describeError(error, scope.timedOut(), outer, timeoutMs),
      latency: elapsedMs(start),
    }
  } finally {
    scope.dispose()
  }
}

async function generateInSession(
  client: MinimalOpenCodeClient,
  model: ModelTarget,
  prompt: string,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<GenerationOutcome | undefined> {
  const session = client.session
  if (!session) return undefined

  const start = performance.now()
  const scope = createRequestScope(timeoutMs, outer)
  let sessionID: string | undefined

  try {
    const created = await session.create(
      {
        title: `Model test: ${model.name}`,
        model: { id: model.id, providerID: model.providerID },
      },
      { signal: scope.signal },
    )
    sessionID = created?.id
    if (!sessionID) throw new Error("Session creation returned no id")

    const res = await session.generate(
      { sessionID, prompt },
      { signal: scope.signal },
    )
    return { status: "success", text: res?.text, latency: elapsedMs(start) }
  } catch (error) {
    return {
      status: "error",
      error: describeError(error, scope.timedOut(), outer, timeoutMs),
      latency: elapsedMs(start),
    }
  } finally {
    scope.dispose()
    if (sessionID) {
      // The probe session is an implementation detail; never leave it behind.
      try {
        await session.remove({ sessionID })
      } catch {
        // Best effort: a failed cleanup must not change the test result.
      }
    }
  }
}

function resultFromOutcome(
  key: string,
  model: ModelTarget,
  outcome: GenerationOutcome,
): ModelTestResult {
  const base = {
    key,
    providerID: model.providerID,
    modelID: model.modelID,
    modelName: model.name,
    latency: outcome.latency,
    testedAt: Date.now(),
  }
  if (outcome.status === "success") {
    return { ...base, status: "success", reply: outcome.text }
  }
  return { ...base, status: "error", error: outcome.error }
}

/**
 * Tests a single model by sending a minimal test prompt.
 *
 * OpenCode's free models reject stateless generation with a free-usage-limit
 * error even though they work in normal chat sessions. Fall back to a
 * temporary session for those models so the badge reflects real availability.
 */
export async function testSingleModel(
  client: MinimalOpenCodeClient,
  model: ModelTarget,
  options: TestSingleModelOptions = {},
): Promise<ModelTestResult> {
  const { timeoutMs = 15000, signal, prompt = DEFAULT_TEST_PROMPT } = options
  const key = modelKey(model.providerID, model.modelID)

  const primary = await generateStateless(client, model, prompt, timeoutMs, signal)
  if (primary.status === "success") return resultFromOutcome(key, model, primary)

  if (!signal?.aborted && isFreeUsageLimitError(primary.error) && client.session) {
    const fallback = await generateInSession(client, model, prompt, timeoutMs, signal)
    if (fallback) return resultFromOutcome(key, model, fallback)
  }

  return resultFromOutcome(key, model, primary)
}

export interface TestMultipleModelsOptions extends TestSingleModelOptions {
  concurrency?: number
  onStartModel?: (model: ModelTarget) => void
  onModelResult?: (result: ModelTestResult) => void
}

/**
 * Tests multiple models with controlled concurrency.
 */
export async function testMultipleModels(
  client: MinimalOpenCodeClient,
  models: ModelTarget[],
  options: TestMultipleModelsOptions = {},
): Promise<ModelTestResult[]> {
  const { concurrency = 3, onStartModel, onModelResult, ...singleOptions } = options
  const results: ModelTestResult[] = []
  if (models.length === 0) return results

  let nextIndex = 0

  async function worker() {
    while (nextIndex < models.length) {
      if (options.signal?.aborted) break
      const currentIndex = nextIndex++
      const model = models[currentIndex]
      onStartModel?.(model)
      const result = await testSingleModel(client, model, singleOptions)
      results.push(result)
      onModelResult?.(result)
    }
  }

  const workerCount = Math.min(concurrency, models.length)
  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.all(workers)

  return results
}

export function computeSummary(results: ModelTestResult[]): ModelTesterSummary {
  const success = results.filter((r) => r.status === "success").length
  const failed = results.filter((r) => r.status === "error").length
  const latestTestedAt = results.reduce(
    (max, r) => (r.testedAt && r.testedAt > max ? r.testedAt : max),
    0,
  )
  return {
    total: results.length,
    success,
    failed,
    testedAt: latestTestedAt > 0 ? latestTestedAt : undefined,
  }
}

export interface MatchModelItem {
  id: string
  modelID: string
  providerID: string
  name: string
}

export interface MatchProviderItem {
  id: string
  name: string
}

/**
 * Matches a DOM row's title and provider title with a model from client list.
 */
export function findModelForElement(
  rowTitle: string,
  providerHeaderTitle: string,
  models: MatchModelItem[],
  providers: MatchProviderItem[] = [],
): MatchModelItem | undefined {
  const clean = (s: string) => s.replace(/\(latest\)/gi, "").trim().toLowerCase()
  const targetTitle = clean(rowTitle)
  const targetProv = clean(providerHeaderTitle)

  if (!targetTitle) return undefined

  // 1. Filter by model name match
  const nameMatches = models.filter((m) => {
    const mName = clean(m.name)
    const mId = clean(m.id)
    return mName === targetTitle || mId === targetTitle
  })

  if (nameMatches.length === 1) {
    return nameMatches[0]
  }

  // 2. Disambiguate with provider name
  if (nameMatches.length > 1) {
    const provMatch = nameMatches.find((m) => {
      const p = providers.find((prov) => prov.id === m.providerID)
      const pName = p ? clean(p.name) : ""
      const mProv = clean(m.providerID)

      return (
        targetProv.includes(mProv) ||
        mProv.includes(targetProv) ||
        (pName && (targetProv.includes(pName) || pName.includes(targetProv))) ||
        (m.providerID === "opencode" && targetProv.includes("opencode")) ||
        (m.providerID === "github-copilot" && targetProv.includes("copilot"))
      )
    })
    if (provMatch) return provMatch
    return nameMatches[0]
  }

  // 3. Fallback: partial name match within provider if known
  const partialMatches = models.filter((m) => {
    const mName = clean(m.name)
    return mName.includes(targetTitle) || targetTitle.includes(mName)
  })

  if (partialMatches.length > 0) {
    const provMatch = partialMatches.find((m) => {
      const mProv = clean(m.providerID)
      return targetProv.includes(mProv) || mProv.includes(targetProv)
    })
    return provMatch || partialMatches[0]
  }

  return undefined
}
