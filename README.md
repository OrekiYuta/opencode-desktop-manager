# opencode-desktop-manager

A session management, favorites, and Copilot Fusion router plugin for **OpenCode V2**.

## Features

- **GitHub Copilot Fusion Support (Server Plugin):**
  - Registers the `github-copilot/fusion` model with variants (`#standard`, `#high`, `#max`).
  - Seamlessly routes conversation turns via GitHub Copilot's `/auto` routing endpoint using your existing Copilot OAuth connection.
  - Automatically manages sticky sessions, anchor model degradation, and session token caching.
- **GitHub Copilot Usage (Desktop + Server Plugin):**
  - Opens an account-wide usage dialog from the titlebar next to Session Manager or from the command palette.
  - Shows the GitHub username when available, Copilot plan, AI credits, reset and snapshot times, and a manual refresh button. Values that cannot be verified are shown as unavailable.
  - Uses the active OpenCode GitHub Copilot OAuth connection on the server. It queries GitHub's internal `copilot_internal/user` endpoint and the authenticated GitHub user endpoint; no model request is made. Credentials and raw responses are never sent to the GUI.
  - GitHub's internal endpoint is undocumented and may change; its credit fields have not been verified for every Copilot plan. Data may be delayed or temporarily unavailable. The dialog labels stale data and authorization or network failures.
- **Model Tester (GUI Plugin):**
  - Instant latency and functional testing for all enabled models directly inside OpenCode's Model Settings dialog.
  - Visual badges with latency metrics, status tooltips, and re-test capabilities.
- **Session Manager (GUI Plugin):**
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
    {
      "package": "github:OrekiYuta/opencode-desktop-manager",
      "options": {
        "timeoutMs": 40000,
        "route": "conversation"
      }
    }
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

## View Copilot Usage

1. Connect GitHub Copilot in OpenCode and make the intended connection active.
2. In OpenCode Desktop, click **GitHub Copilot Usage** beside **Session Manager**, or search for **Open GitHub Copilot Usage** in the command palette.
3. The dialog checks for updated data every five minutes while open and offers **Refresh**. Successful responses are cached for 60 seconds; requests are limited to one every 15 seconds per active connection, with longer backoff when GitHub requests it. A snapshot older than one hour, or retained after an unsuccessful refresh, is marked stale.

The GitHub username is fetched separately and may be unavailable even when usage is available. Credit values and percentages are shown only when the response establishes a token-billed, finite quota. Unlimited, non-token-billed, missing or unrecognized fields are not treated as AI credits. Dates are displayed in the local time zone.

The GUI plugin API is experimental; button placement and compatibility depend on the Desktop release. Usage is for the active account, not the current conversation. The endpoint and field meanings are based on observed responses and may differ by plan; they are not a stable GitHub public API.

## Development & Build

Requires Node.js (v20+) and an OpenCode Desktop release supporting the V2 GUI plugin API.

```sh
# Install dependencies
npm install

# Build CommonJS bundle for OpenCode Desktop
npm run compile

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

Open `http://127.0.0.1:5188/tests/model-availability-tester/model-tester.html` and click **Run regression checks**
to verify the model tester against the OpenCode 2.3 dialog/settings DOM structure.
The fixture uses a mock model service and covers centered/responsive sizing, scoped
badges and controls, search updates, cancellation, and plugin cleanup.

## License

[MIT](LICENSE) © 2026 OrekiYuta
