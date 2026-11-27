# Agent Guide

Instructions for agents working on this repository. Follow them for every feature or fix.

## Development Workflow

### 1. Preview from the local checkout

Before changing code, point the plugin entry in your global OpenCode config
(`~/.config/opencode/opencode.jsonc`) at this repository's local directory instead of
the GitHub package. This makes every rebuild show up in the desktop app without a
release, which is required for previewing GUI changes.

```jsonc
{
  "plugins": [
    {
      "package": "<path-to-local-checkout>",
      "options": {
        "timeoutMs": 40000,
        "route": "conversation"
      }
    }
  ]
}
```

Use a relative or placeholder path in documentation and commits. Never commit a
machine-specific absolute path, and never add credentials to the config or to
`.git/config` remote URLs.

Restart OpenCode after switching the plugin source so the new bundle is loaded.

### 2. Implement and verify

- Read the surrounding code and follow its existing structure, naming, and style.
- Keep GUI styles scoped to plugin-contributed UI.
- Rebuild before previewing: `npm run compile`.
- For visual checks, start the component fixture with `npm run test:ui` and inspect it
  in a browser. Verify both wide and narrow layouts when changing responsive styles.
- Before committing, all of these must pass:
  - `npm run typecheck`
  - `npm test`
  - `npm run compile`

`dist/` is tracked, so always commit the rebuilt bundles together with the source.

### 3. Commit and push

Use Conventional Commits, matching the existing history:

```
feat(session-manager): add session cards and open actions
fix(gui): add padding-top to toolbar row to prevent top border clipping
style(session-manager): clarify project and session hierarchy
```

- Format: `type(scope): summary`.
- Common types: `feat`, `fix`, `style`, `refactor`, `docs`, `test`, `chore`.
- Use the affected area as the scope, for example `session-manager`, `gui`,
  `right-phrase`, or `copilot-usage`.
- Write the summary in the imperative mood, lowercase, with no trailing period.
- Keep the subject short; put details in the body when needed.
- Stage only the files that belong to the change.
- Push to `origin/main` with the repository's existing credentials. Do not rewrite
  the remote URL to embed a token.

### 4. Finish the release

Pushing is not the end of the task. After the push succeeds:

1. Restore the plugin entry in `~/.config/opencode/opencode.jsonc` to the published
   package: `github:OrekiYuta/opencode-desktop-manager`.
2. Refresh the installed plugin:

   ```sh
   opencode plugin update github:OrekiYuta/opencode-desktop-manager
   ```

3. Confirm the working tree is clean and the local config no longer points at a
   development path.

Only then is the feature complete. If the push fails, stop and report it instead of
restoring the config, so the local preview keeps working.
