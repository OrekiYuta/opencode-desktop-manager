import type { RightPhraseMode, RightPhraseResult } from "./types"

type GenerateTextClient = {
  experimental?: { generate?: { text?: (input: {
    prompt: string
    model?: { id: string; providerID: string; variant?: string } | null
  }, options?: { signal?: AbortSignal }) => Promise<{ text: string }> } }
  generate?: { text?: (input: {
    prompt: string
    model?: { id: string; providerID: string; variant?: string } | null
  }, options?: { signal?: AbortSignal }) => Promise<{ text: string }> }
}

export interface GenerateOptions {
  mode: RightPhraseMode
  input: string
  model?: { id: string; providerID: string; variant?: string }
  signal?: AbortSignal
}

export function modelFromComposer(model: { modelID: string; providerID: string; variant?: string }) {
  return { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) }
}

// Some clients/providers do not settle promptly after aborting the underlying request.
// Settle the UI immediately while still forwarding the signal to the transport.
async function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation()
  if (signal.aborted) throw new DOMException("Generation aborted", "AbortError")
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(new DOMException("Generation aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw new DOMException("Generation aborted", "AbortError")
      return operation()
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

function buildPrompt(mode: RightPhraseMode, input: string): string {
  if (mode === "say") {
    return `You are a bilingual writing assistant. Rewrite the user's Chinese text into exactly 5 natural English expressions, ordered from casual to formal.
Return strict JSON only with this shape:
{"options":[{"tone":"short English tone label","english":"English expression","meaning":"brief Chinese tone note"}]}

Rules:
- Preserve the original meaning.
- Do not add greetings or explanations outside the JSON.
- "tone" and "meaning" must be written in English and Chinese respectively.
- Return 5 options.

Chinese text:\n${input}`
  }

  return `You are a bilingual communication assistant. Translate the user's received English message into Chinese, then provide exactly 5 natural English replies ordered from warm and direct to formal.
Return strict JSON only with this shape:
{"translation":"Chinese translation","options":[{"tone":"short English tone label","english":"English reply","meaning":"brief Chinese meaning"}]}

Rules:
- Preserve the original meaning and intent.
- Do not add explanations outside the JSON.
- "tone" must be in English and "meaning" must be in Chinese.
- Return 5 options.

Received English message:\n${input}`
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error("The model returned text that could not be parsed as a result.")
  }
}

function parseResult(value: unknown): RightPhraseResult {
  if (!value || typeof value !== "object") throw new Error("The model returned an invalid result.")
  const record = value as Record<string, unknown>
  const rawOptions = record.options
  if (!Array.isArray(rawOptions)) throw new Error("The model did not return any phrase options.")

  const options = rawOptions.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const option = item as Record<string, unknown>
    if (typeof option.english !== "string" || typeof option.tone !== "string") return []
    const tone = option.tone.trim()
    const english = option.english.trim()
    if (!tone || !english) return []
    return [{
      tone,
      english,
      meaning: typeof option.meaning === "string" ? option.meaning.trim() : "",
    }]
  })

  if (options.length === 0) throw new Error("The model did not return any usable phrase options.")
  const translation = typeof record.translation === "string" ? record.translation.trim() : undefined
  return { translation, options: options.slice(0, 5) }
}

export async function generateRightPhrase(
  client: GenerateTextClient,
  options: GenerateOptions,
): Promise<RightPhraseResult> {
  const generate = client.experimental?.generate?.text ?? client.generate?.text
  if (!generate) throw new Error("Text generation is unavailable in this OpenCode version.")

  const input = options.input.trim()
  if (!input) throw new Error("Enter text before generating.")

  const response = await withAbort(() => generate(
    {
      prompt: buildPrompt(options.mode, input),
      model: options.model ?? null,
    },
    { signal: options.signal },
  ), options.signal)

  return parseResult(extractJson(response.text))
}
