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

export interface MinimalOpenCodeClient {
  generate?: {
    text: (
      input: {
        prompt: string
        model: { id: string; providerID: string }
      },
      options?: { signal?: AbortSignal },
    ) => Promise<{ text: string }>
  }
  experimental?: {
    generate?: {
      text: (
        input: {
          prompt: string
          model: { id: string; providerID: string }
        },
        options?: { signal?: AbortSignal },
      ) => Promise<{ text: string }>
    }
  }
}

export interface TestSingleModelOptions {
  timeoutMs?: number
  signal?: AbortSignal
  prompt?: string
}

/**
 * Tests a single model by sending a minimal test prompt.
 */
export async function testSingleModel(
  client: MinimalOpenCodeClient,
  model: ModelTarget,
  options: TestSingleModelOptions = {},
): Promise<ModelTestResult> {
  const { timeoutMs = 15000, signal, prompt = "1+1=? Answer with only the number." } = options
  const key = modelKey(model.providerID, model.modelID)
  const start = performance.now()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const abortListener = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId)
      controller.abort()
    } else {
      signal.addEventListener("abort", abortListener, { once: true })
    }
  }

  try {
    const generateFn =
      client.generate?.text ||
      client.experimental?.generate?.text
    if (!generateFn) {
      throw new Error("generate.text API unavailable on client")
    }

    const res = await generateFn(
      {
        prompt,
        model: {
          id: model.id,
          providerID: model.providerID,
        },
      },
      { signal: controller.signal },
    )
    const latency = Math.max(1, Math.round(performance.now() - start))
    return {
      key,
      providerID: model.providerID,
      modelID: model.modelID,
      modelName: model.name,
      status: "success",
      latency,
      testedAt: Date.now(),
      reply: res?.text,
    }
  } catch (err: unknown) {
    const latency = Math.max(1, Math.round(performance.now() - start))
    let message = "Unknown error"
    if (controller.signal.aborted) {
      message = signal?.aborted ? "Test cancelled" : `Request timed out (${Math.round(timeoutMs / 1000)}s)`
    } else if (err instanceof Error) {
      message = err.message
    } else if (typeof err === "string") {
      message = err
    }
    return {
      key,
      providerID: model.providerID,
      modelID: model.modelID,
      modelName: model.name,
      status: "error",
      latency,
      testedAt: Date.now(),
      error: message,
    }
  } finally {
    clearTimeout(timeoutId)
    if (signal) signal.removeEventListener("abort", abortListener)
  }
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
