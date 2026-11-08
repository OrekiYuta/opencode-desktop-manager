# opencode-desktop-manager

A session management and favorites plugin for **OpenCode Desktop V2**.

## Features

- **Session Header (☆ / ★):** Click **☆ Favorite this session** in the timeline header to save the session. The button toggles to **★ Favorited**; click again to unfavorite. Compact headers show only the star. Each session tracks its own state.
- **Titlebar Entry:** A persistent **Session Manager** button in the window titlebar opens the floating manager dialog directly, without navigating to Settings.
- **Collapsible Project Groups:** Favorites and recent sessions are grouped by their detected repository or workspace directory. Each group shows the project name, root directory, and session count.
  - Recent sessions start **collapsed** by default to reduce clutter.
  - Favorite sessions start **expanded** by default.
  - **Expand all projects** and **Collapse all projects** buttons allow fast bulk toggling.
- **Quick Search:** Live search filters by project name, directory path, session title, and session ID. Matching groups automatically expand. Clearing the search restores previous fold states.
- **Hover / Focus × to Unfavorite:** In the manager list, hover or keyboard focus reveals a `×` button that **only unfavorites the session—it never deletes actual chat history**.
- **Cross-Project Cleanup with Confirmation:** Bulk delete unpinned, non-archived root sessions and their child sessions across projects with safety confirmation. Favorites are strictly protected.
- **Seamless Migration:** Automatically imports past bookmarks and pins from legacy `opencode-ui-manager` stores if present.

## Installation

### Method 1: GitHub Package (Recommended)

Add the repository directly to your OpenCode configuration. In your global `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:OrekiYuta/opencode-desktop-manager"
  ]
}
```

Or install via OpenCode CLI:

```sh
opencode plugin add github:OrekiYuta/opencode-desktop-manager
```

### Method 2: Local Directory

Clone the repository and reference its local directory in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/opencode-desktop-manager"
  ]
}
```

## Development & Build

Requires Node.js (v20+) and an OpenCode Desktop release supporting the V2 GUI plugin API.

```sh
# Install dependencies
npm install

# Build CommonJS bundle for OpenCode Desktop
npm run build

# Watch mode for local development
npm run dev
```

### Run Tests

```sh
# Typecheck
npm run typecheck

# Unit tests
npm test

# Launch browser UI fixture
npm run test:ui
```

## License

[MIT](LICENSE) © 2026 OrekiYuta
