export interface SessionTarget {
  id: string
  // Legacy favorites saved without a server field belong to the built-in server.
  server?: string
}

export interface SessionServer {
  readonly id: string
  readonly client: {
    session: {
      get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<unknown>
    }
  }
}

export interface SessionOpenDeps {
  readonly signal: AbortSignal
  readonly builtin: SessionServer | undefined
  server(id: string): SessionServer | undefined
  open(target: { server: string; id: string }): void
  onError(): void
}

/**
 * Verifies that the session still exists, then routes the app to it.
 * Returns true only when the open request was issued, so callers can close
 * the manager without hiding a failed attempt.
 */
export async function openSession(target: SessionTarget, deps: SessionOpenDeps): Promise<boolean> {
  const server = target.server === undefined ? deps.builtin : deps.server(target.server)
  try {
    if (!server) throw new Error("Session server is unavailable")
    await server.client.session.get({ sessionID: target.id }, { signal: deps.signal })
    if (deps.signal.aborted) return false
    deps.open({ server: server.id, id: target.id })
    return true
  } catch {
    if (!deps.signal.aborted) deps.onError()
    return false
  }
}
