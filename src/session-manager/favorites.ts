export interface Favorite {
  id: string
  title: string
  // Legacy pin entries saved without a server field belong to the built-in server.
  server?: string
  projectID?: string
  directory?: string
}

export function belongsToServer(favorite: Favorite, server: string, builtin: boolean): boolean {
  return favorite.server === undefined ? builtin : favorite.server === server
}

export function findFavorite(favorites: readonly Favorite[], id: string, server: string, builtin: boolean): number {
  return favorites.findIndex((favorite) => favorite.id === id && belongsToServer(favorite, server, builtin))
}
