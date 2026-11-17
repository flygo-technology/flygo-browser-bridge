# Flygo Browser Bridge

A Chrome / Edge extension that lets **your own** Flygo AI agents drive **this** browser, the same way the
[Playwright MCP](https://github.com/microsoft/playwright-mcp) Bridge extension does: it exposes the browser's tabs through
the Chrome DevTools Protocol (`chrome.debugger`), and the agent gets the Playwright MCP tool set (navigate, snapshot,
click, type, fill forms, tabs, screenshots, upload/download…) plus network logging and network rules.

It connects **out** to the Flygo Gateway WebSocket bridge of your Flygo server (`<server>/__apps/gateway/ws`, app
`vn.flygo.clients`), so no port is opened on your computer. The extension declares the tools it runs itself (network log,
network rules, download) and the `cdp` capability; the Playwright engine runs on the server and drives the browser through
this connection. Agents reach it through the Gateway like any other MCP: only agents acting for **the same account**, with
the usual per-tool approval in Flygo Chat.

Chrome shows its own "… is debugging this browser" bar while an agent is attached; the popup shows who is in control and
has **Stop**, **Disconnect** and **Sign out** buttons.

## Install (manual)

1. Download the zip from your Flygo server (or build it: `scripts/pack.sh`) and unzip it into a folder you keep.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. If Flygo Chat (desktop) is open and signed in on this computer, the extension pairs with it **automatically**: nothing to
   click. If Flygo Chat is signed in to several servers, the browser connects to **every** server that has the bridge (one
   connection each; each server's agents work in the tabs they open). Otherwise click the extension icon, enter your Flygo Chat server and **Sign in with Flygo** (one click when you are already signed
   in to Flygo Chat in this browser). The popup turns cyan, **CONNECTED**. From then on it reconnects by itself.

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

`<server>/__apps/gateway/ws`, first frame `{t:"hello", token:"fbd_…", client:{type:"extension", kind:"browser", name, version},
tools:[…declared tools…], capabilities:["cdp"], exclusive:true}` → `{t:"welcome", client:{id, name, slug}}`. Then JSON-RPC:
the server sends `{id, method, params}` (`tools/call` for declared tools; `chrome.debugger.attach|detach|sendCommand`,
`chrome.tabs.create|remove`, exactly like the Playwright MCP relay) and the extension answers `{id, result|error}` and streams
events `{method, params}` (`chrome.debugger.onEvent|onDetach`, `chrome.tabs.onCreated|onRemoved`). Messages over 200 KB are
split into `{t:"part", k, i, n, d}` frames. The device token comes from signing in (`/login` → Flygo ID → one-time code +
PKCE → `/api/pair-code`) and can be revoked from Flygo Chat (Settings › My browsers).

**Direct WebRTC channel (0.8.0).** When `welcome` carries `rtc: {ice_servers}`, the extension opens a WebRTC data channel to
the server (in the offscreen document, since service workers have no `RTCPeerConnection`): `{t:"rtc_offer", sdp}` →
`{t:"rtc_answer", sdp}`, then `{t:"rtc_cand", candidate, mid}` both ways, all over the WebSocket. Once the channel is open,
every message goes over it (frames split at 60k characters) and the WebSocket only carries a keep-alive `{t:"ka"}`. If the
channel closes, traffic falls back to the WebSocket and the extension retries WebRTC later. Reason: a WebSocket behind a
CDN/proxy can stall when a heavy page streams megabytes of CDP events. The popup shows each server's path (P2P / WS).

## Passwords and one-time codes (0.9.0)

The agent never asks for a password in chat. It calls `browser_ask_secret` on the field; the server asks the extension
(`flygo.secret_request`), which first tries a password remembered for that origin, else makes a one-time ECDH P-256 key
pair and returns the public key. The server answers the agent with a link `<server>/__apps/gateway/s/<id>#k=<public key>`
(the fragment never reaches the server). The browser's owner opens it (signed in to Flygo, same account), types the value;
the page encrypts it (ECDH → AES-GCM, AAD = request id) and the server relays the ciphertext (`flygo.secret_fill`). The
extension decrypts, checks that the marked field's frame is still on the requested origin, types the value and answers
"filled". Optional "remember on this browser" keeps it per origin in `chrome.storage.local`, encrypted with a
non-extractable key in IndexedDB (Settings in the popup lists and deletes them).

Every message to the server is scrubbed of known secrets (filled values, remembered passwords, current password-field
values in the tabs the agent uses), because accessibility snapshots, `evaluate` results and network logs can contain them.
This stops accidental exposure; it cannot stop an agent that deliberately transforms a value in page script.

## License

Apache-2.0
