import { For, Show } from "solid-js"

export function FavoriteButton(props: {
  favorite: boolean
  busy: boolean
  compact: boolean
  label: string
  hint: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      class="odm-favorite-button"
      classList={{ "odm-favorite-button--saved": props.favorite }}
      aria-pressed={props.favorite}
      aria-label={props.hint}
      title={props.hint}
      disabled={props.busy}
      onClick={props.onToggle}
    >
      <span aria-hidden="true">{props.favorite ? "★" : "☆"}</span>
      <Show when={!props.compact}>
        <span>{props.label}</span>
      </Show>
    </button>
  )
}

export interface FavoriteRowInfo {
  id: string
  title: string
  server?: string
  description: string
}

export function FavoriteList(props: {
  sessions: readonly FavoriteRowInfo[]
  openLabel: (title: string) => string
  removeLabel: (title: string) => string
  onOpen: (session: FavoriteRowInfo) => void
  onRemove: (session: FavoriteRowInfo) => void
}) {
  return (
    <ul class="odm-favorites">
      <For each={props.sessions}>
        {(session) => (
          <li class="odm-favorite-row">
            <button
              type="button"
              class="odm-favorite-open"
              aria-label={props.openLabel(session.title)}
              title={session.title}
              onClick={() => props.onOpen(session)}
            >
              <span class="odm-favorite-star" aria-hidden="true">★</span>
              <span class="odm-favorite-copy">
                <span class="odm-favorite-title">{session.title}</span>
                <span class="odm-favorite-description">{session.description}</span>
              </span>
            </button>
            <button
              type="button"
              class="odm-favorite-remove"
              aria-label={props.removeLabel(session.title)}
              title={props.removeLabel(session.title)}
              onClick={(event) => {
                event.stopPropagation()
                props.onRemove(session)
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}
