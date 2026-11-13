import type { SetupContext } from "@opencode/plugin/gui"
import { setupModelTester, triggerModelTest } from "../src/model-tester-dom"
import { modelKey, type ModelTarget } from "../src/model-tester"
import pluginCSS from "../src/model-tester.css?inline"
import nativeCSS from "./model-tester-native.css?inline"

type Screen = "selector" | "settings" | "manage" | "both" | "unrelated"
const providers = [{ id: "openai", name: "OpenAI" }, { id: "github-copilot", name: "GitHub Copilot" }]
const models = [
  { id: "shared-alias", modelID: "gpt-shared", providerID: "openai", name: "Shared Model", enabled: true },
  { id: "shared-alias", modelID: "copilot/gpt-shared", providerID: "github-copilot", name: "Shared Model", enabled: true },
  ...Array.from({ length: 28 }, (_, index) => ({
    id: `model-${index}`, modelID: `model-${index}`, providerID: "openai",
    name: `Model ${String(index + 1).padStart(2, "0")} with a longer display name`, enabled: false,
  })),
]
const keyOf = (model: ModelTarget) => modelKey(model.providerID, model.id)
const storageKey = "opencode:model-test-results:v1"
const root = document.getElementById("root")!

function createFixture() {
  const nativeStyle = document.createElement("style")
  nativeStyle.textContent = nativeCSS
  document.head.append(nativeStyle)
  const pluginStyle = document.createElement("style")
  pluginStyle.textContent = pluginCSS
  let controller = new AbortController()
  let cleanup: (() => void) | undefined
  let releaseMetadata = () => {}
  let pendingRequests: (() => void)[] = []
  const calls: { key: string; signal?: AbortSignal }[] = []
  const toasts: string[] = []
  let selections = 0
  let toggles = 0

  const field = (placeholder: string, selector = false) => `
    <div data-component="text-input-v2">
      <div data-slot="text-input-v2-value">
        <span data-slot="text-input-v2-leading-icon">⌕</span>
        <input data-slot="text-input-v2-input" placeholder="${placeholder}" aria-label="${placeholder}" ${selector ? 'role="combobox" aria-expanded="true"' : ""} />
      </div>
      ${selector ? `<div data-slot="text-input-v2-trailing">
        <button data-component="icon-button-v2" aria-label="Add provider">+</button>
        <button data-component="icon-button-v2" aria-label="Manage models">☷</button>
      </div>` : ""}
    </div>`
  const toggle = () => '<label data-component="switch"><input type="checkbox" role="switch" aria-label="Enabled" checked /></label>'
  const selectorRows = (query = "") => providers.map((provider) => `
    <div data-slot="search-list-section" role="group">
      <div data-slot="search-list-header">${provider.name}</div>
      ${models.filter((model) => model.providerID === provider.id && model.name.toLowerCase().includes(query.toLowerCase())).map((model) => `
        <button type="button" role="option" data-slot="search-list-row" data-option-key="${keyOf(model)}" ${model === models[0] ? 'data-active=""' : ""}>
          <span data-slot="model-dialog-check"></span>
          <span data-slot="model-dialog-name"><span>${model.name}</span></span>
          ${model === models[0] ? '<span data-slot="model-dialog-variant"><span class="truncate">Default</span><span>›</span></span>' : ""}
        </button>`).join("")}
    </div>`).join("")
  const selector = (placeholder: string) => `
    <div id="selector-overlay" data-component="dialog-v2" data-size="large">
      <div data-slot="dialog-container">
        <div role="dialog" aria-label="Select model" data-slot="dialog-content" class="command-palette model-dialog">
          <div class="sr-only"><h2>Select model</h2></div>
          <div data-slot="dialog-body" class="command-palette-body">
            <div class="contents">
              <div data-component="search-list">
                <div data-slot="search-list-search">${field(placeholder, true)}</div>
                <div data-slot="search-list-body">
                  <div data-component="menu-scroll"><div data-slot="search-list-scroll" data-scrollable>
                    <div data-slot="search-list-results" role="listbox">${selectorRows()}</div>
                  </div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  const groups = (manage = false) => providers.map((provider) => `
    <section data-component="settings-models-provider" class="settings-section">
      <h3 class="settings-models-group-header">
        <button class="settings-models-group-trigger" aria-expanded="true"><bdi class="settings-models-group-title">${provider.name}</bdi></button>
        ${manage ? toggle() : ""}
      </h3>
      <div ${manage ? 'class="manage-models-rows"' : 'data-component="settings-list"'}>
        ${models.filter((model) => model.providerID === provider.id).map((model) => manage ? `
          <div class="search-list-row">
            <div class="search-list-row-text"><span class="search-list-title">${model.name}</span></div>
            <div class="search-list-trailing">${toggle()}</div>
          </div>` : `
          <div data-component="settings-row">
            <div data-slot="settings-row-copy"><div data-slot="settings-row-title">${model.name}</div><div data-slot="settings-row-description"></div></div>
            <div data-slot="settings-row-control"><div>${toggle()}</div></div>
          </div>`).join("")}
      </div>
    </section>`).join("")
  const settings = (placeholder: string) => `
    <div id="settings-overlay" data-component="dialog-v2" data-size="x-large" data-variant="settings">
      <div data-slot="dialog-container"><div role="dialog" aria-label="Settings" data-slot="dialog-content">
        <div class="settings-layout">
          <nav class="settings-nav"><button>General</button><button>Providers</button><button>Models</button><button>Appearance</button></nav>
          <main class="settings-panel">
            <div class="settings-tab-header settings-tab-header--stacked">
              <div class="settings-tab-header-row">
                <div><h2 class="settings-tab-title">Models</h2><span>Configure which models appear in the selector.</span></div>
                <div class="settings-tab-header-actions"></div>
              </div>
              ${field(placeholder)}
            </div>
            <div class="settings-tab-body settings-models">${groups()}</div>
          </main>
        </div>
      </div></div>
    </div>`
  const manage = () => `
    <div id="manage-overlay" data-component="dialog-v2" data-size="large" data-variant="settings">
      <div data-slot="dialog-container"><div role="dialog" aria-label="Manage models" data-slot="dialog-content" class="settings-manage-models-dialog">
        <div data-slot="dialog-header">Manage models</div>
        <div data-slot="dialog-body">
          <div class="manage-models-search">${field("Search")}</div>
          <div data-slot="manage-models-scroll"><div class="settings-panel settings-models">${groups(true)}</div></div>
        </div>
      </div></div>
    </div>`

  // Model selection's native focus exception is the search field's trailing slot.
  document.addEventListener("focusin", (event) => {
    const dialog = document.querySelector(".model-dialog")
    const target = event.target as HTMLElement
    const input = dialog?.querySelector<HTMLInputElement>("input")
    if (dialog?.contains(target) && target !== input && !target.closest('[data-slot="text-input-v2-trailing"]')) input?.focus()
  })
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-slot="search-list-row"]')) selections++
    if (target.matches('input[type="checkbox"]')) toggles++
  })

  return {
    calls, toasts,
    get selections() { return selections },
    get toggles() { return toggles },
    get commandActive() { return triggerModelTest !== null },
    mount(screen: Screen, placeholder = "Search models") {
      root.innerHTML = `<div id="fixture-app">
        <aside class="fixture-sidebar"><h2>Workspace</h2><div>Sessions</div></aside>
        <main class="fixture-main"><h1>Native application shell</h1>
          <div><span>Shared Model</span><input type="checkbox" aria-label="Unrelated checkbox" checked /></div>
          ${screen === "unrelated" ? `<div role="dialog"><h2>Models</h2><p>Search settings</p>${field(placeholder)}</div>` : ""}
        </main>
        ${screen === "settings" || screen === "both" ? settings(placeholder) : ""}
        ${screen === "selector" || screen === "both" ? selector(placeholder) : ""}
        ${screen === "manage" ? manage() : ""}
      </div>`
      const input = root.querySelector<HTMLInputElement>(".model-dialog input")
      input?.addEventListener("input", () => {
        root.querySelector('[data-slot="search-list-results"]')!.innerHTML = selectorRows(input.value)
      })
      input?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") return
        event.preventDefault()
        const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-slot="search-list-row"]'))
        const index = rows.findIndex((row) => row.hasAttribute("data-active"))
        rows[index]?.removeAttribute("data-active")
        rows[index]?.querySelector('[data-slot="model-dialog-variant"]')?.remove()
        const next = rows[(index + 1) % rows.length]
        next?.setAttribute("data-active", "")
        next?.insertAdjacentHTML("beforeend", '<span data-slot="model-dialog-variant"><span class="truncate">Default</span><span>›</span></span>')
      })
    },
    start(options: { deferMetadata?: boolean; holdRequests?: boolean } = {}) {
      cleanup?.()
      calls.length = 0
      toasts.length = 0
      controller = new AbortController()
      const metadata = options.deferMetadata ? new Promise<void>((resolve) => { releaseMetadata = resolve }) : Promise.resolve()
      const holdRequests = options.holdRequests
      localStorage.setItem(storageKey, JSON.stringify(models.slice(0, 2).map((model, index) => {
        const key = modelKey(model.providerID, model.modelID)
        return [key, { key, providerID: model.providerID, modelID: model.modelID, modelName: model.name,
          status: index === 0 ? "success" : "error", latency: index === 0 ? 135 : 1200, testedAt: 1794571200000, error: "Fixture failure" }]
      })))
      document.head.append(pluginStyle)
      cleanup = setupModelTester({
        signal: controller.signal,
        client: {
          model: { list: async () => { await metadata; return { data: models } } },
          provider: { list: async () => ({ data: providers }) },
          experimental: { generate: { text: async (input: { model: { id: string; providerID: string } }, options?: { signal?: AbortSignal }) => {
            calls.push({ key: modelKey(input.model.providerID, input.model.id), signal: options?.signal })
            if (options?.signal?.aborted) throw new Error("Cancelled")
            if (options?.signal) {
              await new Promise<void>((resolve, reject) => {
                const signal = options.signal!
                const abort = () => reject(new Error("Cancelled"))
                signal.addEventListener("abort", abort, { once: true })
                const finish = () => { signal.removeEventListener("abort", abort); resolve() }
                if (holdRequests) pendingRequests.push(finish)
                else queueMicrotask(finish)
              })
            }
            return { text: "2" }
          } } },
        },
        t: (key: string, vars: Record<string, unknown> = {}) => {
          const messages: Record<string, string> = {
            "modelTest.button": "Test Enabled Models", "modelTest.retest": "Retest Enabled Models",
            "modelTest.testing": `Testing (${vars.current}/${vars.total})...`, "modelTest.cancel": "Cancel",
            "modelTest.status.testing": "Testing", "modelTest.status.unavailable": "Unavailable",
            "modelTest.tooltip.success": `Functional · ${vars.latency} · ${vars.time}`,
            "modelTest.tooltip.error": `Unavailable · ${vars.error} · ${vars.time}`,
          }
          return messages[key] || key
        },
        toast: { show: (toast: { title: string }) => { toasts.push(toast.title); return { dismiss() {} } } },
      } as unknown as SetupContext<any>)
    },
    stop(abort = false) {
      if (abort) controller.abort()
      else cleanup?.()
      cleanup = undefined
      pluginStyle.remove()
    },
    releaseMetadata() { releaseMetadata() },
    releaseRequests() { pendingRequests.splice(0).forEach((finish) => finish()) },
    loadNativeCSSLast() { document.head.append(nativeStyle) },
  }
}

type Fixture = ReturnType<typeof createFixture>
type FixtureWindow = Window & { modelTesterFixture?: Fixture }
type Check = { name: string; passed: boolean; detail?: string }

async function createRunner() {
  const style = document.createElement("style")
  style.textContent = `
    body { margin: 0; padding: 16px; background: #eef2f8; color: #293546; font: 13px/1.6 "Segoe UI", sans-serif; }
    h1 { font-size: 18px; margin: 0 0 8px; } .controls { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
    button, select { padding: 5px 10px; } #checks { padding-left: 24px; } .pass { color: #137536; } .fail { color: #bc2727; }
    .preview { overflow: auto; } iframe { display: block; border: 1px solid #ccd5e3; background: white; }
  `
  document.head.append(style)
  root.innerHTML = `<h1>Model Tester · OpenCode 2.3 Layout Regression</h1>
    <div>Native dialog, settings and search-list structure, with a local mock model service.</div>
    <div class="controls">
      <button id="run">Run regression checks</button>
      <select id="screen" aria-label="Fixture screen">
        <option value="selector">Model selector</option><option value="settings">Settings / Models</option>
        <option value="manage">Manage models</option><option value="both">Settings + selector</option><option value="unrelated">Unrelated search</option>
      </select>
      <select id="size" aria-label="Viewport size"><option value="1200,900">1200 × 900</option><option value="390,640">390 × 640</option><option value="320,480">320 × 480</option><option value="900,300">900 × 300</option></select>
      <button id="enable">Enable plugin</button><button id="disable">Disable plugin</button>
    </div>
    <output id="result">Ready</output><ol id="checks"></ol><div class="preview"><iframe title="Native layout fixture"></iframe></div>`
  const frame = root.querySelector("iframe")!
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }))
  frame.src = "/tests/model-tester.html?frame=1"
  await loaded
  const child = frame.contentWindow as FixtureWindow
  const fixture = child.modelTesterFixture!
  const doc = child.document
  const output = root.querySelector<HTMLOutputElement>("#result")!
  const checks = root.querySelector("#checks")!
  const screen = root.querySelector<HTMLSelectElement>("#screen")!
  const size = root.querySelector<HTMLSelectElement>("#size")!
  const paint = () => new Promise<void>((resolve) => child.requestAnimationFrame(() => child.requestAnimationFrame(() => resolve())))
  const resize = (width: number, height: number) => { frame.style.width = `${width}px`; frame.style.height = `${height}px` }
  const select = (query: string) => {
    const element = doc.querySelector<HTMLElement>(query)
    if (!element) throw new Error(`Missing ${query}`)
    return element
  }
  const rect = (query: string) => select(query).getBoundingClientRect()
  const assert = (condition: unknown, detail: string) => { if (!condition) throw new Error(detail) }
  const near = (a: number, b: number) => Math.abs(a - b) < 1
  const styles = () => Array.from(doc.querySelectorAll<HTMLElement>("#fixture-app, #fixture-app *")).map((el) => [el, el.getAttribute("style")] as const)
  const assertNativeStyles = (before: ReturnType<typeof styles>) => before.forEach(([el, value]) => {
    if (el.isConnected) assert(el.getAttribute("style") === value, `Native inline style changed: ${el.outerHTML.slice(0, 160)}`)
  })
  const waitFor = async (predicate: () => boolean) => {
    for (let frame = 0; frame < 30; frame++) {
      if (predicate()) return
      await paint()
    }
    assert(predicate(), "Condition did not settle")
  }

  async function run() {
    const results: Check[] = []
    const test = async (name: string, action: () => void | Promise<void>) => {
      output.textContent = `Running · ${name}`
      try { await action(); results.push({ name, passed: true }) }
      catch (error) { results.push({ name, passed: false, detail: String(error) }) }
    }
    const empty = () => !doc.querySelector(".odm-model-status, .odm-models-test-bar, .odm-model-selector-container")
    checks.replaceChildren()
    output.textContent = "Running…"
    resize(1200, 900)
    frame.scrollIntoView({ block: "start" })
    fixture.stop()
    fixture.mount("selector")
    const nativeContainer = rect("#selector-overlay > [data-slot='dialog-container']")
    const nativeStyles = styles()
    fixture.start()
    await paint()

    await test("Selector uses 80% of window height at 640px width and stays centered", () => {
      const box = rect("#selector-overlay > [data-slot='dialog-container']")
      const overlay = rect("#selector-overlay")
      assert(near(nativeContainer.width, 480) && near(nativeContainer.height, 480), "Incorrect native baseline")
      assert(near(box.width, 640) && near(box.height, child.innerHeight * 0.8), `Unexpected size ${box.width} × ${box.height}`)
      assert(near(box.x + box.width / 2, child.innerWidth / 2) && near(box.y + box.height / 2, child.innerHeight / 2), "Dialog is off-center")
      assert(near(overlay.width, child.innerWidth) && near(overlay.height, child.innerHeight), "Positioning overlay was resized")
      assertNativeStyles(nativeStyles)
    })
    await test("Native CSS loaded after the plugin does not undo sizing", async () => {
      fixture.loadNativeCSSLast()
      await paint()
      assert(near(rect("#selector-overlay > [data-slot='dialog-container']").width, 640), "Lazy host CSS overrode the plugin")
    })
    await test("Same model names under different providers get distinct row badges", () => {
      assert(doc.querySelectorAll(".odm-model-status").length === 2, "Expected exactly two badges")
      for (const [index, model] of models.slice(0, 2).entries()) {
        const row = select(`[data-option-key="${keyOf(model)}"]`)
        const badge = row.querySelector<HTMLElement>(":scope > .odm-model-status")!
        assert(badge?.dataset.modelKey === modelKey(model.providerID, model.modelID), "Alias/result key mismatch")
        assert(badge.classList.contains(`odm-model-status--${index === 0 ? "success" : "error"}`), "Wrong provider result")
      }
      assert(child.getComputedStyle(select('[data-slot="search-list-section"]')).display === "contents", "Provider group layout changed")
      assert(select('[data-slot="search-list-scroll"]').scrollHeight > select('[data-slot="search-list-scroll"]').clientHeight, "Native list should scroll")
    })
    await test("A reused option updates its badge when only its model key changes", async () => {
      const row = select(`[data-option-key="${keyOf(models[0])}"]`)
      row.dataset.optionKey = keyOf(models[1])
      await paint()
      assert(row.querySelector<HTMLElement>(".odm-model-status")?.dataset.modelKey === modelKey(models[1].providerID, models[1].modelID), "Stale badge on reused row")
      row.dataset.optionKey = keyOf(models[0])
      await paint()
    })
    await test("Idle observers cause no recurring DOM writes", async () => {
      let mutations = 0
      const observer = new MutationObserver((records) => { mutations += records.length })
      observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true })
      await paint()
      await paint()
      observer.disconnect()
      assert(mutations === 0, `Observer feedback loop: ${mutations} mutations`)
    })
    await test("Test controls remain keyboard-focusable in the native trailing slot", () => {
      const button = select(".odm-test-btn")
      button.focus()
      assert(doc.activeElement === button, "Native search focus guard stole button focus")
      assert(!!button.closest('[data-slot="text-input-v2-trailing"]'), "Button is outside native actions")
    })
    await test("Keyboard navigation and dynamically inserted variant controls keep working", async () => {
      const input = select(".model-dialog input")
      input.focus()
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
      await paint()
      assert(doc.activeElement === input, "Navigation lost search focus")
      assert(select('[data-slot="search-list-row"][data-active]').dataset.optionKey === keyOf(models[2]), "Arrow navigation was intercepted")
      const row = select(`[data-option-key="${keyOf(models[1])}"]`)
      row.insertAdjacentHTML("beforeend", '<span data-slot="model-dialog-variant"><span class="truncate">Very high reasoning effort</span><span>›</span></span>')
      await paint()
      assert(row.querySelector(".odm-model-status")?.nextElementSibling?.matches('[data-slot="model-dialog-variant"]'), "Badge displaced the native variant control")
    })
    await test("Selector test action uses the mock service and preserves the search field", async () => {
      const input = select(".model-dialog input")
      select(".odm-test-btn").click()
      await waitFor(() => fixture.calls.length === 2 && !select(".odm-test-btn").hasAttribute("disabled"))
      assert(select(".model-dialog input") === input, "Search field was replaced")
      assert(fixture.calls.map((call) => call.key).sort().join() === models.slice(0, 2).map(keyOf).sort().join(), "Wrong enabled models tested")
    })
    await test("Clicking a selector badge still selects the model", () => {
      const before = fixture.selections
      select(".odm-model-status--selector").click()
      assert(fixture.selections === before + 1, "Badge intercepted model selection")
    })
    await test("Searching, including empty results, keeps one toolbar and no stale badges", async () => {
      const input = select(".model-dialog input") as HTMLInputElement
      input.value = "no such model"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      await paint()
      assert(doc.querySelectorAll(".odm-model-status").length === 0, "Filtered-out row kept a badge")
      assert(doc.querySelectorAll(".odm-models-test-bar").length === 1, "Toolbar missing or duplicated")
      input.value = "Shared"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      await paint()
      assert(doc.querySelectorAll(".odm-model-status").length === 2, "Search results did not regain badges")
    })
    await test("Reusing a dialog container does not leak model sizing or badges", async () => {
      select(".model-dialog").classList.remove("model-dialog")
      await paint()
      assert(empty(), "Injections survived a change of dialog content")
      assert(near(rect("#selector-overlay > [data-slot='dialog-container']").height, 480), "Sizing leaked into another command palette")
    })

    fixture.stop()
    fixture.mount("settings")
    await paint()
    const settingsBox = rect("#settings-overlay > [data-slot='dialog-container']")
    const panel = rect(".settings-panel")
    const settingsStyles = styles()
    fixture.start()
    await paint()
    await test("Settings keeps its full dialog, navigation and column layout", () => {
      const after = rect("#settings-overlay > [data-slot='dialog-container']")
      assert(near(after.width, settingsBox.width) && near(after.height, settingsBox.height) && near(after.x, settingsBox.x), "Settings dialog was resized/repositioned")
      assert(near(rect(".settings-panel").width, panel.width), "Settings panel was narrowed")
      assert(child.getComputedStyle(select(".settings-panel")).flexDirection === "column", "Settings panel became a row")
      assert(!doc.querySelector(".odm-model-selector-container"), "Settings was mistaken for a selector")
      assert(doc.querySelectorAll(".settings-tab-header > .odm-models-test-bar").length === 1, "Toolbar is not in the scoped header")
      assertNativeStyles(settingsStyles)
    })
    await test("Settings badges sit outside switch wrappers and retest without toggling", async () => {
      const badge = select(".odm-model-status--interactive")
      assert(badge.parentElement?.matches('[data-slot="settings-row-control"]'), "Badge is inside native switch markup")
      const before = fixture.toggles
      badge.click()
      assert(select(".odm-test-btn").hasAttribute("disabled"), "Batch testing should wait for the single-model retest")
      await waitFor(() => fixture.calls.length === 1 && !badge.classList.contains("odm-model-status--testing"))
      assert(!select(".odm-test-btn").hasAttribute("disabled"), "Batch testing stayed disabled after the retest")
      assert(fixture.toggles === before, "Retest toggled model visibility")
      assert(doc.querySelectorAll(".odm-model-status").length === 2, "Non-model switch received a badge")
    })
    await test("Settings and selector can coexist without stealing toolbars", async () => {
      fixture.mount("both")
      await paint()
      assert(doc.querySelectorAll(".odm-models-test-bar").length === 2, "Missing toolbar in one of the surfaces")
      assert(doc.querySelectorAll(".odm-model-selector-container").length === 1, "More than the selector was sized")
      select("#selector-overlay").remove()
      await paint()
      assert(doc.querySelectorAll(".odm-models-test-bar").length === 1, "Closing selector removed settings toolbar")
    })
    await test("Manage-models dialog keeps its native size and ignores provider switches", async () => {
      fixture.stop()
      fixture.mount("manage")
      const before = rect("#manage-overlay > [data-slot='dialog-container']")
      const native = styles()
      fixture.start()
      await paint()
      const after = rect("#manage-overlay > [data-slot='dialog-container']")
      assert(near(before.width, after.width) && near(before.height, after.height), "Manage dialog size changed")
      assert(doc.querySelectorAll(".manage-models-search > .odm-models-test-bar").length === 1, "Manage toolbar missing")
      assert(doc.querySelectorAll(".manage-models-rows .odm-model-status").length === 2, "Wrong manage row badges")
      assert(!doc.querySelector(".settings-models-group-header .odm-model-status"), "Provider switch mistaken for model row")
      assertNativeStyles(native)
    })
    await test("An unrelated Models heading/search/switch receives no injection", async () => {
      fixture.mount("unrelated", "搜索模型")
      await paint()
      assert(empty(), "Unrelated surface was enhanced")
      assert(near(rect("#fixture-app").width, child.innerWidth), "Application root was narrowed")
    })

    for (const [width, height] of [[390, 640], [320, 480], [900, 300]]) {
      await test(`Selector stays centered and scrolls within a ${width} × ${height} window`, async () => {
        resize(width, height)
        fixture.mount("selector", "モデルを検索")
        select(`[data-option-key="${keyOf(models[1])}"]`).insertAdjacentHTML("beforeend", '<span data-slot="model-dialog-variant"><span class="truncate">Very high reasoning effort</span><span>›</span></span>')
        await paint()
        const box = rect("#selector-overlay > [data-slot='dialog-container']")
        assert(box.x >= 12 && box.right <= child.innerWidth - 11, "Horizontal overflow")
        assert(box.y >= 0 && box.bottom <= child.innerHeight, "Vertical overflow")
        assert(near(box.height, child.innerHeight * 0.8), "Dialog is not using 80% of the window height")
        assert(near(box.x + box.width / 2, child.innerWidth / 2) && near(box.y + box.height / 2, child.innerHeight / 2), "Small dialog is off-center")
        assert(doc.documentElement.scrollWidth <= child.innerWidth, "Page scrolls horizontally")
        const scroll = select('[data-slot="search-list-scroll"]')
        assert(scroll.clientHeight > 0 && scroll.scrollHeight > scroll.clientHeight, "List is clipped instead of scrollable")
        const row = select(`[data-option-key="${keyOf(models[1])}"]`)
        assert(row.scrollWidth <= row.clientWidth, "Status badge and variant overflow the model row")
        assert(row.querySelector('[data-slot="model-dialog-name"]')!.getBoundingClientRect().width > 20, "Status badge squeezed out the model name")
        assert(select(".model-dialog input").getBoundingClientRect().width > 60, "Toolbar squeezed out the search field")
      })
    }

    await test("Returned cleanup removes all injections and restores native dimensions", async () => {
      resize(1200, 900)
      fixture.mount("selector")
      await paint()
      fixture.stop()
      await paint()
      assert(empty() && !fixture.commandActive, "Plugin nodes or command survived cleanup")
      assert(near(rect("#selector-overlay > [data-slot='dialog-container']").width, 480), "Native width was not restored")
      fixture.mount("settings")
      await paint()
      assert(empty(), "Pending frame resurrected the plugin")
    })
    await test("Late metadata cannot remount an aborted plugin", async () => {
      fixture.mount("selector")
      fixture.start({ deferMetadata: true })
      fixture.stop(true)
      fixture.releaseMetadata()
      await paint()
      assert(empty() && !fixture.commandActive, "Late metadata resurrected the plugin")
    })
    await test("Metadata arriving after mount updates badges without DOM polling", async () => {
      fixture.start({ deferMetadata: true })
      await paint()
      assert(!doc.querySelector(".odm-model-status"), "Deferred model metadata was not deferred")
      fixture.releaseMetadata()
      await paint()
      assert(doc.querySelectorAll(".odm-model-status").length === 2, "Late metadata did not render results")
    })
    await test("Cancel stops model requests and clears pending test indicators", async () => {
      fixture.start({ holdRequests: true })
      await paint()
      select(".odm-test-btn").click()
      await waitFor(() => fixture.calls.length === 2)
      select(".odm-cancel-btn").click()
      await waitFor(() => !select(".odm-test-btn").hasAttribute("disabled"))
      assert(fixture.calls.every((call) => call.signal?.aborted), "Cancel did not abort the requests")
      assert(!doc.querySelector(".odm-model-status--testing"), "Cancelled models still show testing")
      fixture.releaseRequests()
    })
    await test("Context abort cancels in-flight tests without reinjecting UI", async () => {
      fixture.start({ holdRequests: true })
      await paint()
      select(".odm-test-btn").click()
      await waitFor(() => fixture.calls.length === 2)
      fixture.stop(true)
      fixture.releaseRequests()
      await paint()
      assert(fixture.calls.every((call) => call.signal?.aborted), "Requests survived context abort")
      assert(empty() && !fixture.commandActive, "Late test completion resurrected the plugin")
    })

    results.forEach((result) => {
      const item = document.createElement("li")
      item.className = result.passed ? "pass" : "fail"
      item.textContent = `${result.passed ? "PASS" : "FAIL"} · ${result.name}${result.detail ? ` — ${result.detail}` : ""}`
      checks.append(item)
    })
    output.textContent = `${results.filter((result) => result.passed).length}/${results.length} checks passed`
    fixture.stop()
    fixture.mount("selector")
    fixture.start()
    return results
  }

  resize(1200, 900)
  fixture.mount("selector")
  fixture.start()
  screen.onchange = () => fixture.mount(screen.value as Screen)
  size.onchange = () => { const [width, height] = size.value.split(",").map(Number); resize(width, height) }
  root.querySelector<HTMLButtonElement>("#enable")!.onclick = () => fixture.start()
  root.querySelector<HTMLButtonElement>("#disable")!.onclick = () => fixture.stop()
  root.querySelector<HTMLButtonElement>("#run")!.onclick = () => { void run() }
  Object.assign(window, { runModelTesterRegression: run })
}

if (new URLSearchParams(location.search).has("frame")) {
  Object.assign(window, { modelTesterFixture: createFixture() })
} else {
  void createRunner()
}
