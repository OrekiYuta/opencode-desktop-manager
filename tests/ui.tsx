import { For, createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { FavoriteButton, FavoriteList } from "../src/favorites-ui"
import "../src/favorites.css"
import { groupSessionsByProject } from "../src/project-groups"
import { ProjectGroupSection } from "../src/project-group-ui"

const styles = document.createElement("style")
styles.textContent = `
  body { margin: 0; padding: 40px 24px; color: #293546; background: #f2f5fa; font-family: 'Segoe UI', system-ui, sans-serif; }
  main { max-width: 840px; margin: auto; } h1 { font-size: 24px; } p { color: #738095; line-height: 1.8; font-size: 13px; }
  section { background: white; border: 1px solid #dce3ec; border-radius: 10px; padding: 24px; margin: 20px 0; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { font-size: 15px; margin: 0; } .controls { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  .controls button { padding: 6px 10px; border: 1px solid #dce3ec; border-radius: 5px; background: white; cursor: pointer; }
  output { display: block; margin-top: 15px; font-size: 12px; color: #738095; }
  .fixture-titlebar { display: flex; align-items: center; gap: 14px; padding: 12px; margin-bottom: 20px; background: white; border: 1px solid #dce3ec; border-radius: 8px; }
  .fixture-host-pill { width: 28px; height: 28px; flex-shrink: 0; border-radius: 9999px; }
  .fixture-host-pill:hover { width: max-content; }
  .fixture-host-pill > button { display: flex; align-items: center; width: 100%; height: 100%; overflow: hidden; border: 0; border-radius: 9999px; background: #f2f5fa; color: #293546; cursor: pointer; }
  .fixture-host-pill .fixture-host-label { white-space: nowrap; opacity: 0; translate: 8px; flex-shrink: 0; margin-inline: 8px; font-size: 11px; }
  .fixture-host-pill:hover .fixture-host-label { opacity: 1; translate: none; }
  .fixture-host-icon { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; }
  @media(max-width: 500px) { body { padding: 20px 12px; } section { padding: 16px; } }
`
document.head.append(styles)

function Fixture() {
  const initial = [
    { id: "session-a", title: "API Integration and Setup", description: "Updated Nov 8, 2026, 4:30 PM" },
    { id: "session-b", title: "OpenCode Desktop Plugin Exploration", description: "Updated Nov 8, 2026, 3:10 PM" },
  ]
  const [favorites, setFavorites] = createSignal(initial)
  const [current, setCurrent] = createSignal(initial[0])
  const [compact, setCompact] = createSignal(false)
  const [opened, setOpened] = createSignal("none")
  const [openCount, setOpenCount] = createSignal(0)
  const [managerVisible, setManagerVisible] = createSignal(false)
  const [groupQuery, setGroupQuery] = createSignal("")
  const [folded, setFolded] = createSignal<string[]>([])

  const isFavorite = () => favorites().some((item) => item.id === current().id)

  function toggle() {
    const session = current()
    setFavorites((items) =>
      items.some((item) => item.id === session.id)
        ? items.filter((item) => item.id !== session.id)
        : [session, ...items],
    )
  }

  const groups = createMemo(() =>
    groupSessionsByProject(
      favorites().map((session) => ({
        ...session,
        serverID: "sidecar",
        directory: session.id === "session-a" ? "C:/projects/workspace" : "C:/projects/desktop-plugin",
      })),
      {
        sidecar: [
          { id: "workspace", canonical: "C:/projects/workspace", name: "workspace", sandboxes: [] },
          { id: "desktop", canonical: "C:/projects/desktop-plugin", name: "Desktop Plugin", sandboxes: [] },
        ],
      },
      "Unknown project",
      groupQuery(),
    ),
  )

  return (
    <main>
      <h1>OpenCode Desktop Manager · Component Test</h1>
      <p>Interactive fixture testing favorites, titlebar button, and collapsible project grouping.</p>

      <div class="fixture-titlebar">
        <span style={{ "font-size": "12px" }}>Titlebar Pill</span>
        <div data-slot="titlebar-update" class="fixture-host-pill">
          <button
            type="button"
            aria-label="opencode-desktop-manager: Open Session Manager"
            aria-pressed={managerVisible()}
            onClick={() => setManagerVisible((value) => !value)}
          >
            <span data-slot="titlebar-update-label" class="fixture-host-label">
              Session Manager
            </span>
            <span class="fixture-host-icon" aria-hidden="true">
              ☷
            </span>
          </button>
        </div>
      </div>
      <output id="fixture-titlebar-result">Manager Dialog State: {managerVisible() ? "Open" : "Closed"}</output>

      <section>
        <header>
          <h2>{current().title}</h2>
          <FavoriteButton
            favorite={isFavorite()}
            busy={false}
            compact={compact()}
            label={isFavorite() ? "Favorited" : "Favorite this session"}
            hint={isFavorite() ? "Unfavorite" : "Favorite this session"}
            onToggle={toggle}
          />
        </header>
        <div class="controls">
          <button onClick={() => setCurrent(initial[0])}>Switch to Session A</button>
          <button onClick={() => setCurrent(initial[1])}>Switch to Session B</button>
          <button onClick={() => setCompact((value) => !value)}>Toggle Compact Title</button>
        </div>
      </section>

      <section>
        <h2>Favorite Sessions</h2>
        <p>Click a session to switch; hover/focus reveals × to unfavorite without deletion.</p>
        <FavoriteList
          sessions={favorites()}
          openLabel={(title) => `Open session: ${title}`}
          removeLabel={(title) => `Unfavorite ${title} (does not delete the session)`}
          onOpen={(session) => {
            setOpened(session.id)
            setOpenCount((count) => count + 1)
            setCurrent(session)
          }}
          onRemove={(session) => setFavorites((items) => items.filter((item) => item.id !== session.id))}
        />
        <output id="fixture-result">
          Last Opened: {opened()} · Open Count: {openCount()} · Total Favorites: {favorites().length}
        </output>
      </section>

      <section id="fixture-project-groups">
        <h2>Collapsible Project Groups</h2>
        <p>Collapse and expand project sections without modifying saved favorites.</p>
        <input
          aria-label="Search sessions or projects"
          placeholder="Search sessions or projects"
          value={groupQuery()}
          onInput={(event) => {
            setGroupQuery(event.currentTarget.value)
            setFolded([])
          }}
        />
        <div class="controls">
          <button onClick={() => setFolded(groups().map((group) => group.key))}>Collapse All</button>
          <button onClick={() => setFolded([])}>Expand All</button>
        </div>
        <For each={groups()}>
          {(group) => (
            <ProjectGroupSection
              title={group.title}
              directory={group.directory}
              count={group.sessions.length}
              expanded={!folded().includes(group.key)}
              onToggle={() =>
                setFolded((keys) =>
                  keys.includes(group.key) ? keys.filter((key) => key !== group.key) : [...keys, group.key],
                )
              }
            >
              <FavoriteList
                sessions={group.sessions}
                openLabel={(title) => `Open session: ${title}`}
                removeLabel={(title) => `Unfavorite ${title} (does not delete the session)`}
                onOpen={(session) => {
                  setOpened(session.id)
                  setOpenCount((count) => count + 1)
                }}
                onRemove={(session) => setFavorites((items) => items.filter((item) => item.id !== session.id))}
              />
            </ProjectGroupSection>
          )}
        </For>
      </section>
    </main>
  )
}

render(() => <Fixture />, document.getElementById("root")!)
