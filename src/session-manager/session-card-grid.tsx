import { For, type JSX } from "solid-js"

/**
 * Two-column card grid shared by favorite and recent sessions, so both
 * sections keep the same responsive layout and action placement.
 */
export function SessionCardGrid<T>(props: {
  sessions: readonly T[]
  renderCard: (session: T) => JSX.Element
}) {
  return (
    <div class="odm-session-grid">
      <For each={props.sessions}>{(session) => props.renderCard(session)}</For>
    </div>
  )
}
