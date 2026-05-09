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

## Development

The extension is plain JavaScript with no bundler or framework — edit files and reload the extension in `chrome://extensions` to see changes.

### Available scripts

| Script | Command | Description |
|--------|---------|-------------|
| **Icons** | `npm run icons` | Generate SVG shield icons in `icons/` |
| **PNG icons** | `node scripts/generate-png-icons.js` | Rasterize PNGs (inactive + active variants) |
| **Build** | `npm run build` | Sync version and package `dist/claude-guard-v<version>.zip` |

### Project structure

```
├── manifest.json        # Chrome MV3 extension manifest
├── background.js        # Service worker — state, rules, approval window, badge
├── content.js           # Isolated world — agent detection, bridging, UI overlays
├── interceptor.js       # MAIN world — patches fetch/XHR/form/beacon
├── popup.html/js/css    # Toolbar popup — toggle auto mode, manage rules, stats
├── approve.html/js/css  # Human approval UI for blocked requests
├── icons/               # Extension icons (PNG + SVG, inactive + active)
├── scripts/
│   ├── generate-icons.js
│   ├── generate-png-icons.js
│   ├── pack-zip.sh
│   └── version-sync.js
└── package.json
```

## License

ISC
