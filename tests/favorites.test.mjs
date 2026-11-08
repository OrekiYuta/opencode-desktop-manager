import { test } from "node:test"
import assert from "node:assert/strict"
import { belongsToServer, findFavorite } from "../src/favorites.ts"

const favorites = [
  { id: "old-session", title: "Existing pin" },
  { id: "shared-id", title: "Local favorite" },
  { id: "shared-id", title: "Remote favorite", server: "https://remote.example" },
]

test("old pins remain favorites on the built-in server", () => {
  assert.equal(findFavorite(favorites, "old-session", "sidecar", true), 0)
  assert.equal(belongsToServer(favorites[0], "sidecar", true), true)
})

test("old pins do not favorite the same ID on a remote server", () => {
  assert.equal(findFavorite(favorites, "old-session", "https://remote.example", false), -1)
})

test("same session ID on different servers has separate favorite state", () => {
  assert.equal(findFavorite(favorites, "shared-id", "sidecar", true), 1)
  assert.equal(findFavorite(favorites, "shared-id", "https://remote.example", false), 2)
  assert.equal(findFavorite(favorites, "shared-id", "https://other.example", false), -1)
})

test("clearing the built-in service only protects its own favorite IDs", () => {
  const keep = favorites.filter((item) => belongsToServer(item, "sidecar", true)).map((item) => item.id)
  assert.deepEqual(keep, ["old-session", "shared-id"])
})
