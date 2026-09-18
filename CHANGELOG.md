# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Willow attribution in the popup footer, the approval window titlebar, the extension description and the README.

### Removed
- Leftover Webrix wordmark logos (`FullLogoB.svg`, `FullLogoW.svg`), which nothing referenced.
- README documentation for the `npm run icons` / `npm run icons:png` scripts, which no longer exist.

## [1.2.0] - 2026-09-16

### Added
- **Redaction (data minimization).** New `lib/redactor.js` engine removes sensitive information from the page while a Claude agent is active. Text is rewritten in place and matching elements are removed from the DOM; new content is redacted live via `MutationObserver`.
  - **Built-in guards** (`lib/guards.js`): 10 guards / 95 regex checks ported from Willow's runtime redaction guards — `secrets`, `email`, `phone`, `ssn`, `credit-card` (Luhn-validated), `ip-address`, `financial`, `dob`, `government-id`, `address`. Each check keeps Willow's certainty score and replacement label (e.g. `[REDACTED-EMAIL]`). Guards and individual checks can be toggled; a global **minimum certainty** (default 6) filters weak checks.
  - **Custom rules**: `text`, `regex`, `selector` with optional per-rule URL `scope` and `replacement`.
  - Redacted `title`/`alt`/`aria-label`/`placeholder` attributes in addition to text nodes.
- Popup: **Redaction** toggle, **Guards** section (per-guard switch, expandable per-check list with certainty badges, min-certainty selector), **Custom Rules** editor with validation, `redacted` counter, and an `MDM` tag on managed rules/guards.
- Background: `redactList`, `guards`, `guardMinCertainty`, `redactEnabled`, `stats.redacted`; new `set-redact-enabled`, `set-guard`, `set-guard-check`, `set-guard-min-certainty` and `redact-event` messages; live re-broadcast when managed policy changes.
- Managed schema and MDM tooling support `redactList`, `guards` and `guardMinCertainty` (`generate-mobileconfig.sh --redact 'KIND:VALUE[|SCOPE]' --guard ID:on|off --disable-check GUARD:CHECK --min-certainty N`).
- Test suite (`node:test` + jsdom) covering the guard catalog, redactor, interceptor, background, content script, popup, manifest/packaging, and the MDM generator. `npm test`, `npm run lint`, and a GitHub Actions CI workflow.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE` (ISC, Willow), `.editorconfig`.

### Changed
- Removed the pinned `key` from `manifest.json`; the extension ID is now assigned by the Web Store or install path. Pass `--extension-id` to the MDM scripts.
- `remove-rule` now validates indexes and refuses to remove managed rules; `add-rule` rejects unknown lists and strips a client-supplied `managed` flag.
- `npm run build` now runs lint and tests before packaging; the zip includes `lib/`.
- README rewritten.

### Fixed
- URL glob matching did not escape `?`, so patterns containing a literal `?` (e.g. `…/items?id=*`) never matched.
- Older installs without the new state fields are migrated on read instead of producing `undefined` counters.

## [1.1.1] - 2026-07-10

### Changed
- Package `managed_schema.json` in the build zip.

## [1.1.0]

### Added
- MDM `.mobileconfig` tooling for enterprise allow/block policy.
- Org-managed allow/block lists via `chrome.storage.managed`.
- Activation across all tabs in the Claude agent tab group.

## [1.0.0]

### Added
- Initial release: request interception (`fetch`, XHR, forms, beacons), auto mode, allow/block lists, human approval window, popup, stats.
