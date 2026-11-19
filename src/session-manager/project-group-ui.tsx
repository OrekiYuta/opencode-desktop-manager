import { Show, createUniqueId, type JSX } from "solid-js"

export function ProjectGroupSection(props: {
  title: string
  directory: string
  count: number
  expanded: boolean
  onToggle: () => void
  children: JSX.Element
}) {
  const contentID = `odm-project-${createUniqueId()}`

  return (
    <section class="odm-project-group">
      <button
        type="button"
        class="odm-project-toggle"
        aria-expanded={props.expanded}
        aria-controls={contentID}
        onClick={props.onToggle}
        title={props.directory || props.title}
      >
        <span class="odm-project-chevron" aria-hidden="true">
          {props.expanded ? "▾" : "▸"}
        </span>
        <span class="odm-project-copy">
          <span class="odm-project-title">{props.title}</span>
          <Show when={props.directory}>
            <span class="odm-project-directory">{props.directory}</span>
          </Show>
        </span>
        <span class="odm-project-count">{props.count}</span>
      </button>
      <div id={contentID} hidden={!props.expanded} class="odm-project-content">
        {props.children}
      </div>
    </section>
  )
}
