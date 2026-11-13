import type { SetupContext } from "@opencode/plugin/gui"
import {
  computeSummary,
  findModelForElement,
  formatDateTime,
  formatLatency,
  modelKey,
  testMultipleModels,
  testSingleModel,
  type ModelTarget,
  type ModelTestResult,
} from "./model-tester"

export let triggerModelTest: (() => Promise<void>) | null = null

const STORAGE_KEY = "opencode:model-test-results:v1"

function loadStoredResults(): Map<string, ModelTestResult> {
  const map = new Map<string, ModelTestResult>()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as [string, ModelTestResult][]
      for (const [k, v] of parsed) {
        map.set(k, v)
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
  let isTesting = false
  let testedCount = 0
  let totalCount = 0
  let abortController: AbortController | null = null

  let cachedModels: any[] = []
  let cachedProviders: any[] = []

  async function refreshModelMetadata() {
    try {
      const [modelsRes, provsRes] = await Promise.all([
        (ctx.client as any).model.list({}, { signal: ctx.signal }).catch(() => ({ data: [] })),
        (ctx.client as any).provider.list({}, { signal: ctx.signal }).catch(() => ({ data: [] })),
      ])
      if (!ctx.signal.aborted) {
        cachedModels = Array.isArray(modelsRes) ? modelsRes : modelsRes?.data || []
        cachedProviders = Array.isArray(provsRes) ? provsRes : provsRes?.data || []
      }
    } catch {
      // Non-blocking
    }
  }

  void refreshModelMetadata()

  function findModelsHeaderTitle(): HTMLElement | null {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, div, span, p'))
    for (const el of elements) {
      let text = ""
      if (el.children.length === 0) {
        text = el.textContent?.trim() || ""
      } else if (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE) {
        text = el.childNodes[0].nodeValue?.trim() || ""
      }

      if (text === "模型" || text === "Models") {
        const parent = el.parentElement
        if (!parent) continue
        const parentText = parent.textContent || ""
        if (
          parentText.includes("配置模型") ||
          parentText.includes("configure") ||
          parentText.includes("设置") ||
          parentText.includes("settings") ||
          parentText.includes("搜索") ||
          parentText.includes("Search")
        ) {
          return el
        }
      }
    }
    return null
  }

  function findModelsSearchInput(): HTMLInputElement | null {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
    for (const input of inputs) {
      const ph = input.placeholder || input.getAttribute("data-placeholder") || input.getAttribute("aria-label") || ""
      if (/搜索模型|search models/i.test(ph)) {
        return input
      }
    }
    return null
  }

  function isModelsPageOpen(): boolean {
    return !!findModelsHeaderTitle() || !!findModelsSearchInput()
  }

  function findRowForSwitch(sw: HTMLElement): HTMLElement {
    let current: HTMLElement | null = sw.parentElement
    while (current && current !== document.body) {
      const clone = current.cloneNode(true) as HTMLElement
      clone
        .querySelectorAll('button, input, [role="switch"], .odm-model-status, [data-component="switch"]')
        .forEach((el) => el.remove())
      const text = clone.textContent?.trim() || ""
      if (text.length > 0 && text.length < 90) {
        return current
      }
      current = current.parentElement
    }
    return sw.parentElement || sw
  }

  function findModelRows(): HTMLElement[] {
    const allSwitches = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button[role="switch"], input[type="checkbox"], [role="switch"]',
      ),
    )
    const switches = allSwitches.filter((el) => !el.parentElement?.closest('button[role="switch"], [role="switch"]'))

    const rowSet = new Set<HTMLElement>()
    const rows: HTMLElement[] = []

    for (const sw of switches) {
      const row = findRowForSwitch(sw)
      if (row && !rowSet.has(row) && row !== document.body) {
        rowSet.add(row)
        rows.push(row)
      }
    }
    return rows
  }

  function isRowEnabled(row: HTMLElement): boolean {
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"], input[role="switch"]')
    if (input) return input.checked

    const btn = row.querySelector<HTMLElement>(
      'button[role="switch"], [role="switch"], [data-component="switch"]',
    )
    if (btn) {
      const aria = btn.getAttribute("aria-checked")
      if (aria !== null) return aria === "true"

      const state = btn.getAttribute("data-state")
      if (state !== null) return state === "checked" || state === "on" || state === "true"

      const dataChecked = btn.getAttribute("data-checked")
      if (dataChecked !== null) return dataChecked !== "false"

      const cls = btn.className || ""
      if (typeof cls === "string") {
        if (
          cls.includes("checked") ||
          cls.includes("active") ||
          cls.includes("bg-primary") ||
          cls.includes("bg-blue") ||
          cls.includes("accent")
        ) {
          return true
        }
      }
    }
    return false
  }

  function getRowProviderTitle(row: HTMLElement): string {
    const section = row.closest(
      'section[data-component="settings-models-provider"], .provider-model-group, section[data-component="settings-models-console"], section, details, div[class*="provider"], div[class*="group"]',
    )
    if (!section) return ""
    const titleEl = section.querySelector(
      '.settings-models-group-title, .provider-model-group-title, summary, header, [class*="title"], h2, h3, h4, div[class*="header"]',
    )
    return titleEl?.textContent?.trim() || section.getAttribute("data-provider") || ""
  }

  function getRowModelTitle(row: HTMLElement): string {
    const titleEl = row.querySelector('[data-slot="settings-row-title"], .settings-row-title, [class*="title"]')
    if (titleEl?.textContent?.trim()) return titleEl.textContent.trim()

    // Fallback: Clone row, remove switch controls & badges, get remaining text
    const clone = row.cloneNode(true) as HTMLElement
    const switches = clone.querySelectorAll(
      'button, input, [role="switch"], .odm-model-status, [data-component="switch"]',
    )
    switches.forEach((s) => s.remove())
    return clone.textContent?.trim() || ""
  }

  function resolveModelForRow(row: HTMLElement): ModelTarget | undefined {
    const rowTitle = getRowModelTitle(row)
    const provTitle = getRowProviderTitle(row)
    if (!rowTitle) return undefined

    const match = findModelForElement(rowTitle, provTitle, cachedModels, cachedProviders)
    if (match) {
      return {
        id: match.id,
        modelID: match.modelID,
        providerID: match.providerID,
        name: match.name,
      }
    }
    return undefined
  }

  function renderStatusBadge(row: HTMLElement, result: ModelTestResult, model: ModelTarget) {
    const sw = row.querySelector<HTMLElement>(
      'button[role="switch"], input[type="checkbox"], [role="switch"]',
    )
    if (!sw || !sw.parentElement) return

    const control = sw.parentElement

    // Clean up any extra/duplicate badges in this row or control
    const allExistingBadges = Array.from(row.querySelectorAll<HTMLElement>(".odm-model-status"))
    let badge = allExistingBadges[0]
    for (let i = 1; i < allExistingBadges.length; i++) {
      allExistingBadges[i].remove()
    }

    if (!badge) {
      badge = document.createElement("div")
      badge.className = "odm-model-status"
      control.insertBefore(badge, sw)
    } else if (badge.parentElement !== control) {
      control.insertBefore(badge, sw)
    }

    // Ensure control container uses horizontal flex layout
    control.style.display = "inline-flex"
    control.style.alignItems = "center"
    control.style.gap = "8px"

    badge.dataset.modelKey = result.key
    badge.className = `odm-model-status odm-model-status--${result.status}`

    const dot = document.createElement("span")
    dot.className = `odm-model-dot odm-model-dot--${result.status}`

    const text = document.createElement("span")
    text.className = "odm-model-latency"

    if (result.status === "testing") {
      text.textContent = ctx.t("modelTest.status.testing")
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.status.testing")}`
    } else if (result.status === "success") {
      const lat = formatLatency(result.latency)
      text.textContent = lat
      const timeStr = formatDateTime(result.testedAt)
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.tooltip.success", {
        latency: lat,
        time: timeStr,
      })}`
    } else if (result.status === "error") {
      const lat = result.latency ? formatLatency(result.latency) : ""
      text.textContent = lat ? `${ctx.t("modelTest.status.unavailable")} ${lat}` : ctx.t("modelTest.status.unavailable")
      const timeStr = formatDateTime(result.testedAt)
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.tooltip.error", {
        error: result.error || "Unknown error",
        latency: lat || "N/A",
        time: timeStr,
      })}`
    }

    badge.replaceChildren(dot, text)

    badge.onclick = (e) => {
      e.stopPropagation()
      e.preventDefault()
      void retestSingleModel(model)
    }
  }

  async function retestSingleModel(model: ModelTarget) {
    if (isTesting) return
    const key = modelKey(model.providerID, model.modelID)
    results.set(key, {
      key,
      providerID: model.providerID,
      modelID: model.modelID,
      modelName: model.name,
      status: "testing",
    })
    saveStoredResults(results)
    updateAllBadges()

    try {
      const res = await testSingleModel(ctx.client, model, { timeoutMs: 15000, signal: ctx.signal })
      results.set(key, res)
    } catch (err: any) {
      results.set(key, {
        key,
        providerID: model.providerID,
        modelID: model.modelID,
        modelName: model.name,
        status: "error",
        error: err?.message || "Failed",
        testedAt: Date.now(),
      })
    } finally {
      saveStoredResults(results)
      updateAllBadges()
      updateHeaderBar()
    }
  }

  // Model Selector Dialog Enhancements
  function findModelSelectorPopups(): HTMLElement[] {
    const popups: HTMLElement[] = []
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
    for (const input of inputs) {
      const ph = input.placeholder || input.getAttribute("data-placeholder") || input.getAttribute("aria-label") || ""
      if (/搜索模型|search models/i.test(ph)) {
        const dialog = input.closest<HTMLElement>(
          '[role="dialog"], [role="menu"], [class*="dialog"], [class*="popover"], [class*="modal"], [class*="dropdown"]',
        )
        const container = dialog || input.parentElement?.parentElement?.parentElement
        if (container && container !== document.body && !popups.includes(container)) {
          popups.push(container)
        }
      }
    }
    return popups
  }

  function enhanceSelectorPopupSizing(popup: HTMLElement) {
    popup.classList.add("odm-enhanced-selector-popup")
    popup.style.setProperty("min-width", "580px", "important")
    popup.style.setProperty("max-height", "min(85vh, 820px)", "important")

    // Find scrollable list container inside popup and lengthen it
    const scrollable = popup.querySelectorAll<HTMLElement>('div, ul, [role="listbox"]')
    for (const el of scrollable) {
      const overflowY = window.getComputedStyle(el).overflowY
      if (overflowY === "auto" || overflowY === "scroll" || el.scrollHeight > 250) {
        el.classList.add("odm-enhanced-selector-list")
        el.style.setProperty("max-height", "min(72vh, 720px)", "important")
      }
    }
  }

  function findItemsInSelectorPopup(popup: HTMLElement): HTMLElement[] {
    const itemSet = new Set<HTMLElement>()

    const candidates = Array.from(
      popup.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"], li, div[class*="item"]'),
    )

    for (const el of candidates) {
      if (el.closest('.odm-models-test-bar, .odm-header-actions, .odm-model-status')) continue
      const text = (el.textContent || "").trim()
      if (text.length > 0 && text.length < 120) {
        if (cachedModels.some((m) => text.toLowerCase().includes(m.name?.toLowerCase()))) {
          itemSet.add(el)
        }
      }
    }

    return Array.from(itemSet)
  }

  function resolveModelForSelectorItem(item: HTMLElement): ModelTarget | undefined {
    const clone = item.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.odm-model-status').forEach((el) => el.remove())
    const itemText = clone.textContent?.trim().toLowerCase() || ""
    if (!itemText) return undefined

    const sortedModels = [...cachedModels].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0))

    // 1. Match both model name and provider
    for (const m of sortedModels) {
      const mName = m.name?.trim().toLowerCase()
      const mProv = m.providerID?.trim().toLowerCase()
      if (mName && itemText.includes(mName)) {
        if (mProv && itemText.includes(mProv)) {
          return {
            id: m.id,
            modelID: m.modelID,
            providerID: m.providerID,
            name: m.name,
          }
        }
      }
    }

    // 2. Match model name
    for (const m of sortedModels) {
      const mName = m.name?.trim().toLowerCase()
      if (mName && itemText.includes(mName)) {
        return {
          id: m.id,
          modelID: m.modelID,
          providerID: m.providerID,
          name: m.name,
        }
      }
    }

    return undefined
  }

  function renderSelectorItemBadge(item: HTMLElement, result: ModelTestResult, model: ModelTarget) {
    const allBadges = Array.from(item.querySelectorAll<HTMLElement>(".odm-model-status"))
    let badge = allBadges[0]
    for (let i = 1; i < allBadges.length; i++) {
      allBadges[i].remove()
    }

    if (!badge) {
      badge = document.createElement("div")
      badge.className = "odm-model-status odm-model-status--selector"

      // If item has a trailing tag or arrow, insert before it; otherwise append
      const trailing = item.querySelector<HTMLElement>('[class*="arrow"], [class*="chevron"], svg:last-child')
      if (trailing && trailing.parentElement === item) {
        item.insertBefore(badge, trailing)
      } else {
        item.appendChild(badge)
      }
    }

    item.style.display = "flex"
    item.style.alignItems = "center"

    badge.dataset.modelKey = result.key
    badge.className = `odm-model-status odm-model-status--selector odm-model-status--${result.status}`

    const dot = document.createElement("span")
    dot.className = `odm-model-dot odm-model-dot--${result.status}`

    const text = document.createElement("span")
    text.className = "odm-model-latency"

    if (result.status === "testing") {
      text.textContent = ctx.t("modelTest.status.testing")
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.status.testing")}`
    } else if (result.status === "success") {
      const lat = formatLatency(result.latency)
      text.textContent = lat
      const timeStr = formatDateTime(result.testedAt)
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.tooltip.success", {
        latency: lat,
        time: timeStr,
      })}`
    } else if (result.status === "error") {
      const lat = result.latency ? formatLatency(result.latency) : ""
      text.textContent = lat ? `${ctx.t("modelTest.status.unavailable")} ${lat}` : ctx.t("modelTest.status.unavailable")
      const timeStr = formatDateTime(result.testedAt)
      badge.title = `${model.name} (${model.providerID})\n${ctx.t("modelTest.tooltip.error", {
        error: result.error || "Unknown error",
        latency: lat || "N/A",
        time: timeStr,
      })}`
    }

    badge.replaceChildren(dot, text)
  }

  function updateSelectorBadges() {
    const popups = findModelSelectorPopups()
    for (const popup of popups) {
      enhanceSelectorPopupSizing(popup)

      const items = findItemsInSelectorPopup(popup)
      for (const item of items) {
        const model = resolveModelForSelectorItem(item)
        if (!model) continue
        const key = modelKey(model.providerID, model.modelID)
        const res = results.get(key)
        if (res) {
          renderSelectorItemBadge(item, res, model)
        }
      }
    }
  }

  function updateAllBadges() {
    // 1. Update Settings > Models rows
    const rows = findModelRows()
    for (const row of rows) {
      const model = resolveModelForRow(row)
      if (!model) continue
      const key = modelKey(model.providerID, model.modelID)
      const res = results.get(key)
      if (res) {
        renderStatusBadge(row, res, model)
      }
    }

    // 2. Update Model Selector Dialog items
    updateSelectorBadges()
  }

  function renderBarContent(bar: HTMLElement) {
    let btn = bar.querySelector<HTMLButtonElement>(".odm-test-btn")
    if (!btn) {
      btn = document.createElement("button")
      btn.type = "button"
      btn.className = "odm-test-btn odm-test-btn--primary"
      btn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        void testAllEnabledModels()
      }
      bar.appendChild(btn)
    }

    btn.disabled = isTesting
    btn.className = `odm-test-btn ${isTesting ? "odm-test-btn--testing" : "odm-test-btn--primary"}`

    const summary = computeSummary([...results.values()])

    // Update button text/icons without recreating the button element
    btn.replaceChildren()
    if (isTesting) {
      const spinner = document.createElement("span")
      spinner.className = "odm-spinner"
      const text = document.createElement("span")
      text.textContent = totalCount > 0
        ? ctx.t("modelTest.testing", { current: testedCount, total: totalCount })
        : "Preparing test..."
      btn.appendChild(spinner)
      btn.appendChild(text)
    } else if (summary.total > 0) {
      const icon = document.createElement("span")
      icon.textContent = "⚡"
      const text = document.createElement("span")
      text.textContent = ctx.t("modelTest.retest")
      btn.appendChild(icon)
      btn.appendChild(text)
    } else {
      const icon = document.createElement("span")
      icon.textContent = "⚡"
      const text = document.createElement("span")
      text.textContent = ctx.t("modelTest.button")
      btn.appendChild(icon)
      btn.appendChild(text)
    }

    // Cancel Button
    let cancelBtn = bar.querySelector<HTMLButtonElement>(".odm-cancel-btn")
    if (isTesting) {
      if (!cancelBtn) {
        cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.className = "odm-cancel-btn"
        cancelBtn.textContent = ctx.t("modelTest.cancel")
        cancelBtn.onclick = (e) => {
          e.preventDefault()
          e.stopPropagation()
          abortController?.abort()
        }
        bar.appendChild(cancelBtn)
      }
    } else if (cancelBtn) {
      cancelBtn.remove()
    }

    // Summary Text with Full Date (YYYY-MM-DD HH:mm:ss)
    let sumSpan = bar.querySelector<HTMLElement>(".odm-test-summary")
    if (!isTesting && summary.total > 0) {
      if (!sumSpan) {
        sumSpan = document.createElement("span")
        sumSpan.className = "odm-test-summary"
        bar.appendChild(sumSpan)
      }
      sumSpan.replaceChildren()
      const succSpan = document.createElement("span")
      succSpan.className = "odm-test-summary-dot--success"
      succSpan.textContent = `✓ ${summary.success}`

      const failSpan = document.createElement("span")
      failSpan.className = "odm-test-summary-dot--failed"
      failSpan.textContent = `✗ ${summary.failed}`

      const timeText = summary.testedAt ? formatDateTime(summary.testedAt) : ""
      sumSpan.append(
        succSpan,
        document.createTextNode(" · "),
        failSpan,
        document.createTextNode(timeText ? ` · ${timeText}` : ""),
      )
    } else if (sumSpan) {
      sumSpan.remove()
    }
  }

  function ensureHeaderBar() {
    const titleEl = findModelsHeaderTitle()
    if (titleEl) {
      const titleBlock = titleEl.parentElement
      if (titleBlock) {
        const headerContainer =
          titleBlock.children.length <= 3 && titleBlock.parentElement ? titleBlock.parentElement : titleBlock

        let bar = headerContainer.querySelector<HTMLElement>(".odm-models-test-bar")
        if (bar) {
          return
        }

        const staleBars = document.querySelectorAll<HTMLElement>(".odm-models-test-bar")
        staleBars.forEach((stale) => {
          if (!headerContainer.contains(stale)) stale.remove()
        })

        let actions = headerContainer.querySelector<HTMLElement>(".odm-header-actions")
        if (!actions) {
          actions = document.createElement("div")
          actions.className = "odm-header-actions"
          headerContainer.style.display = "flex"
          headerContainer.style.justifyContent = "space-between"
          headerContainer.style.alignItems = "flex-start"
          headerContainer.appendChild(actions)
        }

        bar = document.createElement("div")
        bar.className = "odm-models-test-bar"
        actions.appendChild(bar)
        renderBarContent(bar)
        return
      }
    }

    // Fallback: Attach near Search Input (e.g. inside Model Selector Dialog)
    const searchInput = findModelsSearchInput()
    if (searchInput) {
      const searchBox = searchInput.closest("div") || searchInput.parentElement
      if (searchBox && searchBox.parentElement) {
        const rowContainer = searchBox.parentElement
        let bar = rowContainer.querySelector<HTMLElement>(".odm-models-test-bar")
        if (bar) {
          return
        }

        let actions = rowContainer.querySelector<HTMLElement>(".odm-header-actions")
        if (!actions) {
          actions = document.createElement("div")
          actions.className = "odm-header-actions"
          rowContainer.style.display = "flex"
          rowContainer.style.alignItems = "center"
          rowContainer.style.gap = "12px"
          rowContainer.appendChild(actions)
        }
        bar = document.createElement("div")
        bar.className = "odm-models-test-bar"
        actions.appendChild(bar)
        renderBarContent(bar)
        return
      }
    }
  }

  function updateHeaderBar() {
    const bars = document.querySelectorAll<HTMLElement>(".odm-models-test-bar")
    for (const bar of Array.from(bars)) {
      renderBarContent(bar)
    }
  }

  async function testAllEnabledModels() {
    if (isTesting) return
    isTesting = true
    testedCount = 0
    totalCount = 0
    abortController = new AbortController()

    // Immediate button feedback
    updateHeaderBar()

    const loadingToast = ctx.toast.show({
      variant: "loading",
      title: ctx.t("modelTest.toast.scanning"),
      persistent: true,
    })

    try {
      await refreshModelMetadata()

      // Expand accordion sections in the models panel if on Settings page
      const modelsTitle = findModelsHeaderTitle()
      const modelsContainer = modelsTitle?.closest('main, [role="tabpanel"], div')
      if (modelsContainer) {
        const accordions = Array.from(
          modelsContainer.querySelectorAll<HTMLElement>(
            '.settings-models-group-trigger[aria-expanded="false"], .provider-model-group-trigger[aria-expanded="false"], [aria-expanded="false"]',
          ),
        )
        for (const trigger of accordions) {
          trigger.click()
        }
        if (accordions.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      // Collect enabled models:
      const enabledTargets: ModelTarget[] = []
      const seenKeys = new Set<string>()

      // 1. Authoritative: Models enabled in server metadata
      for (const m of cachedModels) {
        if (m.enabled) {
          const key = modelKey(m.providerID, m.modelID)
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            enabledTargets.push({
              id: m.id,
              modelID: m.modelID,
              providerID: m.providerID,
              name: m.name,
            })
          }
        }
      }

      // 2. Also check any visible toggle switches that are turned ON
      const rows = findModelRows()
      for (const row of rows) {
        if (!isRowEnabled(row)) continue
        const model = resolveModelForRow(row)
        if (!model) continue
        const key = modelKey(model.providerID, model.modelID)
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          enabledTargets.push(model)
        }
      }

      if (enabledTargets.length === 0) {
        loadingToast.dismiss()
        ctx.toast.show({
          variant: "default",
          title: ctx.t("modelTest.toast.noneEnabled"),
        })
        return
      }

      totalCount = enabledTargets.length

      // Set all targets to testing immediately
      for (const target of enabledTargets) {
        const key = modelKey(target.providerID, target.modelID)
        results.set(key, {
          key,
          providerID: target.providerID,
          modelID: target.modelID,
          modelName: target.name,
          status: "testing",
        })
      }

      saveStoredResults(results)
      updateAllBadges()
      updateHeaderBar()

      // Run concurrency-controlled tests
      await testMultipleModels(ctx.client, enabledTargets, {
        concurrency: 3,
        timeoutMs: 15000,
        signal: abortController.signal,
        onModelResult(result) {
          results.set(result.key, result)
          saveStoredResults(results)
          testedCount++
          updateAllBadges()
          updateHeaderBar()
        },
      })

      loadingToast.dismiss()

      const summary = computeSummary(
        enabledTargets.map((t) => results.get(modelKey(t.providerID, t.modelID))).filter(Boolean) as ModelTestResult[],
      )
      if (summary.failed === 0) {
        ctx.toast.show({
          variant: "success",
          title: ctx.t("modelTest.toast.allSuccess", { total: summary.total }),
        })
      } else {
        ctx.toast.show({
          variant: "error",
          title: ctx.t("modelTest.toast.complete", {
            success: summary.success,
            failed: summary.failed,
          }),
        })
      }
    } catch (err: any) {
      loadingToast.dismiss()
      ctx.toast.show({
        variant: "error",
        title: err?.message || "An error occurred during model testing",
      })
    } finally {
      isTesting = false
      abortController = null
      saveStoredResults(results)
      updateAllBadges()
      updateHeaderBar()
    }
  }

  triggerModelTest = async () => {
    await testAllEnabledModels()
  }

  // MutationObserver & Timer to watch for Settings > Models or Model Selector dialog being open
  let checkScheduled = false
  function onDomMutated() {
    if (checkScheduled) return
    checkScheduled = true
    requestAnimationFrame(() => {
      checkScheduled = false
      if (isModelsPageOpen()) {
        ensureHeaderBar()
        updateAllBadges()
      }
    })
  }

  const observer = new MutationObserver(onDomMutated)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })

  // 300ms fallback interval to guarantee mounting across tab navigation and popup opening
  const timer = setInterval(() => {
    if (isModelsPageOpen()) {
      ensureHeaderBar()
      updateAllBadges()
    }
  }, 300)

  // Trigger initial check
  onDomMutated()

  // Cleanup on context abort
  ctx.signal.addEventListener(
    "abort",
    () => {
      triggerModelTest = null
      observer.disconnect()
      clearInterval(timer)
      abortController?.abort()
    },
    { once: true },
  )

  return () => {
    triggerModelTest = null
    observer.disconnect()
    clearInterval(timer)
    abortController?.abort()
  }
}
