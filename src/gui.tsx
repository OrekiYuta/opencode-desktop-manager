import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import {
  Command,
  Plugin,
  Slot,
  Store,
  Style,
  TitlebarItem,
  type DialogHandle,
  type MountedSession,
} from "@opencode/plugin/gui"
import {
  belongsToServer,
  findFavorite,
  type Favorite,
  FavoriteButton,
  FavoriteList,
  favoritesCss,
  groupSessionsByProject,
  type ProjectInfo,
  ProjectGroupSection,
} from "./session-manager"
import {
  setupModelTester,
  triggerModelTest,
  modelTesterCss,
} from "./model-availability-tester"
import { UsageRpc, type UsageResult } from "./github-copilot-usage/rpc"
import { formatUsageDate, isCreditQuota, usedPercentage } from "./github-copilot-usage/view"
import usageCss from "./github-copilot-usage/usage.css?inline"

const PAGE_SIZE = 100

const definition = Plugin.define({
  i18n: {
    en: {
      "command.group": "Session Manager",
      "command.pinCurrent": "Favorite current session",
      "command.unpinCurrent": "Unfavorite current session",
      "command.clear": "Clear unfavorited sessions",
      "command.openManager": "Open Session Manager",
      "command.openCopilotUsage": "Open GitHub Copilot Usage",
      "usage.title": "GitHub Copilot Usage",
      "usage.description": "Account-wide Copilot usage",
      "usage.refresh": "Refresh",
      "usage.close": "Close",
      "usage.loading": "Loading Copilot usage…",
      "usage.unavailable": "Unavailable",
      "usage.usernameUnavailable": "Username unavailable",
      "usage.profile.unauthorized": "GitHub profile: authorization failed (401)",
      "usage.profile.forbidden": "GitHub profile: access denied (403)",
      "usage.profile.rateLimited": "GitHub profile: rate limited (429)",
      "usage.profile.network": "GitHub profile: connection failed",
      "usage.profile.invalid": "GitHub profile: invalid response",
      "usage.used": "Used",
      "usage.remaining": "Remaining",
      "usage.total": "Total",
      "usage.usedPercent": "AI credits used",
      "usage.reset": "Resets",
      "usage.updated": "Data updated",
      "usage.unlimited": "Unlimited",
      "usage.noQuota": "No quota available",
      "usage.notTokenBilled": "Not token-based billing; AI credits unavailable",
      "usage.unknownBilling": "Billing type unavailable; AI credits unavailable",
      "usage.stale": "Data may be out of date.",
      "usage.note": "Based on a GitHub internal API. Data may be delayed or change without notice.",
      "usage.error.connection": "Connect GitHub Copilot in OpenCode to view usage.",
      "usage.error.unauthorized": "GitHub authorization failed. Reconnect GitHub Copilot and try again.",
      "usage.error.forbidden": "GitHub denied access to Copilot usage for this account.",
      "usage.error.network": "Could not reach GitHub. Check your connection and try again.",
      "usage.error.response": "GitHub returned an unexpected response. Usage is unavailable.",
      "usage.error.rateLimited": "Refresh is temporarily limited. Try again shortly.",
      "usage.error.generic": "Could not load Copilot usage. Try again.",
      "command.testEnabledModels": "Test Enabled Models",
      "toast.pinned": "Session favorited",
      "toast.unpinned": "Session removed from favorites",
      "toast.clearScanning": "Checking unfavorited sessions…",
      "toast.clearNone": "There are no unfavorited sessions to clear.",
      "toast.clearComplete": "Deleted {{count}} unfavorited sessions.",
      "toast.clearPartial": "Deleted {{deleted}}; {{failed}} could not be deleted.",
      "toast.clearFailed": "Could not clear sessions.",
      "toast.clearCancelled": "Session cleanup cancelled.",
      "settings.title": "Session Manager",
      "settings.description":
        "Click a favorite to open it. × only removes the favorite. Clearing permanently deletes unfavorited, non-archived root sessions and their child sessions from the built-in service across projects.",
      "settings.pinned": "Favorite sessions",
      "settings.recent": "Recent sessions",
      "settings.filter": "Filter sessions",
      "settings.refresh": "Refresh",
      "settings.loadMore": "Load more",
      "settings.moreSessions": "More sessions",
      "settings.loading": "Loading sessions…",
      "settings.emptyPinned": "No favorites yet. Use ☆ in a session header to save it here.",
      "settings.emptyRecent": "No matching unfavorited sessions.",
      "settings.notLoaded": "Not in the loaded recent sessions; it may be archived or older.",
      "settings.untitled": "Untitled session",
      "settings.updated": "Updated {{date}}",
      "settings.otherServer": "Saved on another server; click to open.",
      "settings.unknownProject": "Unknown project",
      "settings.filterPlaceholder": "Search sessions or projects",
      "settings.emptyFavoriteMatches": "No favorites match this search.",
      "action.pin": "Favorite",
      "action.unpin": "Unfavorite",
      "action.favoriteSession": "Favorite this session",
      "action.favorited": "Favorited",
      "action.openFavorite": "Open session: {{title}}",
      "action.removeFavorite": "Unfavorite {{title}} (does not delete the session)",
      "action.deleteSession": "Delete session {{title}}",
      "deleteSession.title": "Delete session?",
      "deleteSession.description": "This permanently deletes \"{{title}}\" from the built-in service.",
      "deleteSession.confirm": "Delete",
      "action.clear": "Clear unfavorited",
      "action.cancel": "Cancel",
      "action.closeManager": "Close manager",
      "action.expandAll": "Expand all projects",
      "action.collapseAll": "Collapse all projects",
      "clear.title": "Delete unfavorited sessions?",
      "clear.description":
        "This permanently deletes {{count}} non-archived root sessions and their child sessions from the built-in service across projects. Favorite sessions are kept.",
      "clear.confirm": "Delete sessions",
      "error.load": "Could not load sessions from the active OpenCode service.",
      "error.open": "Could not open this session. Check its server connection; the session may have been deleted.",
      "modelTest.button": "Test Enabled Models",
      "modelTest.testing": "Testing ({{current}}/{{total}})...",
      "modelTest.retest": "Retest Enabled Models",
      "modelTest.cancel": "Cancel",
      "modelTest.status.testing": "Testing",
      "modelTest.status.unavailable": "Unavailable",
      "modelTest.tooltip.success": "Status: Functional\nLatency: {{latency}}\nTested: {{time}}",
      "modelTest.tooltip.error": "Status: Unavailable ({{error}})\nLatency: {{latency}}\nTested: {{time}}",
      "modelTest.toast.scanning": "Testing enabled models...",
      "modelTest.toast.noneEnabled": "No enabled models found to test",
      "modelTest.toast.allSuccess": "All {{total}} enabled models passed testing",
      "modelTest.toast.complete": "Model test complete: {{success}} passed, {{failed}} failed",
    },
  },
  stores: {
    state: Store.global(
      Schema.Struct({
        pinned: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            server: Schema.optional(Schema.String),
            projectID: Schema.optional(Schema.String),
            directory: Schema.optional(Schema.String),
          }),
        ),
      }),
      { pinned: [] },
      ["plugin.opencode-ui-manager.state"],
    ),
  },
  setup(ctx) {
    type SessionInfo = Awaited<ReturnType<typeof ctx.client.session.list>>["data"][number]

    const [refreshVersion, setRefreshVersion] = createSignal(0)
    const [clearBusy, setClearBusy] = createSignal(false)
    const [pinBusy, setPinBusy] = createSignal<string[]>([])
    const [managerOpen, setManagerOpen] = createSignal(false)
    const [collapsedProjects, setCollapsedProjects] = createSignal<string[]>([])
    const [expandedRecentProjects, setExpandedRecentProjects] = createSignal<string[]>([])
    let managerDialog: DialogHandle | undefined

    ctx.add(Style, favoritesCss)
    ctx.add(Style, modelTesterCss)
    ctx.add(Style, usageCss)
    setupModelTester(ctx)

    const builtinServer = () => ctx.servers.list().map((id) => ctx.servers.get(id)).find((server) => server?.builtin)
    const pinned = () => ctx.stores.state.value.pinned
    const isPinned = (id: string, server = builtinServer()) =>
      !!server && findFavorite(pinned(), id, server.id, server.builtin) >= 0

    function togglePin(
      id: string,
      title: string,
      server = builtinServer(),
      metadata?: Pick<Favorite, "projectID" | "directory">,
    ) {
      if (!server) return
      const wasPinned = isPinned(id, server)
      ctx.stores.state.update((draft) => {
        const index = findFavorite(draft.pinned, id, server.id, server.builtin)
        if (index >= 0) {
          draft.pinned.splice(index, 1)
          return
        }
        draft.pinned.unshift({
          id,
          title: title || ctx.t("settings.untitled"),
          ...(server.builtin ? {} : { server: server.id }),
          ...metadata,
        })
      })
      ctx.toast.show({
        variant: "success",
        title: ctx.t(wasPinned ? "toast.unpinned" : "toast.pinned"),
      })
    }

    async function toggleSessionPin(session: MountedSession) {
      if (session.pending || pinBusy().includes(session.key)) return
      const { id, key, server } = session
      setPinBusy((keys) => [...keys, key])
      try {
        if (isPinned(id, server)) {
          togglePin(id, "", server)
          return
        }
        let title = ctx.t("settings.untitled")
        let metadata: Pick<Favorite, "projectID" | "directory"> = {
          directory: session.directory,
          projectID: session.project?.id,
        }
        try {
          const info = await server.client.session.get({ sessionID: id }, { signal: ctx.signal })
          title = info.title || title
          metadata = { projectID: info.projectID, directory: info.location.directory }
        } catch {
          // Keep a known session favoritable if its title is temporarily unavailable.
        }
        if (!ctx.signal.aborted && !isPinned(id, server)) togglePin(id, title, server, metadata)
      } finally {
        setPinBusy((keys) => keys.filter((item) => item !== key))
      }
    }

    async function toggleCurrentPin() {
      const session = ctx.sessions.current()
      if (session) await toggleSessionPin(session)
    }

    function removeFavorite(favorite: Favorite) {
      ctx.stores.state.update((draft) => {
        const index = draft.pinned.findIndex((item) => item.id === favorite.id && item.server === favorite.server)
        if (index >= 0) draft.pinned.splice(index, 1)
      })
      ctx.toast.show({ variant: "success", title: ctx.t("toast.unpinned") })
    }

    async function openFavorite(favorite: Favorite): Promise<boolean> {
      const server = favorite.server === undefined ? builtinServer() : ctx.servers.get(favorite.server)
      try {
        if (!server) throw new Error("Favorite server is unavailable")
        await server.client.session.get({ sessionID: favorite.id }, { signal: ctx.signal })
        if (ctx.signal.aborted) return false
        ctx.tabs.open({ server: server.id, id: favorite.id }, { focus: true })
        return true
      } catch {
        if (!ctx.signal.aborted) ctx.toast.show({ variant: "error", title: ctx.t("error.open") })
        return false
      }
    }

    ctx.add(Slot, {
      at: "session.header",
      render: (input) => (
        <FavoriteButton
          favorite={isPinned(input.session.id, input.session.server)}
          busy={input.session.pending || pinBusy().includes(input.session.key)}
          compact={input.compact}
          label={ctx.t(
            isPinned(input.session.id, input.session.server) ? "action.favorited" : "action.favoriteSession",
          )}
          hint={ctx.t(
            isPinned(input.session.id, input.session.server) ? "action.unpin" : "action.favoriteSession",
          )}
          onToggle={() => void toggleSessionPin(input.session)}
        />
      ),
    })

    async function listAllVisibleRootSessions(signal: AbortSignal): Promise<SessionInfo[]> {
      const sessions: SessionInfo[] = []
      let cursor: string | undefined
      const seenCursors = new Set<string>()

      while (true) {
        const page = await ctx.client.session.list(
          {
            parentID: null,
            archived: false,
            limit: PAGE_SIZE,
            order: "desc",
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        )
        sessions.push(...page.data)

        const next = page.cursor.next ?? undefined
        if (!next || seenCursors.has(next)) break
        seenCursors.add(next)
        cursor = next
      }

      return sessions
    }

    async function deleteSingleSession(session: { id: string; title: string }) {
      const confirmed = await ctx.dialogs.confirm({
        title: ctx.t("deleteSession.title"),
        description: ctx.t("deleteSession.description", { title: session.title || ctx.t("settings.untitled") }),
        confirm: ctx.t("deleteSession.confirm"),
        cancel: ctx.t("action.cancel"),
        danger: true,
      })
      if (!confirmed) return
      try {
        await ctx.client.session.remove({ sessionID: session.id }, { signal: ctx.signal })
        setRefreshVersion((version) => version + 1)
        ctx.toast.show({ variant: "success", title: ctx.t("toast.clearComplete", { count: 1 }) })
      } catch {
        ctx.toast.show({ variant: "error", title: ctx.t("toast.clearFailed") })
      }
    }

    async function clearUnpinnedSessions() {
      if (clearBusy()) return
      setClearBusy(true)
      const scanToast = ctx.toast.show({
        variant: "loading",
        title: ctx.t("toast.clearScanning"),
        persistent: true,
      })

      try {
        const all = await listAllVisibleRootSessions(ctx.signal)
        scanToast.dismiss()

        const keep = new Set(
          pinned()
            .filter((item) => item.server === undefined || item.server === builtinServer()?.id)
            .map((item) => item.id),
        )
        const targets = all.filter((session) => !keep.has(session.id))
        if (targets.length === 0) {
          ctx.toast.show({ variant: "success", title: ctx.t("toast.clearNone") })
          return
        }

        const confirmed = await ctx.dialogs.confirm({
          title: ctx.t("clear.title"),
          description: ctx.t("clear.description", { count: targets.length }),
          confirm: ctx.t("clear.confirm"),
          cancel: ctx.t("action.cancel"),
          danger: true,
        })
        if (!confirmed) return

        // Re-check pins after confirmation in case another window changed them.
        const latestPins = new Set(
          pinned()
            .filter((item) => item.server === undefined || item.server === builtinServer()?.id)
            .map((item) => item.id),
        )
        const deletions = targets.filter((session) => !latestPins.has(session.id))
        if (deletions.length === 0) {
          ctx.toast.show({ variant: "success", title: ctx.t("toast.clearNone") })
          return
        }

        const deleteToast = ctx.toast.show({
          variant: "loading",
          title: ctx.t("clear.confirm", { count: deletions.length }),
          persistent: true,
        })
        let deleted = 0
        let failed = 0
        const batchSize = 8

        for (let index = 0; index < deletions.length; index += batchSize) {
          const batch = deletions.slice(index, index + batchSize)
          const results = await Promise.allSettled(
            batch.map((session) =>
              ctx.client.session.remove({ sessionID: session.id }, { signal: ctx.signal }),
            ),
          )
          for (const result of results) {
            if (result.status === "fulfilled") deleted += 1
            else failed += 1
          }
        }

        deleteToast.dismiss()
        setRefreshVersion((version) => version + 1)
        ctx.toast.show({
          variant: failed > 0 ? "error" : "success",
          title:
            failed > 0
              ? ctx.t("toast.clearPartial", { deleted, failed })
              : ctx.t("toast.clearComplete", { count: deleted }),
        })
      } catch {
        scanToast.dismiss()
        ctx.toast.show({ variant: "error", title: ctx.t("toast.clearFailed") })
      } finally {
        setClearBusy(false)
      }
    }

    ctx.add(Command, () => {
      const session = ctx.sessions.current()
      return {
        id: "toggle-pin-current",
        title: ctx.t(
          session && isPinned(session.id, session.server) ? "command.unpinCurrent" : "command.pinCurrent",
        ),
        group: ctx.t("command.group"),
        enabled: !!session && !session.pending && !pinBusy().includes(session.key),
        run: () => void toggleCurrentPin(),
      }
    })

    ctx.add(Command, () => ({
      id: "clear-unpinned",
      title: ctx.t("command.clear"),
      group: ctx.t("command.group"),
      enabled: !clearBusy(),
      run: () => void clearUnpinnedSessions(),
    }))

    ctx.add(Command, () => ({
      id: "open-manager",
      title: ctx.t("command.openManager"),
      group: ctx.t("command.group"),
      run: openManager,
    }))

    ctx.add(Command, () => ({
      id: "test-enabled-models",
      title: ctx.t("command.testEnabledModels"),
      group: ctx.t("command.group"),
      run: () => {
        if (triggerModelTest) {
          void triggerModelTest()
        }
      },
    }))

    function openManager() {
      if (managerOpen()) return
      setManagerOpen(true)
      managerDialog = ctx.dialogs.open((dialog) => {
        onCleanup(() => {
          managerDialog = undefined
          setManagerOpen(false)
        })
        return <ManagerPage dialog={dialog} />
      })
    }

    ctx.add(TitlebarItem, (): TitlebarItem => ({
      id: "session-manager",
      label: ctx.t("settings.title"),
      title: `opencode-desktop-manager: ${ctx.t("command.openManager")}`,
      icon: "bullet-list",
      pressed: managerOpen(),
      run: () => {
        if (managerOpen()) managerDialog?.close()
        else openManager()
      },
    }))

    const [usageOpen, setUsageOpen] = createSignal(false)
    const [cachedUsageResult, setCachedUsageResult] = createSignal<UsageResult>()
    let usageDialog: DialogHandle | undefined

    // Proactively query usage periodically in background so titlebar button displays current percentage
    async function backgroundPollUsage() {
      try {
        const res = await ctx.client.rpc(UsageRpc).get({ refresh: false }, { signal: ctx.signal })
        setCachedUsageResult(res as UsageResult)
      } catch {
        // Silent failure for background metric lookup
      }
    }
    void backgroundPollUsage()
    const pollInterval = setInterval(() => void backgroundPollUsage(), 5 * 60_000)
    onCleanup(() => clearInterval(pollInterval))

    function openUsage() {
      if (usageOpen()) return
      setUsageOpen(true)
      usageDialog = ctx.dialogs.open((dialog) => {
        onCleanup(() => {
          usageDialog = undefined
          setUsageOpen(false)
        })
        return <UsagePage dialog={dialog} initialResult={cachedUsageResult()} onResultChange={setCachedUsageResult} />
      })
    }

    ctx.add(Command, () => ({
      id: "open-copilot-usage",
      title: ctx.t("command.openCopilotUsage"),
      group: ctx.t("usage.title"),
      run: openUsage,
    }))

    const copilotUsageTitlebarLabel = createMemo(() => {
      const q = cachedUsageResult()?.data?.quotas?.premiumInteractions
      const percent = usedPercentage(q)
      if (typeof percent === "number") {
        const numStr = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
        return `GitHub Copilot Usage (${numStr}%)`
      }
      return ctx.t("usage.title")
    })

    ctx.add(TitlebarItem, (): TitlebarItem => ({
      id: "copilot-usage",
      label: copilotUsageTitlebarLabel(),
      title: `opencode-desktop-manager: ${ctx.t("command.openCopilotUsage")}`,
      icon: "github",
      pressed: usageOpen(),
      run: () => {
        if (usageOpen()) usageDialog?.close()
        else openUsage()
      },
    }))

    function UsagePage(props: {
      dialog: DialogHandle
      initialResult?: UsageResult
      onResultChange?: (result: UsageResult) => void
    }) {
      const ui = ctx.ui
      const [result, setResult] = createSignal<UsageResult | undefined>(props.initialResult)
      const [loading, setLoading] = createSignal(false)
      const [failed, setFailed] = createSignal(false)
      let disposed = false
      const controller = new AbortController()
      let timer: ReturnType<typeof setInterval> | undefined
      onCleanup(() => {
        disposed = true
        controller.abort()
        if (timer !== undefined) clearInterval(timer)
      })

      async function load(refresh: boolean) {
        if (loading()) return
        setLoading(true)
        setFailed(false)
        try {
          const response = await ctx.client.rpc(UsageRpc).get({ refresh }, { signal: controller.signal })
          if (!disposed) {
            setResult(response as UsageResult)
            props.onResultChange?.(response as UsageResult)
          }
        } catch {
          // Do not surface exception text: it may contain request or authentication details.
          if (!disposed) setFailed(true)
        } finally {
          if (!disposed) setLoading(false)
        }
      }

      onMount(() => {
        void load(false)
        timer = setInterval(() => void load(false), 5 * 60_000)
      })

      const data = () => result()?.data
      const quota = () => data()?.quotas.premiumInteractions
      const creditMode = () => isCreditQuota(quota())
      const usedPercent = () => usedPercentage(quota())
      const number = (value: number | null | undefined) =>
        typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : ctx.t("usage.unavailable")
      const date = (value: string | null | undefined) => formatUsageDate(value) ?? ctx.t("usage.unavailable")
      const quotaStatus = () => {
        const value = quota()
        if (!value) return ctx.t("usage.unavailable")
        if (value.unlimited === true) return ctx.t("usage.unlimited")
        if (value.hasQuota === false) return ctx.t("usage.noQuota")
        if (value.tokenBasedBilling === false) return ctx.t("usage.notTokenBilled")
        if (value.tokenBasedBilling !== true) return ctx.t("usage.unknownBilling")
        return ctx.t("usage.unavailable")
      }
      const profileError = () => {
        switch (data()?.loginStatus) {
          case "unauthorized": return ctx.t("usage.profile.unauthorized")
          case "forbidden": return ctx.t("usage.profile.forbidden")
          case "rate_limited": return ctx.t("usage.profile.rateLimited")
          case "network_error": return ctx.t("usage.profile.network")
          case "invalid_response": return ctx.t("usage.profile.invalid")
          default: return ""
        }
      }
      const error = () => {
        if (failed()) return ctx.t("usage.error.generic")
        switch (result()?.status) {
          case "not_authenticated": return ctx.t("usage.error.connection")
          case "unauthorized": return ctx.t("usage.error.unauthorized")
          case "forbidden": return ctx.t("usage.error.forbidden")
          case "network_error": return ctx.t("usage.error.network")
          case "invalid_response": return ctx.t("usage.error.response")
          case "rate_limited": return ctx.t("usage.error.rateLimited")
          default: return ""
        }
      }

      return (
        <ui.Dialog
          title={ctx.t("usage.title")}
          description={ctx.t("usage.description")}
          footer={<ui.Button variant="neutral" onClick={() => props.dialog.close()}>{ctx.t("usage.close")}</ui.Button>}
        >
          <div class="odm-usage">
            <div class="odm-usage-top">
              <Show when={data()}>
                <div class="odm-usage-account">
                  <span class="odm-usage-account-icon"><ui.Icon name="github" size="small" /></span>
                  <div>
                    <div class="odm-usage-account-name">{data()?.login ?? ctx.t("usage.usernameUnavailable")}</div>
                    <div class="odm-usage-muted">{data()?.plan ?? ctx.t("usage.unavailable")}</div>
                    <Show when={!data()?.login && profileError()}>
                      <div class="odm-usage-profile-error">{profileError()}</div>
                    </Show>
                  </div>
                </div>
              </Show>
              <ui.Button variant="ghost" onClick={() => void load(true)} disabled={loading()} busy={loading()}>
                {ctx.t("usage.refresh")}
              </ui.Button>
            </div>
            <Show when={loading() && !result()}><div>{ctx.t("usage.loading")}</div></Show>
            <div role="status" class="odm-usage-feedback">
              <Show when={error() || result()?.stale || (failed() && data())}>
                <div class="odm-usage-status">
                  {error()} {result()?.stale || (failed() && data()) ? ctx.t("usage.stale") : ""}
                </div>
              </Show>
            </div>
            <Show when={data()}>
              <div class="odm-usage-hero">
                <div class="odm-usage-muted">{ctx.t("usage.usedPercent")}</div>
                <Show when={usedPercent() !== undefined} fallback={<div class="odm-usage-status">{quotaStatus()}</div>}>
                  <div class="odm-usage-percentage">{number(usedPercent())}%</div>
                  <meter class="odm-usage-meter" min="0" max="100" value={usedPercent()} aria-label={ctx.t("usage.usedPercent")} />
                </Show>
              </div>
              <dl class="odm-usage-stats">
                <div><dt>{ctx.t("usage.used")}</dt><dd>{number(creditMode() ? quota()?.creditsUsed : null)}</dd></div>
                <div><dt>{ctx.t("usage.remaining")}</dt><dd>{number(creditMode() ? quota()?.remaining : null)}</dd></div>
                <div><dt>{ctx.t("usage.total")}</dt><dd>{number(creditMode() ? quota()?.entitlement : null)}</dd></div>
              </dl>
              <dl class="odm-usage-times">
                <div><dt>{ctx.t("usage.reset")}</dt><dd>{date(data()?.resetDate)}</dd></div>
                <div><dt>{ctx.t("usage.updated")}</dt><dd>{date(quota()?.timestampUtc)}</dd></div>
              </dl>
              <div class="odm-usage-muted">{ctx.t("usage.note")}</div>
            </Show>
          </div>
        </ui.Dialog>
      )
    }

    function ManagerPage(props: { dialog: DialogHandle }) {
      const ui = ctx.ui
      const [sessions, setSessions] = createSignal<SessionInfo[]>([])
      const [nextCursor, setNextCursor] = createSignal<string | undefined>()
      const [loading, setLoading] = createSignal(false)
      const [error, setError] = createSignal(false)
      const [query, setQuery] = createSignal("")
      const [projects, setProjects] = createSignal<Record<string, readonly ProjectInfo[]>>({})
      const [favoriteDetails, setFavoriteDetails] = createSignal<Record<string, SessionInfo>>({})
      const [searchCollapsedProjects, setSearchCollapsedProjects] = createSignal<string[]>([])
      let controller: AbortController | undefined

      const favoriteServerID = (favorite: Favorite) => favorite.server ?? builtinServer()?.id ?? "sidecar"
      const favoriteKey = (favorite: Favorite) => JSON.stringify([favoriteServerID(favorite), favorite.id])

      async function loadProjectDetails(signal: AbortSignal) {
        const serverIDs = [
          ...new Set([builtinServer()?.id, ...pinned().map(favoriteServerID)].filter((id): id is string => !!id)),
        ]
        await Promise.all(
          serverIDs.map(async (id) => {
            const server = ctx.servers.get(id)
            if (!server) return
            try {
              const list = await server.client.project.list({}, { signal })
              if (!signal.aborted) setProjects((previous) => ({ ...previous, [id]: list }))
            } catch {
              // Directory-based grouping remains available when project metadata fails.
            }
          }),
        )

        const missing = pinned().filter(
          (favorite) =>
            favorite.server !== undefined || !sessions().some((session) => session.id === favorite.id),
        )
        for (let index = 0; index < missing.length && !signal.aborted; index += 8) {
          await Promise.all(
            missing.slice(index, index + 8).map(async (favorite) => {
              const server = ctx.servers.get(favoriteServerID(favorite))
              if (!server) return
              try {
                const info = await server.client.session.get({ sessionID: favorite.id }, { signal })
                if (!signal.aborted) setFavoriteDetails((previous) => ({ ...previous, [favoriteKey(favorite)]: info }))
              } catch {
                // Deleted / unavailable favorites stay removable in the unknown-project group.
              }
            }),
          )
        }
      }

      async function loadSessions(append: boolean) {
        controller?.abort()
        const currentController = new AbortController()
        controller = currentController
        setLoading(true)
        setError(false)
        const detailsLoaded = append ? Promise.resolve() : loadProjectDetails(currentController.signal)

        try {
          const cursor = append ? nextCursor() : undefined
          const page = await ctx.client.session.list(
            {
              parentID: null,
              archived: false,
              limit: PAGE_SIZE,
              order: "desc",
              ...(cursor ? { cursor } : {}),
            },
            { signal: currentController.signal },
          )
          if (currentController.signal.aborted) return

          setSessions((previous) => {
            if (!append) return page.data
            const ids = new Set(previous.map((item) => item.id))
            return [...previous, ...page.data.filter((item) => !ids.has(item.id))]
          })
          setNextCursor(page.cursor.next ?? undefined)
        } catch {
          if (!currentController.signal.aborted) setError(true)
        } finally {
          await detailsLoaded
          if (controller === currentController) {
            controller = undefined
            setLoading(false)
          }
        }
      }

      onMount(() => void loadSessions(false))
      onCleanup(() => controller?.abort())
      createEffect(on(refreshVersion, () => void loadSessions(false), { defer: true }))

      const normalizedQuery = () => query().trim().toLocaleLowerCase()
      createEffect(on(normalizedQuery, () => setSearchCollapsedProjects([]), { defer: true }))

      const pinnedSessions = createMemo(() =>
        pinned().map((pin) => {
          const builtin = builtinServer()
          const local = !!builtin && belongsToServer(pin, builtin.id, true)
          const session =
            (local ? sessions().find((item) => item.id === pin.id) : undefined) ??
            favoriteDetails()[favoriteKey(pin)]
          return {
            id: pin.id,
            server: pin.server,
            serverID: favoriteServerID(pin),
            projectID: session?.projectID ?? pin.projectID,
            directory: session?.location.directory ?? pin.directory,
            title: session?.title || pin.title || ctx.t("settings.untitled"),
            description: session
              ? updatedDescription(session.time.updated)
              : local
                ? ctx.t("settings.notLoaded")
                : ctx.t("settings.otherServer"),
          }
        }),
      )

      const unpinnedSessions = createMemo(() => sessions().filter((session) => !isPinned(session.id)))

      const favoriteGroups = createMemo(() =>
        groupSessionsByProject(pinnedSessions(), projects(), ctx.t("settings.unknownProject"), query()),
      )

      const recentGroups = createMemo(() =>
        groupSessionsByProject(
          unpinnedSessions().map((session) => ({
            ...session,
            title: session.title || ctx.t("settings.untitled"),
            directory: session.location.directory,
            serverID: builtinServer()?.id ?? "sidecar",
          })),
          projects(),
          ctx.t("settings.unknownProject"),
          query(),
        ),
      )

      const expanded = (key: string) => {
        if (normalizedQuery()) return !searchCollapsedProjects().includes(key)
        if (key.startsWith("recent:")) return expandedRecentProjects().includes(key)
        return !collapsedProjects().includes(key)
      }

      function toggleProject(key: string) {
        if (!normalizedQuery() && key.startsWith("recent:")) {
          setExpandedRecentProjects((keys) =>
            keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
          )
          return
        }
        const update = normalizedQuery() ? setSearchCollapsedProjects : setCollapsedProjects
        update((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]))
      }

      function updatedDescription(timestamp?: number) {
        if (!timestamp) return ctx.t("settings.notLoaded")
        const d = new Date(timestamp)
        if (Number.isNaN(d.getTime())) return ctx.t("settings.notLoaded")
        const pad = (n: number) => String(n).padStart(2, "0")
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        return ctx.t("settings.updated", { date })
      }

      const actions = () => (
        <div class="odm-manager-toolbar-row">
          <div class="odm-manager-search-box">
            <ui.TextInput
              label={ctx.t("settings.filter")}
              placeholder={ctx.t("settings.filterPlaceholder")}
              value={query()}
              onInput={setQuery}
              type="search"
            />
          </div>
          <div class="odm-manager-buttons">
            <ui.Button
              variant="neutral"
              onClick={() => {
                if (normalizedQuery()) setSearchCollapsedProjects([])
                else {
                  setCollapsedProjects([])
                  setExpandedRecentProjects(recentGroups().map((group) => `recent:${group.key}`))
                }
              }}
            >
              {ctx.t("action.expandAll")}
            </ui.Button>
            <ui.Button
              variant="neutral"
              onClick={() => {
                const keys = [
                  ...favoriteGroups().map((group) => `favorites:${group.key}`),
                  ...recentGroups().map((group) => `recent:${group.key}`),
                ]
                if (normalizedQuery()) setSearchCollapsedProjects(keys)
                else {
                  setCollapsedProjects(keys)
                  setExpandedRecentProjects([])
                }
              }}
            >
              {ctx.t("action.collapseAll")}
            </ui.Button>
            <ui.Button
              variant="neutral"
              onClick={() => void loadSessions(false)}
              disabled={loading()}
              busy={loading()}
            >
              {ctx.t("settings.refresh")}
            </ui.Button>
            <ui.Button
              variant="danger"
              onClick={() => void clearUnpinnedSessions()}
              disabled={clearBusy()}
              busy={clearBusy()}
            >
              {ctx.t("action.clear")}
            </ui.Button>
          </div>
        </div>
      )

      const content = () => (
        <>
          <ui.SettingsSection title={ctx.t("settings.pinned")}>
            <Show
              when={favoriteGroups().length > 0}
              fallback={
                <ui.SettingsRow
                  title={ctx.t(pinned().length ? "settings.emptyFavoriteMatches" : "settings.emptyPinned")}
                />
              }
            >
              <For each={favoriteGroups()}>
                {(group) => (
                  <ProjectGroupSection
                    title={group.title}
                    directory={group.directory}
                    count={group.sessions.length}
                    expanded={expanded(`favorites:${group.key}`)}
                    onToggle={() => toggleProject(`favorites:${group.key}`)}
                  >
                    <FavoriteList
                      sessions={group.sessions}
                      openLabel={(title) => ctx.t("action.openFavorite", { title })}
                      removeLabel={(title) => ctx.t("action.removeFavorite", { title })}
                      onOpen={(session) => {
                        void openFavorite(session).then((opened) => {
                          if (opened) props.dialog.close()
                        })
                      }}
                      onRemove={removeFavorite}
                    />
                  </ProjectGroupSection>
                )}
              </For>
            </Show>
          </ui.SettingsSection>

          <ui.SettingsSection title={ctx.t("settings.recent")}>
            <Show when={error()}>
              <ui.SettingsRow title={ctx.t("error.load")} />
            </Show>
            <Show when={loading() && sessions().length === 0}>
              <ui.SettingsRow title={ctx.t("settings.loading")}>
                <ui.Loader size="small" />
              </ui.SettingsRow>
            </Show>
            <Show when={!loading() && !error() && recentGroups().length === 0}>
              <ui.SettingsRow title={ctx.t("settings.emptyRecent")} />
            </Show>
            <For each={recentGroups()}>
              {(group) => (
                <ProjectGroupSection
                  title={group.title}
                  directory={group.directory}
                  count={group.sessions.length}
                  expanded={expanded(`recent:${group.key}`)}
                  onToggle={() => toggleProject(`recent:${group.key}`)}
                >
                  <div class="odm-recent-grid">
                    <For each={group.sessions}>
                      {(session) => (
                        <div class="odm-recent-card">
                          <ui.SettingsRow
                            title={session.title || ctx.t("settings.untitled")}
                            description={updatedDescription(session.time.updated)}
                          >
                            <div class="odm-recent-actions">
                              <ui.Button
                                variant="contrast"
                                onClick={() =>
                                  togglePin(session.id, session.title || "", builtinServer(), {
                                    projectID: session.projectID,
                                    directory: session.location.directory,
                                  })
                                }
                              >
                                {ctx.t("action.pin")}
                              </ui.Button>
                              <ui.Button
                                variant="ghost"
                                onClick={() =>
                                  void deleteSingleSession({
                                    id: session.id,
                                    title: session.title || ctx.t("settings.untitled"),
                                  })
                                }
                              >
                                {ctx.t("deleteSession.confirm")}
                              </ui.Button>
                            </div>
                          </ui.SettingsRow>
                        </div>
                      )}
                    </For>
                  </div>
                </ProjectGroupSection>
              )}
            </For>
            <Show when={nextCursor()}>
              <ui.SettingsRow title={ctx.t("settings.moreSessions")}>
                <ui.Button
                  variant="ghost"
                  onClick={() => void loadSessions(true)}
                  disabled={loading()}
                  busy={loading()}
                >
                  {ctx.t("settings.loadMore")}
                </ui.Button>
              </ui.SettingsRow>
            </Show>
          </ui.SettingsSection>
        </>
      )

      return (
        <ui.Dialog
          title={ctx.t("settings.title")}
          description={ctx.t("settings.description")}
          size="x-large"
          footer={
            <ui.Button variant="neutral" onClick={() => props.dialog.close()}>
              {ctx.t("action.closeManager")}
            </ui.Button>
          }
        >
          <div class="odm-manager-dialog">
            <div class="odm-manager-toolbar">{actions()}</div>
            {content()}
          </div>
        </ui.Dialog>
      )
    }
  },
})

export default definition
