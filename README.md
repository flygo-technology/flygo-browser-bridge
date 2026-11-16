# Flygo Browser Bridge

A Chrome / Edge extension that lets **your own** Flygo AI agents drive **this** browser, the same way the
[Playwright MCP](https://github.com/microsoft/playwright-mcp) Bridge extension does: it exposes the browser's tabs through
the Chrome DevTools Protocol (`chrome.debugger`), and the agent gets the Playwright MCP tool set (navigate, snapshot,
click, type, fill forms, tabs, screenshots, upload/download…) plus network logging and network rules.

It is the browser end of the Flygo app **"Trình duyệt"** (`vn.flygo.browser`):

- **Local mode (preferred).** When a `flygo-agent` runner (or the Flygo Chat desktop app) runs on this machine, it listens
  on `127.0.0.1:47800`. The extension finds it and connects automatically: no sign-in, no ports opened. Playwright,
  network logs and network rules all run on this machine. One browser can be used by agents of several Flygo servers
  (each runner registers it with its own server).
- **Direct mode (fallback).** Without a runner on this machine, sign in from the popup with your Flygo server address.
  The extension then connects to `<server>/__apps/browser/ws` and Playwright runs on the server.

Agents only ever reach browsers of the **same account**. Chrome shows its own "… is debugging this browser" bar while an
agent is attached; the popup shows who is in control and has **Stop** and **Disconnect** buttons.

## Install (manual)

1. Download the zip from your Flygo server (or build it: `scripts/pack.sh`) and unzip it into a folder you keep.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. Open Flygo Chat on this machine (or a runner): the popup turns cyan, **CONNECTED · LOCAL**. Done.

To update: unzip the new version over the same folder and click ↻ **Reload** on the extension card. Pairings are kept.

The extension ID is fixed by the public key in `manifest.json` (`pknpafgfaedabfloepblchniacfknjig`), so every install has
the same ID. The matching private key is not part of this repository.

## Network log and rules (run in the browser)

Agents turn logging on or off and read the log with tools (`browser_net_log_config`, `browser_net_log`,
`browser_net_request`); nothing is streamed. Logs live in this browser's IndexedDB (default: 24 hours, 20 000 requests).

Rules are stored in the browser and survive restarts (`browser_net_rule_add`, `browser_net_rule_set`, `…_list`,
`…_remove`):

| Action | How | Scope |
|---|---|---|
| `block`, `redirect`, `request_headers`, `response_headers` | `declarativeNetRequest` | every tab |
| `fulfill`, `rewrite_body`, `delay_ms`, `script` | CDP `Fetch` | tabs an agent is attached to |

`script` is the body of an async function `(req) => …` run in a sandboxed page with no extension privileges.

## Files

| File | |
|---|---|
| `src/background.js` | service worker: hub discovery, connection, `chrome.debugger` / `chrome.tabs` RPC |
| `src/net.js` | network log (webRequest + IndexedDB) and rules (DNR + CDP Fetch) |
| `src/offscreen.*`, `src/sandbox.*` | sandbox for rule scripts |
| `src/popup.*` | status popup |

## Protocol

Local hub (`ws://127.0.0.1:47800/ext`, the hub only accepts this extension's `Origin`):
`{t:"hello", ext_id, ext_version, info, pairings}` → RPC frames `{id, method, params}` / `{id, result|error}` and events
`{method, params}` exactly like the Playwright MCP relay (`chrome.debugger.attach|detach|sendCommand`,
`chrome.tabs.create|remove`, events `chrome.debugger.onEvent|onDetach`, `chrome.tabs.onCreated|onRemoved`), plus
`flygo.*` methods (network tools, `flygo.fetch`, `flygo.detachAll`) and `{t:…}` status messages. Messages over 200 KB are
split into `{t:"part", k, i, n, d}` frames.

## License

Apache-2.0
