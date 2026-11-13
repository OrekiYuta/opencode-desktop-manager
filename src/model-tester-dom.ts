import type { SetupContext } from "@opencode/plugin/gui"
import {
  computeSummary,
  findModelForElement,
  formatDateTime,
  formatLatency,
  modelKey,
  testMultipleModels,
  testSingleModel,
  type MatchProviderItem,
  type ModelTarget,
  type ModelTestResult,
} from "./model-tester"

export let triggerModelTest: (() => Promise<void>) | null = null

const STORAGE_KEY = "opencode:model-test-results:v1"
const SELECTOR_CONTENT = '[data-slot="dialog-content"].model-dialog'
const SELECTOR_CONTAINER_CLASS = "odm-model-selector-container"
const PROVIDER_GROUP = '[data-component="settings-models-provider"], [data-component="provider-model-group"]'

function loadStoredResults(): Map<string, ModelTestResult> {
  const map = new Map<string, ModelTestResult>()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as [string, ModelTestResult][]
      for (const [key, result] of parsed) {
        // A request cannot still be running after the window or plugin was reloaded.
        if (result.status !== "testing") map.set(key, result)
      }
    }
  } catch {
    // Non-blocking
  }
  return map
}

function saveStoredResults(map: Map<string, ModelTestResult>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]))
  } catch {
    // Non-blocking
  }
}

