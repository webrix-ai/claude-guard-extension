# Contributing

Thanks for helping make Claude Guard better. This document covers the basics.

## Getting set up

```bash
git clone https://github.com/webrix-ai/claude-guard-extension.git
cd claude-guard-extension
npm install      # dev dependencies only (jsdom for tests)
npm test
```

Load the repository root as an unpacked extension from `chrome://extensions` to try changes in a real browser. Click **Reload** after editing.

## Ground rules

- **No runtime dependencies, no bundler.** The extension ships as plain JavaScript files referenced directly from `manifest.json`. Keep it that way.
- **`interceptor.js` stays self-contained.** It runs in the page's MAIN world and must not depend on globals that a page could redefine. Do not import shared helpers into it.
- **ES5-style syntax in extension code** (`var`, `function`) matches the existing files and avoids surprises in older Chromium builds. Tests may use modern syntax.
- **Never persist managed rules.** Anything from `chrome.storage.managed` is tagged `managed: true` and stripped in `setState()`. Preserve that invariant.
- **Keep the agent informed.** If you add a new kind of intervention, surface it on the page (banner/toast) so the agent understands why something happened.

## Making changes

1. Create a branch from `main`.
2. Add or update tests in `test/`. Every behavioural change should be covered; the suite runs the real shipped files inside jsdom / a VM sandbox.
3. Run `npm run lint && npm test`.
4. Update `CHANGELOG.md` under an *Unreleased* heading and, if user-facing, `README.md`.
5. Open a pull request with a short description of the problem and the approach.

## Releasing

1. Bump `version` in `package.json` (semver).
2. `npm run build` — runs lint + tests, syncs the manifest version, and writes `dist/claude-guard-v<version>.zip`.
3. Move the *Unreleased* section of `CHANGELOG.md` under the new version and date.
4. Tag the commit `v<version>` and attach the zip to the GitHub release.

## Reporting security issues

Please do not open public issues for security-sensitive reports. Contact the maintainers directly.
