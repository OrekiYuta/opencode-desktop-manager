/**
 * Extract the last user prompt (text + whether it carries an image) from a
 * built inference request body — the Responses and Chat Completions shapes
 * that opencode produces. The /auto router needs only this much of the
 * conversation, which is what VS Code sends too.
 */

export interface ExtractedPrompt {
  readonly text: string
  readonly image: boolean
}

const IMAGE_PART_TYPES = new Set(["input_image", "image_url", "image"])

function textFromContentPart(part: unknown): string {
  if (typeof part !== "object" || part === null) return ""
  const p = part as Record<string, unknown>
  if (typeof p.text === "string") return p.text
  if (typeof (p.text as { value?: unknown } | undefined)?.value === "string") {
    return (p.text as { value: string }).value
  }
  if (typeof p.input_text === "string") return p.input_text
  // Tolerate { type, value }-shaped text parts.
  if (typeof p.value === "string") return p.value
  return ""
}

function contentHasImage(part: unknown): boolean | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const type = (part as Record<string, unknown>).type
  return typeof type === "string" && IMAGE_PART_TYPES.has(type) ? true : undefined
}

function readContent(content: unknown): { text: string; image: boolean } {
  if (typeof content === "string") return { text: content, image: false }
  if (!Array.isArray(content)) return { text: "", image: false }
  let text = ""
  let image = false
  for (const part of content) {
    const imageFlag = contentHasImage(part)
    if (imageFlag) {
      image = true
      continue
    }
    const t = textFromContentPart(part)
    if (t) text += (text ? " " : "") + t
  }
  return { text: text.trim(), image }
}

/** Last user-role item in a Responses `input` array (or bare string input). */
function fromResponsesInput(input: unknown): ExtractedPrompt | undefined {
  if (typeof input === "string") return { text: input, image: false }
  if (!Array.isArray(input)) return undefined
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (typeof item !== "object" || item === null) continue
    const role = (item as Record<string, unknown>).role
    if (role !== "user") continue
    return readContent((item as Record<string, unknown>).content)
  }
  return undefined
}

/** Last user-role message in a Chat Completions `messages` array. */
function fromChatMessages(messages: unknown): ExtractedPrompt | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (typeof msg !== "object" || msg === null) continue
    if ((msg as Record<string, unknown>).role !== "user") continue
    return readContent((msg as Record<string, unknown>).content)
  }
  return undefined
}

/** Returns null when the body carries no user prompt at all. */
export function extractPromptFromBody(body: unknown): ExtractedPrompt | null {
  if (typeof body !== "object" || body === null) return null
  const record = body as Record<string, unknown>
  const fromInput = fromResponsesInput(record.input)
  if (fromInput) return fromInput
  const fromMessages = fromChatMessages(record.messages)
  if (fromMessages) return fromMessages
  return null
}
