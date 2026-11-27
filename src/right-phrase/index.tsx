import { For, Show, createSignal, onCleanup } from "solid-js"
import { Command, TitlebarItem, type DialogHandle, type SetupContext } from "@opencode/plugin/gui"
import { generateRightPhrase, modelFromComposer } from "./service"
import type { RightPhraseMode, RightPhraseResult } from "./types"

type RightPhraseContext = SetupContext<any>

export function setupRightPhrase(ctx: RightPhraseContext) {
  const [open, setOpen] = createSignal(false)
  let dialog: DialogHandle | undefined

  function show(prefill?: string) {
    if (open()) return
    setOpen(true)
    dialog = openRightPhrase(ctx, () => setOpen(false), prefill)
  }

  ctx.add(Command, (): Command => ({
    id: "open-right-phrase",
    title: "Open Right Phrase",
    description: "Bilingual phrasing and reply suggestions",
    group: "Right Phrase",
    keywords: "translation translator bilingual english chinese reply phrase",
    slash: { name: "right-phrase", arguments: true },
    run: (input) => show(input?.trim() || undefined),
  }))

  ctx.add(TitlebarItem, (): TitlebarItem => ({
    id: "right-phrase",
    label: "Right Phrase",
    title: "opencode-desktop-manager: Open Right Phrase",
    icon: "speech-bubble",
    pressed: open(),
    run: () => {
      if (open()) dialog?.close()
      else show()
    },
  }))

  return { open: show }
}

export function openRightPhrase(ctx: RightPhraseContext, onClosed?: () => void, initialInput = "") {
  let dialog: DialogHandle | undefined
  dialog = ctx.dialogs.open((handle) => {
    onCleanup(() => {
      dialog = undefined
      onClosed?.()
    })
    return <RightPhraseDialog ctx={ctx} dialog={handle} initialInput={initialInput} />
  })
  return dialog
}

