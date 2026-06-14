# Claude Guard

A lightweight Chrome extension that acts as an HTTP request guardian while a Claude browser agent is active. It monitors, blocks, pauses, and gates outgoing requests behind human approval — so risky automated actions are visible and controlled.

## How It Works

When Claude Guard detects an active Claude agent on a page (via the `claude-agent-glow-border` DOM element), it intercepts outgoing HTTP requests and applies configurable rules:

- **Auto-mode** blocks non-GET/HEAD/OPTIONS requests to same-site URLs or requests carrying `Authorization` headers unless explicitly allowed.
- Blocked requests are routed to a **human approval popup** where you can allow once, always allow (by hostname), or deny.
- Denied requests receive a synthetic 403 response so the agent can handle the rejection gracefully.

Intercepted APIs include `fetch`, `XMLHttpRequest`, `HTMLFormElement.submit`/`requestSubmit`, and `navigator.sendBeacon`.

## Features

- **Auto-blocking** of sensitive mutations (POST/PUT/DELETE/PATCH) and authenticated requests
- **Allow / block lists** with glob pattern support
- **Human approval window** for pending requests with headers/body preview
- **Toolbar popup** for toggling auto mode, managing rules, and viewing stats
- **Visual indicators** — tab badge, banner, toasts, and title updates when the guard is active
- **Request logging** with capped history

## Installation

### From source (developer mode)

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd claude-browser-extension
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project root directory (where `manifest.json` lives).

No build step or `npm install` is required for local development.

### From release zip

1. Download the latest `claude-guard-v*.zip` from releases.
2. Unzip and load the folder as an unpacked extension (same steps as above).

## Enterprise / MDM deployment

Admins can centrally enforce allow/block rules via **Chrome managed storage**. Rules pushed this way are merged ahead of the user's local rules, marked as managed, and cannot be edited or removed from the popup (they show an `MDM` tag).

### How it works

```
MDM (.mobileconfig)  →  com.google.Chrome policy domain
                        (3rdparty → extensions → <extension-id>)
                              ↓ validated against managed_schema.json
                        chrome.storage.managed  →  getManagedRules() in background.js
```

- `managed_schema.json` declares the policy shape (`allowList`, `blockList`), and is registered via `storage.managed_schema` in the manifest. Chrome rejects any values that don't match it.
- The extension ID is **pinned** by the `key` field in `manifest.json`, so it stays constant (`aongnlgcifimejnamjbadgegloaojckm`) across machines and packed/unpacked loads.
- On boot (`onStartup`) and install, the service worker loads managed rules; it also listens for `chrome.storage.onChanged` in the `managed` area to pick up live policy pushes.

> **Note:** The `key` field is a temporary measure to keep a stable ID during development and self-hosted testing. Once Claude Guard is published to the **Chrome Web Store**, we'll remove the `key` and switch to the permanent store-assigned static ID (the way `mcp-s-extension` / Willow Guard does), updating the hardcoded ID in `generate-mobileconfig.sh`, `install-mobileconfig.sh`, and this README accordingly.

### Generating a configuration profile

`generate-mobileconfig.sh` builds a `.mobileconfig` (or applies it directly). A rule is `PATTERN` or `PATTERN|METHOD` (method defaults to `*`):

```bash
# Generate claude-guard.mobileconfig for MDM upload:
./generate-mobileconfig.sh \
  --allow '*://api.github.com/*' \
  --allow '*://api.example.com/*|POST' \
  --block '*://evil.example.com/*'
```

Upload the resulting file to your MDM to push policy to managed Chrome browsers. Use `--extension-id ID` only if loading the extension with a different key.

### Local testing

Apply a profile to your own Mac to simulate MDM (writes to `/Library/Managed Preferences/com.google.Chrome.plist`, requires sudo):

```bash
# Install a generated profile:
sudo ./install-mobileconfig.sh claude-guard.mobileconfig

# Or generate + install in one step:
sudo ./generate-mobileconfig.sh --allow '*://api.github.com/*' --install

# Remove the policy again:
sudo ./install-mobileconfig.sh --uninstall aongnlgcifimejnamjbadgegloaojckm
```

Then verify:

1. **Fully quit and reopen Chrome** (Cmd-Q) — policy is only read at launch.
2. Open `chrome://policy` → **Reload policies**; confirm the extension ID and its rules appear.
3. In the extension's service worker console: `chrome.storage.managed.get(null).then(console.log)`.

If you update `claude-guard.mobileconfig` and Chrome still shows old managed values, reset macOS preference caches and reload policy:

```bash
# quit Chrome first
osascript -e 'tell application "Google Chrome" to quit'

# restart preferences daemons (user + system)
killall cfprefsd
sudo killall cfprefsd

# optional: clear Chrome profile policy cache (while Chrome is closed)
rm -rf "$HOME/Library/Application Support/Google/Chrome/Profile 3/Policy"

# reopen Chrome and reload policy
open -a "Google Chrome"
```

> If you self-host a `.crx`, Chrome generates a private signing key (`*.pem`) the first time you pack it. That key determines the extension ID and is gitignored — keep it safe, since the same key is required to publish updates that preserve the ID. (Publishing via the Chrome Web Store instead, the store manages signing for you.)

## Development

The extension is plain JavaScript with no bundler or framework — edit files and reload the extension in `chrome://extensions` to see changes.

### Available scripts

| Script | Command | Description |
|--------|---------|-------------|
| **Icons** | `npm run icons` | Generate SVG shield icons in `icons/` |
| **PNG icons** | `node scripts/generate-png-icons.js` | Rasterize PNGs (inactive + active variants) |
| **Build** | `npm run build` | Sync version and package `dist/claude-guard-v<version>.zip` |
| **E2E install** | `npm run e2e:install` | Install the Playwright Chromium browser |
| **E2E tests** | `npm run e2e` | Run end-to-end tests against the extension popup |

### End-to-end testing

The E2E suite uses Playwright and launches a real Chromium profile with this extension loaded.

```bash
# one-time browser install
npm run e2e:install

# run the suite
npm run e2e
```

### Project structure

```
├── manifest.json              # Chrome MV3 extension manifest (pins extension ID via "key")
├── background.js              # Service worker — state, rules, managed policy, approval window
├── content.js                 # Isolated world — agent detection, bridging, UI overlays
├── interceptor.js             # MAIN world — patches fetch/XHR/form/beacon
├── popup.html/js/css          # Toolbar popup — toggle auto mode, manage rules, stats
├── approve.html/js/css        # Human approval UI for blocked requests
├── managed_schema.json        # Enterprise (MDM) policy schema for chrome.storage.managed
├── generate-mobileconfig.sh   # Build/apply a Chrome .mobileconfig with allow/block rules
├── install-mobileconfig.sh    # Apply a .mobileconfig locally (managed prefs) for testing
├── icons/                     # Extension icons (PNG + SVG, inactive + active)
├── scripts/
│   ├── generate-icons.js
│   ├── generate-png-icons.js
│   ├── pack-zip.sh
│   └── version-sync.js
└── package.json
```

## License

ISC
