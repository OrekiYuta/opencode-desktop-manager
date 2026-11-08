export interface ProjectInfo {
  id: string
  canonical: string
  name?: string
  sandboxes: readonly string[]
}

export interface ProjectSession {
  id: string
  title: string
  projectID?: string
  directory?: string
  serverID: string
}

export interface ProjectGroup<T> {
  key: string
  title: string
  directory: string
  sessions: T[]
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}

function contains(directory: string, root: string): boolean {
  const path = normalizePath(directory)
  const base = normalizePath(root)
  return path === base || path.startsWith(`${base}/`)
}

export function groupSessionsByProject<T extends ProjectSession>(
  sessions: readonly T[],
  projects: Readonly<Record<string, readonly ProjectInfo[]>>,
  unknownTitle: string,
  query = "",
): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>()
  const search = query.trim().toLocaleLowerCase()

  for (const session of sessions) {
    const candidates = (projects[session.serverID] ?? []).filter((project) => project.id !== "global")

    // Prefer the most specific matching root directory, including registered sandboxes/worktrees.
    const project = session.directory
      ? candidates
          .filter((item) => [item.canonical, ...item.sandboxes].some((root) => contains(session.directory!, root)))
          .sort((a, b) => b.canonical.length - a.canonical.length)[0]
      : candidates.find((item) => item.id === session.projectID)

    const directory = project?.canonical || session.directory || ""
    const title = project?.name || directory.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || unknownTitle
    const key = JSON.stringify([session.serverID, directory ? normalizePath(directory) : null])

    if (
      search &&
      ![session.id, session.title, title, directory].some((value) => value.toLocaleLowerCase().includes(search))
    ) {
      continue
    }

    let group = groups.get(key)
    if (!group) {
      group = { key, title, directory, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }

  return [...groups.values()]
}