function RightPhraseDialog(props: { ctx: RightPhraseContext; dialog: DialogHandle; initialInput: string }) {
  const ctx = props.ctx
  const [mode, setMode] = createSignal<RightPhraseMode>("say")
  const [input, setInput] = createSignal(props.initialInput.slice(0, 4000))
  const [result, setResult] = createSignal<RightPhraseResult>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [copied, setCopied] = createSignal("")
  let activeController: AbortController | undefined
  let disposed = false

  onCleanup(() => {
    disposed = true
    activeController?.abort()
  })

  function switchMode(next: RightPhraseMode) {
    if (loading()) return
    setMode(next)
    setResult(undefined)
    setError("")
  }

  async function generate() {
    if (loading()) return
    const text = input().trim()
    if (!text) {
      setError("Enter text before generating.")
      return
    }

    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    const timeout = window.setTimeout(() => controller.abort("timeout"), 45_000)

    setLoading(true)
    setError("")
    setResult(undefined)

    try {
      const session = ctx.sessions.current()
      const client = session?.server.client ?? ctx.client
      const current = session ? ctx.screen.current()?.composer.model() : undefined
      if (session && !current) throw new Error("Current model unavailable. Wait for the model to load or select one in the composer.")
      const generated = await generateRightPhrase(client, {
        mode: mode(),
        input: text,
        model: current ? modelFromComposer(current) : undefined,
        signal: controller.signal,
      })
      if (!disposed && !controller.signal.aborted) setResult(generated)
    } catch (caught) {
      if (disposed) return
      if (controller.signal.aborted) {
        setError(controller.signal.reason === "timeout"
          ? "Generation timed out after 45 seconds. Please try again or change the model in the composer."
          : "Generation cancelled.")
      } else {
        const message = caught instanceof Error ? caught.message : ""
        if (/free usage limit/i.test(message)) {
          setError("This free model cannot be used for stateless generation. Choose another model in the composer and try again.")
          return
        }
        const safe =
          message.startsWith("The model") ||
          message.startsWith("Current model unavailable") ||
          message.startsWith("Enter text") ||
          message.startsWith("Text generation")
        setError(safe ? message : "Could not generate phrases with the current model. Please try again.")
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeController === controller) activeController = undefined
      if (!disposed) setLoading(false)
    }
  }

  function cancel() {
    activeController?.abort()
  }

  async function copyText(text: string, label: string) {
    try {
      await ctx.system.copy(text)
      setCopied(label)
      window.setTimeout(() => setCopied(""), 1800)
    } catch {
      setCopied("")
      ctx.toast.show({ variant: "error", title: "Could not copy text" })
    }
  }

  function insertText(text: string) {
    const composer = ctx.screen.current()?.composer
    if (!composer) {
      ctx.toast.show({ variant: "error", title: "Open a session before inserting text" })
      return
    }
    composer.insert(text)
    ctx.toast.show({ variant: "success", title: "Inserted into the composer" })
  }

  const ui = ctx.ui

  return (
    <ui.Dialog
      title="Right Phrase"
      description="Say it naturally. Reply with confidence."
      size="x-large"
      footer={<ui.Button variant="ghost" onClick={() => props.dialog.close()}>Close</ui.Button>}
    >
      <div class="rp-dialog rp-body">
        <div class="rp-input-column">
          <div class="rp-tabs" role="group" aria-label="Right Phrase mode">
            <ui.Button
              variant={mode() === "say" ? "contrast" : "neutral"}
              size="small"
              onClick={() => switchMode("say")}
            >Say it</ui.Button>
            <ui.Button
              variant={mode() === "reply" ? "contrast" : "neutral"}
              size="small"
              onClick={() => switchMode("reply")}
            >Reply</ui.Button>
          </div>

          <label class="rp-label" for="rp-text">
            {mode() === "say" ? "What do you want to say?" : "What did you receive?"}
          </label>
          <textarea
            id="rp-text"
            class="rp-textarea"
            value={input()}
            onInput={(event) => setInput(event.currentTarget.value)}
            placeholder={mode() === "say" ? "Write in Chinese…" : "Paste the received English message…"}
            aria-describedby="rp-direction rp-hint"
            maxLength={4000}
          />
          <div class="rp-meta">
            <span id="rp-direction">{mode() === "say" ? "Chinese → English" : "English → Chinese + replies"}</span>
            <span>{input().length}/4000</span>
          </div>
          <span id="rp-hint" class="rp-hint">
            {mode() === "say" ? "Generate natural English options with different tones." : "Translate the message and suggest natural English replies."}
          </span>

          <p class="rp-model-hint">Uses the current session's model, or OpenCode's default when no session is open.</p>

          <Show
            when={loading()}
            fallback={<ui.Button variant="contrast" class="rp-generate" busy={loading()} onClick={() => void generate()} disabled={!input().trim()}>{mode() === "say" ? "Generate phrases" : "Generate replies"}</ui.Button>}
          >
            <ui.Button variant="neutral" class="rp-generate" onClick={cancel}>Cancel generation</ui.Button>
          </Show>

          <p class="rp-free-note">
            <span><strong>Free models cannot be used for this feature.</strong> Switch to another model in the composer before generating.</span>
          </p>

          <Show when={error()}>
            <div class="rp-error" role="alert">{error()}</div>
          </Show>

          <div class="rp-privacy">
            <strong>Privacy</strong>
            <span>The model provider receives your input. This plugin does not save history.</span>
          </div>
        </div>

        <div class="rp-results" aria-live="polite">
          <div class="rp-results-head">
            <div>
              <h2>{mode() === "say" ? "English options" : "Reply suggestions"}</h2>
              <p>{mode() === "say" ? "Choose a tone from casual to formal." : "Understand the message, then choose a reply."}</p>
            </div>
            <Show when={result()}>
              <span class="rp-count">{result()?.options.length ?? 0} options</span>
            </Show>
          </div>

          <Show when={loading()}>
            <div class="rp-loading">Generating… Results appear when the model finishes.</div>
          </Show>

          <Show when={result()}>
            {(generated) => (
              <>
                <Show when={generated().translation}>
                  <div class="rp-translation">
                    <span>Chinese translation</span>
                    <p lang="zh-CN">{generated().translation}</p>
                  </div>
                </Show>
                <div class="rp-cards">
                  <For each={generated().options}>
                    {(option, index) => (
                      <article class="rp-card">
                        <div class="rp-card-content">
                          <div class="rp-card-label">{option.tone} <span>/{String(index() + 1).padStart(2, "0")}</span></div>
                          <p class="rp-card-english" lang="en">{option.english}</p>
                          <p class="rp-card-note" lang="zh-CN">{option.meaning}</p>
                        </div>
                        <div class="rp-card-actions">
                          <ui.Button variant="neutral" onClick={() => void copyText(option.english, `copy-${index()}`)}>
                            {copied() === `copy-${index()}` ? "Copied" : "Copy"}
                          </ui.Button>
                          <ui.Button variant="ghost" onClick={() => insertText(option.english)}>Insert</ui.Button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </>
            )}
          </Show>

          <Show when={!loading() && !result() && !error()}>
            <div class="rp-empty">
              <div class="rp-empty-mark" aria-hidden="true">R/P</div>
              <p>{mode() === "say" ? "Generate English phrases for your message." : "Generate replies for the message you received."}</p>
            </div>
          </Show>
        </div>
      </div>
    </ui.Dialog>
  )
}
