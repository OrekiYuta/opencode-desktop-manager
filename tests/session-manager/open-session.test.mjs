import { test } from "node:test"
import assert from "node:assert/strict"
import { openSession } from "../../src/session-manager/open-session.ts"

function fakeServer(id, { fail = false } = {}) {
  const calls = []
  return {
    id,
    calls,
    client: {
      session: {
        async get(input, options) {
          calls.push({ input, options })
          if (fail) throw new Error("not found")
          return { id: input.sessionID }
        },
      },
    },
  }
}

function harness({ builtin, servers = {}, signal } = {}) {
  const opened = []
  const errors = []
  return {
    opened,
    errors,
    deps: {
      signal: signal ?? new AbortController().signal,
      builtin,
      server: (id) => servers[id],
      open: (target) => opened.push(target),
      onError: () => errors.push("error"),
    },
  }
}

test("opens a session on the built-in server when no server is recorded", async () => {
  const builtin = fakeServer("sidecar")
  const h = harness({ builtin })

  assert.equal(await openSession({ id: "session-a" }, h.deps), true)
  assert.deepEqual(h.opened, [{ server: "sidecar", id: "session-a" }])
  assert.equal(builtin.calls.length, 1)
  assert.equal(builtin.calls[0].input.sessionID, "session-a")
  assert.deepEqual(h.errors, [])
})

test("opens a session on its recorded server", async () => {
  const builtin = fakeServer("sidecar")
  const remote = fakeServer("https://remote.example")
  const h = harness({ builtin, servers: { "https://remote.example": remote } })

  assert.equal(await openSession({ id: "session-b", server: "https://remote.example" }, h.deps), true)
  assert.deepEqual(h.opened, [{ server: "https://remote.example", id: "session-b" }])
  assert.equal(builtin.calls.length, 0)
})

test("reports an error and keeps the manager open when the server is unavailable", async () => {
  const h = harness({ builtin: undefined })

  assert.equal(await openSession({ id: "session-c", server: "https://gone.example" }, h.deps), false)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.errors, ["error"])
})

test("reports an error and does not route when the session no longer exists", async () => {
  const builtin = fakeServer("sidecar", { fail: true })
  const h = harness({ builtin })

  assert.equal(await openSession({ id: "deleted" }, h.deps), false)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.errors, ["error"])
})

test("does not route or report when the plugin was aborted during the check", async () => {
  const controller = new AbortController()
  const builtin = fakeServer("sidecar")
  const h = harness({ builtin, signal: controller.signal })
  builtin.client.session.get = async () => {
    controller.abort()
    return { id: "session-d" }
  }

  assert.equal(await openSession({ id: "session-d" }, h.deps), false)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.errors, [])
})
