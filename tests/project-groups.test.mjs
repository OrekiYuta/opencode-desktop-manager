import { test } from "node:test"
import assert from "node:assert/strict"
import { groupSessionsByProject } from "../src/project-groups.ts"

const projects = {
  sidecar: [
    { id: "app", canonical: "C:/work/app", name: "My app", sandboxes: ["C:/trees/app-feature"] },
    { id: "nested", canonical: "C:/work/app/packages/nested", sandboxes: [] },
    { id: "other", canonical: "C:/other/app", sandboxes: [] },
    { id: "global", canonical: "/", sandboxes: [] },
  ],
}

const row = (id, directory, extra = {}) => ({
  id,
  title: id,
  directory,
  serverID: "sidecar",
  ...extra,
})

const group = (sessions, query) => groupSessionsByProject(sessions, projects, "Unknown project", query)

test("project subdirectories and worktrees group under their named project", () => {
  const groups = group([row("a", "C:/work/app/src"), row("b", "C:/trees/app-feature/src")])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, "My app")
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["a", "b"])
})

test("nested repositories use the most specific project", () => {
  assert.equal(group([row("a", "C:/work/app/packages/nested/src")])[0].directory, "C:/work/app/packages/nested")
})

test("same-named directories and different servers remain separate", () => {
  assert.equal(
    group([row("a", "C:/work/app"), row("b", "C:/other/app"), row("c", "C:/work/app", { serverID: "remote" })]).length,
    3,
  )
})

test("Windows paths are case insensitive and slash insensitive", () => {
  assert.equal(group([row("a", "c:\\WORK\\APP\\"), row("b", "C:/work/app/")]).length, 1)
})

test("non-git directories sharing global ID are not merged", () => {
  assert.equal(
    group([row("a", "/notes/a", { projectID: "global" }), row("b", "/notes/b", { projectID: "global" })]).length,
    2,
  )
})

test("unknown legacy favorites remain in a removable group", () => {
  const groups = group([row("a", undefined)])
  assert.equal(groups[0].title, "Unknown project")
  assert.equal(groups[0].sessions[0].id, "a")
})

test("search matches project name, directory, session title or ID", () => {
  const sessions = [
    row("a", "C:/work/app", { title: "Favorite topic" }),
    row("b", "C:/work/app"),
    row("c", "C:/other/app"),
  ]
  assert.equal(group(sessions, "my app")[0].sessions.length, 2)
  assert.equal(group(sessions, "favorite")[0].sessions.length, 1)
  assert.equal(group(sessions, "C:/other")[0].sessions[0].id, "c")
  assert.equal(group(sessions, "not present").length, 0)
})

test("unrelated path prefixes do not count as project subdirectories", () => {
  assert.equal(group([row("a", "C:/work/app-extra")])[0].directory, "C:/work/app-extra")
})
