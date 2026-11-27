import { Show } from "solid-js"

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
