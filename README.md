<p align="center">
  <img src="icons/icon128-active.png" width="96" height="96" alt="Claude Guard">
</p>

<h1 align="center">Claude Guard</h1>

<p align="center">
  A request guardian and data minimizer for <a href="https://www.anthropic.com/claude">Claude</a> browser agents.<br>
  Blocks risky requests behind human approval and <strong>removes sensitive information from the page</strong> before the agent can read it.
</p>

<p align="center">
  <a href="https://github.com/webrix-ai/claude-guard-extension/actions/workflows/ci.yml"><img src="https://github.com/webrix-ai/claude-guard-extension/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/runtime%20deps-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/license-ISC-lightgrey" alt="ISC License">
</p>

---

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Request rules](#request-rules)
  - [Redaction rules](#redaction-rules)
  - [The approval window](#the-approval-window)
- [Enterprise / MDM deployment](#enterprise--mdm-deployment)
- [Development](#development)
- [Architecture](#architecture)
- [Security model & limitations](#security-model--limitations)
- [Contributing](#contributing)
- [License](#license)

## Why

Browser agents are powerful because they can see everything on a page and click anything on it. That is also the problem. Claude Guard sits between the agent and the browser and enforces two principles:

1. **Least action** – state-changing requests (POST/PUT/PATCH/DELETE, authenticated calls, form submits) are held until a human approves them.
2. **Least information** – emails, card numbers, tokens, account balances, or anything else you define is *removed from the DOM* while the agent is active, so it never enters the model's context.

Everything is local. No data leaves the browser, and the extension has no network access of its own.

## How it works

Claude Guard activates only when it detects a live Claude agent on a page (the `claude-agent-glow-border` element Claude renders) — and on every other tab in that agent's tab group. Until then it is completely inert.

```
                     ┌──────────────────────────────────────────────────┐
  page (MAIN world)  │ interceptor.js   patches fetch / XHR / forms /    │
                     │                  sendBeacon; asks before sending │
                     └───────────────▲──────────────────────────────────┘
                                     │ postMessage
  isolated world     ┌───────────────┴──────────────────────────────────┐
                     │ content.js     detects agent, shows banner/toasts │
                     │ lib/redactor.js rewrites text nodes, removes      │
                     │                 elements, watches for new content │
                     └───────────────▲──────────────────────────────────┘
                                     │ chrome.runtime messages
  service worker     ┌───────────────┴──────────────────────────────────┐
                     │ background.js  rules & stats (storage.local),     │
                     │                policy (storage.managed),          │
                     │                approval window lifecycle          │
                     └──────────────────────────────────────────────────┘
```

When a request is held, the page gets a prominent banner and toast that the agent can read ("waiting for human approval – do NOT proceed"), and a small approval window opens for you. Denied requests receive a synthetic `403` JSON body telling the agent not to retry.

## Features

| | |
|---|---|
| **Auto mode** | Holds non-GET same-site requests and any request carrying an `Authorization` header |
| **Allow / block lists** | URL globs (`*://api.example.com/*`) with optional HTTP method |
| **Redaction guards** | 10 built-in guards / 95 checks ported from [Willow](https://willow.security)'s runtime redaction guards (secrets, PII, financial data…), each guard and each check individually toggleable, with a tunable certainty threshold |
| **Custom redaction rules** | Literal text, regular expressions, or CSS selectors — optionally scoped to specific URLs |
| **Live redaction** | New content (XHR-loaded tables, chat messages, modals) is redacted as it appears via `MutationObserver` |
| **Human approval window** | Allow once, always allow (by host), or deny — with headers and body preview |
| **Agent-visible feedback** | Banner, title change and toasts so the agent knows what happened and why |
| **Enterprise policy** | Push allow/block/redact rules via Chrome managed storage (MDM); managed rules are read-only in the UI |
| **Stats & log** | Blocked / allowed / redacted counters and a capped request log |
| **Zero dependencies** | Plain JavaScript, no bundler, no runtime packages |

## Installation

### From source (developer mode)

```bash
git clone https://github.com/webrix-ai/claude-guard-extension.git
cd claude-guard-extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the repository root (the folder containing `manifest.json`).

No build step is required.

### From a release zip

Download `claude-guard-v*.zip` from the releases page, unzip it, and load the folder as an unpacked extension as above.

## Usage

Click the toolbar icon to open the popup. The status badge shows whether the current tab is being guarded.

### Request rules

- **Auto mode** (default on) — hold state-changing same-site requests and authenticated requests.
- **Allow list** — always let matching requests through. Checked first.
- **Block list** — always hold matching requests for approval, even GETs. Checked second. Navigating to a blocked URL replaces the page with a block notice.

A rule is a URL glob plus a method (`*` for any). `*` matches any run of characters; everything else is literal.

```
*://api.github.com/*            any method
*://api.example.com/v1/*  POST  only POSTs
```

### Redaction

Redaction runs while the agent is active and **modifies the DOM in place**: matching text is replaced with a label such as `[REDACTED-EMAIL]` and elements matched by a selector are removed. Because the information is gone from the document rather than hidden with CSS, it does not appear in `innerText`, the accessibility tree, or screenshots.

Use the **Redaction** toggle to turn the feature on or off globally. Two sources feed it:

#### Built-in guards

The **Guards** section lists ten guards ported from Willow's runtime redaction guards. Each guard groups regex checks; each check carries a **certainty** (1–10) and its own replacement label.

| Guard | Default | Examples of checks |
|---|---|---|
| `secrets` | on | Stripe/GitHub/GitLab/AWS/Google/OpenAI/Anthropic keys, Slack & Discord tokens/webhooks, private-key headers, JWTs, DB connection strings, `password=` assignments… (56 checks) |
| `ssn` | on | Labelled and bare US SSNs |
| `credit-card` | on | Visa, Mastercard, Amex, Discover, JCB, UnionPay — Luhn-validated (extension addition) |
| `financial` | on | IBAN, labelled routing/account numbers, SWIFT/BIC |
| `government-id` | on | Passport, driver licence, UK NIN, Canadian SIN |
| `email` | off | Email addresses, `mailto:` links |
| `phone` | off | US, UK and international formats |
| `ip-address` | off | IPv4, IPv6, CIDR, MAC |
| `dob` | off | Labelled dates of birth |
| `address` | off | Street addresses, PO boxes, city/state/ZIP, UK postcodes, GPS coordinates |

Configuration, all from the popup:

- **Toggle a guard** with its switch.
- **Expand a guard** to see its checks with their certainty; untick a check to skip it (e.g. keep `phone` on but drop the low-certainty bare `US Phone Number` pattern).
- **Min. certainty** (default 6) — checks rated below it are ignored everywhere. Lower it to catch more, raise it to reduce false positives.

The noisier guards (email, phone, IP, DOB, address) are off by default because they tend to interfere with legitimate agent tasks; turn them on per your threat model. Check ids follow Willow's `regex-<slug>` convention (`regex-us-phone-number`) and are stable for use in policy.

#### Custom rules

The **Custom Rules** list adds your own patterns:

| Kind | Value | Example |
|---|---|---|
| `text` | Literal text, case-insensitive | `Jane Doe` |
| `regex` | A JavaScript regular expression (the `g` flag is always added) | `ACME-\d{6}` |
| `selector` | A CSS selector; matching elements are removed | `.account-balance, [data-testid="ssn"]` |

Every custom rule accepts an optional **scope** — a URL glob limiting where it applies (e.g. `*://bank.example.com/*`). Without a scope the rule applies everywhere. Custom text rules replace matches with `[REDACTED]` unless a `replacement` is set (policy only).

#### Behaviour

Text redaction covers text nodes plus the `title`, `alt`, `aria-label` and `placeholder` attributes. `<script>`, `<style>`, `<template>` and Claude Guard's own overlays are never touched. Guards run before custom rules, in catalog order.

When content is redacted, a toast tells the agent how many items were removed, and the **redacted** counter in the popup increments. Redaction is one-way: leaving the agent session does not restore the content — reload the page instead.

### The approval window

Held requests appear in a small always-on-top window with method, URL, reason, and (expandable) headers/body.

- **Deny** — the agent receives a `403` with `{"error":"BLOCKED_BY_CLAUDE_GUARD"}`.
- **Allow once** — the original request is sent.
- **Always allow** — adds `*://<host>/*` to the allow list, then sends.

Closing the window, or waiting 120 s, denies everything pending.

## Enterprise / MDM deployment

Administrators can enforce rules centrally through **Chrome managed storage**. Managed rules are merged ahead of the user's own rules, tagged `MDM` in the popup, and cannot be edited or removed there. Changes to policy are picked up live and re-broadcast to all guarded tabs.

```
MDM (.mobileconfig)  →  com.google.Chrome.extensions.<extension-id>
                              ↓ validated against managed_schema.json
                        chrome.storage.managed  →  background.js
```

The policy shape is declared in [`managed_schema.json`](managed_schema.json): `allowList`, `blockList`, `redactList`, `guards` (per-guard `enabled` / `disabledChecks`) and `guardMinCertainty`. Managed guard settings override the user's and are locked in the popup.

### Find your extension ID

The manifest no longer pins a `key`, so the ID depends on how the extension was installed (Web Store ID, or a path-derived ID for unpacked loads). Copy it from `chrome://extensions` and pass it with `--extension-id`.

### Generate a configuration profile

```bash
./generate-mobileconfig.sh \
  --extension-id <your-extension-id> \
  --allow  '*://api.github.com/*' \
  --allow  '*://api.example.com/*|POST' \
  --block  '*://evil.example.com/*' \
  --guard  'email:on' \
  --guard  'phone:on' \
  --disable-check 'phone:regex-us-phone-number' \
  --min-certainty 7 \
  --redact 'selector:.account-balance|*://bank.example.com/*' \
  --redact 'regex:ACME-\d{6}'
```

Allow/block rules are `PATTERN` or `PATTERN|METHOD`. Redact rules are `KIND:VALUE` or `KIND:VALUE|SCOPE` with `KIND` = `text` | `regex` | `selector`. Guards are forced with `--guard ID:on|off`, individual checks dropped with `--disable-check GUARD:CHECK`, and the certainty floor pinned with `--min-certainty N`. Upload the resulting `claude-guard.mobileconfig` to your MDM.

### Test locally

Apply a profile to your own Mac to simulate MDM (writes to `/Library/Managed Preferences/`, needs `sudo`):

```bash
sudo ./install-mobileconfig.sh claude-guard.mobileconfig
# or generate + install in one step
sudo ./generate-mobileconfig.sh --extension-id <id> --guard email:on --install
# remove again
sudo ./install-mobileconfig.sh --uninstall <id>
```

Then fully quit and reopen Chrome, visit `chrome://policy` → **Reload policies**, and confirm the rules under the extension ID. In the service-worker console: `chrome.storage.managed.get(null).then(console.log)`.

If Chrome keeps showing stale values: quit Chrome, run `killall cfprefsd && sudo killall cfprefsd`, and reopen.

## Development

Requirements: Node.js ≥ 20 (for the test runner only — the extension itself has no dependencies).

```bash
npm install          # installs jsdom (dev-only)
npm test             # unit + integration tests (node:test + jsdom)
npm run test:watch   # re-run on change
npm run lint         # syntax-check all shipped JS and JSON
npm run build        # lint + test + pack dist/claude-guard-v<version>.zip
```

Edit files, then click **Reload** on `chrome://extensions` to pick up changes.

### Tests

The suite runs in Node with no browser required:

| File | What it covers |
|---|---|
| `test/guards.test.js` | Willow guard catalog integrity, sample matches per guard, enable/disable/min-certainty resolution, Luhn |
| `test/redactor.test.js` | Custom text/regex/selector rules, scoping, DOM rewriting, live `MutationObserver` behaviour |
| `test/interceptor.test.js` | `fetch`/XHR/form/beacon interception, verdict precedence, deny responses, glob matching, blocked navigation |
| `test/background.test.js` | State defaults & migration, managed-rule merging, add/remove rules, stats/log, agent tab groups, approval window lifecycle |
| `test/content.test.js` | Agent detection, activation → redaction, live toggles, banner/toast bridge |
| `test/popup.test.js` | Popup rendering, guard toggles/expansion, custom-rule form validation, message wiring |
| `test/manifest.test.js` | Manifest integrity, schema shape, packaging completeness |
| `test/mobileconfig.test.js` | `.mobileconfig` generation, escaping, argument validation |

`interceptor.js` and `background.js` are executed as-is inside jsdom / a VM sandbox with a small `chrome.*` mock (`test/helpers/`), so tests exercise the real shipped code.

### Scripts

| Command | Description |
|---|---|
| `npm run icons` | Regenerate SVG icons |
| `npm run icons:png` | Rasterize PNG icons (inactive + active) |
| `npm run version-sync` | Copy `package.json` version into `manifest.json` |
| `npm run pack:zip` | Build the distributable zip without running checks |

## Architecture

```
├── manifest.json            MV3 manifest
├── background.js            Service worker: state, rules, policy, approval window
├── content.js               Isolated world: agent detection, overlays, redaction wiring
├── interceptor.js           MAIN world: fetch/XHR/form/beacon patching (self-contained)
├── lib/
│   ├── guards.js            Built-in guard catalog (ported from Willow; UMD)
│   └── redactor.js          Redaction engine (UMD; shared by content script, popup, tests)
├── popup.html/js/css        Toolbar popup
├── approve.html/js/css      Approval window
├── managed_schema.json      Managed-storage policy schema
├── generate-mobileconfig.sh Build/apply an MDM profile
├── install-mobileconfig.sh  Apply a profile locally
├── scripts/                 Icon generation, version sync, packaging, syntax check
└── test/                    node:test suite + helpers
```

`interceptor.js` deliberately shares no code with the isolated world: it runs in the page's JavaScript context and captures the native APIs it needs at `document_start`, before any page script can tamper with them.

## Security model & limitations

- **Scope of interception.** `fetch`, `XMLHttpRequest`, `HTMLFormElement.submit/requestSubmit`, `submit` events and `navigator.sendBeacon` are covered. WebSockets, `<a>` navigations, `<img>`/`<iframe>` loads, service-worker requests and requests from other frames are not.
- **Activation latency.** Agent detection polls every 2 s. Content that is on-screen before the agent is detected is redacted at activation; content the agent reads in that window is not.
- **Top frame only.** Redaction and interception run in the top-level document. Cross-origin iframes are not processed.
- **Form controls.** Text typed into `<input>`/`<textarea>` values is not redacted (only their `placeholder`). Shadow DOM subtrees are not traversed.
- **Guards are regex heuristics.** They are the regex subset of Willow's guards — the LLM- and model-backed checks cannot run inside an extension. Lower-certainty checks (`phone`, `address`, generic secret assignments) may over-match; tune **Min. certainty**, untick specific checks, or prefer scoped `selector` rules on pages you control.
- **Not a sandbox.** A hostile page can still exfiltrate data through channels outside the patched APIs. Claude Guard reduces accidental over-sharing by a cooperative agent; it is not a substitute for network-level controls.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

[ISC](LICENSE)
