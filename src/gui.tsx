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
import { belongsToServer, findFavorite, type Favorite } from "./favorites"
import { FavoriteButton, FavoriteList } from "./favorites-ui"
import favoritesCss from "./favorites.css?inline"
import { groupSessionsByProject, type ProjectInfo } from "./project-groups"
import { ProjectGroupSection } from "./project-group-ui"

const PAGE_SIZE = 100

const definition = Plugin.define({
  i18n: {
    en: {
      "command.group": "Session Manager",
      "command.pinCurrent": "Favorite current session",
      "command.unpinCurrent": "Unfavorite current session",
      "command.clear": "Clear unfavorited sessions",
      "command.openManager": "Open Session Manager",
      "toast.pinned": "Session favorited",
      "toast.unpinned": "Session removed from favorites",
      "toast.clearScanning": "Checking unfavorited sessions…",
      "toast.clearNone": "There are no unfavorited sessions to clear.",
      "toast.clearComplete": "Deleted {count} unfavorited sessions.",
      "toast.clearPartial": "Deleted {deleted}; {failed} could not be deleted.",
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
      "settings.updated": "Updated {date}",
      "settings.otherServer": "Saved on another server; click to open.",
      "settings.unknownProject": "Unknown project",
      "settings.filterPlaceholder": "Search sessions or projects",
      "settings.emptyFavoriteMatches": "No favorites match this search.",
      "action.pin": "Favorite",
      "action.unpin": "Unfavorite",
      "action.favoriteSession": "Favorite this session",
      "action.favorited": "Favorited",
      "action.openFavorite": "Open session: {title}",
      "action.removeFavorite": "Unfavorite {title} (does not delete the session)",
      "action.clear": "Clear unfavorited",
      "action.cancel": "Cancel",
      "action.closeManager": "Close manager",
      "action.expandAll": "Expand all projects",
      "action.collapseAll": "Collapse all projects",
      "clear.title": "Delete unfavorited sessions?",
      "clear.description":
        "This permanently deletes {count} non-archived root sessions and their child sessions from the built-in service across projects. Favorite sessions are kept.",
      "clear.confirm": "Delete sessions",
      "error.load": "Could not load sessions from the active OpenCode service.",
      "error.open": "Could not open this session. Check its server connection; the session may have been deleted.",
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
        const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(timestamp),
        )
        return ctx.t("settings.updated", { date })
      }

      const actions = () => (
        <>
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
        </>
      )

      const content = () => (
        <>
          <div class="odm-manager-search">
            <ui.TextInput
              label={ctx.t("settings.filter")}
              placeholder={ctx.t("settings.filterPlaceholder")}
              value={query()}
              onInput={setQuery}
              type="search"
            />
          </div>

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
                  <For each={group.sessions}>
                    {(session) => (
                      <ui.SettingsRow
                        title={session.title || ctx.t("settings.untitled")}
                        description={updatedDescription(session.time.updated)}
                      >
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
                      </ui.SettingsRow>
                    )}
                  </For>
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