export function setupModelTester(ctx: SetupContext<any>): () => void {
  const results = loadStoredResults()
  const lifetime = new AbortController()
  let disposed = false
  let isTesting = false
  let testedCount = 0
  let totalCount = 0
  let abortController: AbortController | null = null
  let scheduledFrame: number | undefined

  let cachedModels: (ModelTarget & { enabled?: boolean })[] = []
  let cachedProviders: MatchProviderItem[] = []
  const singleTests = new Set<string>()
  const injected = new Set<HTMLElement>()
  const sizedContainers = new Set<HTMLElement>()
  const bars = new WeakMap<HTMLElement, HTMLElement>()
  const badges = new WeakMap<HTMLElement, HTMLElement>()
  const rendered = new WeakMap<HTMLElement, string>()

  async function refreshModelMetadata() {
    try {
      const [modelsRes, providersRes] = await Promise.all([
        (ctx.client as any).model.list({}, { signal: lifetime.signal }),
        (ctx.client as any).provider.list({}, { signal: lifetime.signal }),
      ])
      if (disposed) return
      cachedModels = Array.isArray(modelsRes) ? modelsRes : modelsRes?.data || []
      cachedProviders = Array.isArray(providersRes) ? providersRes : providersRes?.data || []
      scheduleUpdate()
    } catch {
      // Keep the last successful metadata if the service is temporarily unavailable.
    }
  }

  function findModelRows(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.settings-models [data-component="settings-row"], .settings-manage-models-dialog .manage-models-rows > .search-list-row',
      ),
    )
  }

  function isRowEnabled(row: HTMLElement): boolean {
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (input) return input.checked
    const control = row.querySelector<HTMLElement>('[role="switch"]')
    if (!control) return false
    const checked = control.getAttribute("aria-checked")
    if (checked !== null) return checked === "true"
    return control.getAttribute("data-state") === "checked" ||
      (control.hasAttribute("data-checked") && control.getAttribute("data-checked") !== "false")
  }

  function resolveModelForRow(row: HTMLElement): ModelTarget | undefined {
    const title = row.querySelector('[data-slot="settings-row-title"], .search-list-title')?.textContent?.trim()
    const group = row.closest<HTMLElement>(PROVIDER_GROUP)
    if (!title || !group) return undefined

    const providerID = group.dataset.provider
    const providerTitle = group.querySelector(".settings-models-group-title, .provider-model-group-title")?.textContent || ""
    const models = providerID ? cachedModels.filter((model) => model.providerID === providerID) : cachedModels
    return findModelForElement(title, providerTitle, models, cachedProviders)
  }

  function findModelSelectorDialogs(): HTMLElement[] {
    // OpenCode 2.3: dialog-v2 (positioning) > dialog-container (size) > model-dialog.
    // The settings search field is a sibling of .settings-models, so its placeholder
    // cannot distinguish the settings page from a model selector.
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTOR_CONTENT)).filter(
      (dialog) => dialog.parentElement?.matches('[data-slot="dialog-container"]') &&
        dialog.parentElement.parentElement?.matches('[data-component="dialog-v2"]'),
    )
  }

  function badgeContent(result: ModelTestResult, model: ModelTarget) {
    let text = ""
    let detail = ""
    if (result.status === "testing") {
      text = ctx.t("modelTest.status.testing")
      detail = text
    } else if (result.status === "success") {
      text = formatLatency(result.latency)
      detail = ctx.t("modelTest.tooltip.success", { latency: text, time: formatDateTime(result.testedAt) })
    } else if (result.status === "error") {
      const latency = result.latency ? formatLatency(result.latency) : ""
      text = [ctx.t("modelTest.status.unavailable"), latency].filter(Boolean).join(" ")
      detail = ctx.t("modelTest.tooltip.error", {
        error: result.error || "Unknown error",
        latency: latency || "N/A",
        time: formatDateTime(result.testedAt),
      })
    }
    return { text, title: `${model.name} (${model.providerID})\n${detail}` }
  }

  function renderBadge(
    row: HTMLElement,
    host: HTMLElement,
    model: ModelTarget,
    selector: boolean,
    active: Set<HTMLElement>,
  ) {
    const result = results.get(modelKey(model.providerID, model.modelID))
    if (!result || result.status === "idle") return

    let badge = badges.get(row)
    if (!badge) {
      // Selector rows are already buttons. Their badges remain part of model selection.
      badge = document.createElement(selector ? "span" : "button")
      if (badge instanceof HTMLButtonElement) badge.type = "button"
      badges.set(row, badge)
    }
    injected.add(badge)
    active.add(badge)

    if (selector) {
      const variant = host.querySelector<HTMLElement>(':scope > [data-slot="model-dialog-variant"]')
      if (badge.parentElement !== host || (variant && badge.nextElementSibling !== variant)) {
        host.insertBefore(badge, variant)
      }
    } else if (badge.parentElement !== host) {
      // Insert alongside the switch wrapper, never inside its label/input structure.
      host.prepend(badge)
    }

    const { text, title } = badgeContent(result, model)
    const signature = JSON.stringify([model.id, result.key, result.status, text, title])
    if (rendered.get(badge) === signature) return
    rendered.set(badge, signature)
    badge.dataset.modelKey = result.key
    badge.className = `odm-model-status odm-model-status--${selector ? "selector" : "interactive"} odm-model-status--${result.status}`
    badge.title = title
    badge.setAttribute("aria-label", title)

    const dot = document.createElement("span")
    dot.className = `odm-model-dot odm-model-dot--${result.status}`
    dot.setAttribute("aria-hidden", "true")
    const label = document.createElement("span")
    label.className = "odm-model-latency"
    label.textContent = text
    badge.replaceChildren(dot, label)

    if (!selector) {
      badge.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        void retestSingleModel(model)
      }
    }
  }

  function renderBarContent(bar: HTMLElement) {
    const summary = computeSummary([...results.values()])
    const disabled = isTesting || singleTests.size > 0
    const label = isTesting
      ? ctx.t("modelTest.testing", { current: testedCount, total: totalCount })
      : ctx.t(summary.total > 0 ? "modelTest.retest" : "modelTest.button")
    const time = summary.testedAt ? formatDateTime(summary.testedAt) : ""
    const summaryText = summary.total > 0 ? `✓ ${summary.success} · ✗ ${summary.failed}${time ? ` · ${time}` : ""}` : ""
    const cancelLabel = ctx.t("modelTest.cancel")
    const signature = JSON.stringify([isTesting, disabled, label, summaryText, cancelLabel])
    if (rendered.get(bar) === signature) return
    rendered.set(bar, signature)

    let button = bar.querySelector<HTMLButtonElement>(".odm-test-btn")
    if (!button) {
      button = document.createElement("button")
      button.type = "button"
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        void testAllEnabledModels()
      }
      bar.append(button)
    }
    button.disabled = disabled
    button.className = `odm-test-btn ${isTesting ? "odm-test-btn--testing" : "odm-test-btn--primary"}`
    button.title = [label, summaryText].filter(Boolean).join("\n")
    button.setAttribute("aria-label", label)
    const icon = document.createElement("span")
    icon.setAttribute("aria-hidden", "true")
    if (isTesting) icon.className = "odm-spinner"
    else icon.textContent = "⚡"
    const text = document.createElement("span")
    text.className = "odm-test-btn-label"
    text.textContent = label
    button.replaceChildren(icon, text)

    let cancel = bar.querySelector<HTMLButtonElement>(".odm-cancel-btn")
    if (isTesting) {
      if (!cancel) {
        cancel = document.createElement("button")
        cancel.type = "button"
        cancel.className = "odm-cancel-btn"
        cancel.onclick = (event) => {
          event.preventDefault()
          event.stopPropagation()
          abortController?.abort()
        }
        bar.append(cancel)
      }
      cancel.textContent = bar.classList.contains("odm-models-test-bar--selector") ? "×" : cancelLabel
      cancel.title = cancelLabel
      cancel.setAttribute("aria-label", cancelLabel)
    } else {
      cancel?.remove()
    }

    let summaryElement = bar.querySelector<HTMLElement>(".odm-test-summary")
    if (!isTesting && summary.total > 0) {
      if (!summaryElement) {
        summaryElement = document.createElement("span")
        summaryElement.className = "odm-test-summary"
        bar.append(summaryElement)
      }
      const success = document.createElement("span")
      success.className = "odm-test-summary-dot--success"
      success.textContent = `✓ ${summary.success}`
      const failed = document.createElement("span")
      failed.className = "odm-test-summary-dot--failed"
      failed.textContent = `✗ ${summary.failed}`
      summaryElement.replaceChildren(
        success,
        document.createTextNode(" · "),
        failed,
        document.createTextNode(time ? ` · ${time}` : ""),
      )
    } else {
      summaryElement?.remove()
    }
  }

  function ensureBar(host: HTMLElement | null, kind: "settings" | "selector" | "manage", active: Set<HTMLElement>) {
    if (!host) return
    let bar = bars.get(host)
    if (!bar) {
      bar = document.createElement("div")
      bar.className = `odm-models-test-bar odm-models-test-bar--${kind}`
      bars.set(host, bar)
    }
    injected.add(bar)
    active.add(bar)
    if (bar.parentElement !== host) host.append(bar)
    renderBarContent(bar)
  }

  function updateUI() {
    if (disposed) return
    if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame)
    scheduledFrame = undefined

    // Our own DOM writes must not start another observer/frame cycle.
    observer.disconnect()
    try {
      const active = new Set<HTMLElement>()
      const containers = new Set<HTMLElement>()

      for (const body of document.querySelectorAll<HTMLElement>(".settings-tab-body.settings-models")) {
        const header = body.previousElementSibling
        if (header instanceof HTMLElement && header.matches(".settings-tab-header")) {
          ensureBar(header, "settings", active)
        }
      }
      for (const dialog of document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"].settings-manage-models-dialog')) {
        ensureBar(dialog.querySelector(".manage-models-search"), "manage", active)
      }
      for (const row of findModelRows()) {
        const model = resolveModelForRow(row)
        const control = row.querySelector<HTMLElement>('[data-slot="settings-row-control"], .search-list-trailing')
        if (model && control) renderBadge(row, control, model, false, active)
      }

      const modelsByOption = new Map(cachedModels.map((model) => [modelKey(model.providerID, model.id), model]))
      for (const dialog of findModelSelectorDialogs()) {
        const container = dialog.parentElement!
        containers.add(container)
        if (!container.classList.contains(SELECTOR_CONTAINER_CLASS)) container.classList.add(SELECTOR_CONTAINER_CLASS)
        sizedContainers.add(container)

        // Native model dialogs keep keyboard focus in the search field except for
        // its trailing actions. Use that existing slot for compact test controls.
        ensureBar(
          dialog.querySelector('[data-slot="search-list-search"] [data-slot="text-input-v2-trailing"]'),
          "selector",
          active,
        )
        for (const row of dialog.querySelectorAll<HTMLElement>('[data-slot="search-list-row"][data-option-key]')) {
          const model = modelsByOption.get(row.dataset.optionKey!)
          if (model) renderBadge(row, row, model, true, active)
        }
      }

      for (const element of injected) {
        if (active.has(element)) continue
        element.remove()
        injected.delete(element)
      }
      for (const container of sizedContainers) {
        if (containers.has(container)) continue
        container.classList.remove(SELECTOR_CONTAINER_CLASS)
        sizedContainers.delete(container)
      }
    } finally {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "data-option-key", "aria-checked", "data-checked", "data-state"],
      })
    }
  }

  function scheduleUpdate() {
    if (disposed || scheduledFrame !== undefined) return
    scheduledFrame = requestAnimationFrame(updateUI)
  }

  async function retestSingleModel(model: ModelTarget) {
    const key = modelKey(model.providerID, model.modelID)
    if (disposed || isTesting || singleTests.has(key)) return
    singleTests.add(key)
    results.set(key, {
      key, providerID: model.providerID, modelID: model.modelID, modelName: model.name, status: "testing",
    })
    updateUI()
    try {
      const result = await testSingleModel(ctx.client, model, { timeoutMs: 15000, signal: lifetime.signal })
      if (!disposed) results.set(key, result)
    } finally {
      singleTests.delete(key)
      if (!disposed) {
        saveStoredResults(results)
        updateUI()
      }
    }
  }

  async function testAllEnabledModels() {
    if (disposed || isTesting || singleTests.size > 0) return
    isTesting = true
    testedCount = 0
    totalCount = 0
    const controller = new AbortController()
    abortController = controller
    const previousResults = new Map(results)
    updateUI()

    const loadingToast = ctx.toast.show({
      variant: "loading",
      title: ctx.t("modelTest.toast.scanning"),
      persistent: true,
    })

    try {
      await refreshModelMetadata()
      if (disposed || controller.signal.aborted) return

      // Only model-provider accordions participate; other settings controls are unrelated.
      for (let depth = 0; depth < 2; depth++) {
        const triggers = document.querySelectorAll<HTMLElement>(
          '.settings-models .settings-models-group-trigger[aria-expanded="false"]:not(:disabled), .settings-models .provider-model-group-trigger[aria-expanded="false"]:not(:disabled)',
        )
        if (!triggers.length) break
        triggers.forEach((trigger) => trigger.click())
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (disposed || controller.signal.aborted) return
      }

      const enabledTargets: ModelTarget[] = []
      const seenKeys = new Set<string>()
      function include(model: ModelTarget) {
        const key = modelKey(model.providerID, model.modelID)
        if (seenKeys.has(key)) return
        seenKeys.add(key)
        enabledTargets.push(model)
      }
      for (const model of cachedModels) {
        if (model.enabled) include(model)
      }
      for (const row of findModelRows()) {
        if (!isRowEnabled(row)) continue
        const model = resolveModelForRow(row)
        if (model) include(model)
      }

      if (!enabledTargets.length) {
        ctx.toast.show({ variant: "default", title: ctx.t("modelTest.toast.noneEnabled") })
        return
      }
      totalCount = enabledTargets.length
      for (const model of enabledTargets) {
        const key = modelKey(model.providerID, model.modelID)
        results.set(key, {
          key, providerID: model.providerID, modelID: model.modelID, modelName: model.name, status: "testing",
        })
      }
      updateUI()

      await testMultipleModels(ctx.client, enabledTargets, {
        concurrency: 3,
        timeoutMs: 15000,
        signal: controller.signal,
        onModelResult(result) {
          if (disposed) return
          results.set(result.key, result)
          saveStoredResults(results)
          testedCount++
          updateUI()
        },
      })
      if (disposed || controller.signal.aborted) return

      const summary = computeSummary(
        enabledTargets.map((model) => results.get(modelKey(model.providerID, model.modelID))!),
      )
      ctx.toast.show(summary.failed === 0
        ? { variant: "success", title: ctx.t("modelTest.toast.allSuccess", { total: summary.total }) }
        : {
          variant: "error",
          title: ctx.t("modelTest.toast.complete", { success: summary.success, failed: summary.failed }),
        })
    } catch (error: unknown) {
      if (!disposed && !controller.signal.aborted) {
        ctx.toast.show({
          variant: "error",
          title: error instanceof Error ? error.message : "An error occurred during model testing",
        })
      }
    } finally {
      loadingToast.dismiss()
      isTesting = false
      abortController = null
      if (!disposed) {
        // Queued models that were cancelled have no new result.
        for (const [key, result] of results) {
          if (result.status !== "testing") continue
          const previous = previousResults.get(key)
          if (previous) results.set(key, previous)
          else results.delete(key)
        }
        saveStoredResults(results)
        updateUI()
      }
    }
  }

  const runModelTest = () => testAllEnabledModels()
  const observer = new MutationObserver(scheduleUpdate)

  function cleanup() {
    if (disposed) return
    disposed = true
    if (triggerModelTest === runModelTest) triggerModelTest = null
    ctx.signal.removeEventListener("abort", cleanup)
    observer.disconnect()
    if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame)
    lifetime.abort()
    abortController?.abort()
    for (const element of injected) element.remove()
    for (const container of sizedContainers) container.classList.remove(SELECTOR_CONTAINER_CLASS)
    injected.clear()
    sizedContainers.clear()
  }

  if (ctx.signal.aborted) {
    cleanup()
  } else {
    triggerModelTest = runModelTest
    ctx.signal.addEventListener("abort", cleanup, { once: true })
    updateUI()
    void refreshModelMetadata()
  }
  return cleanup
}
