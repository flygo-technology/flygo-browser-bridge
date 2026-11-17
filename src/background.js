// Flygo Browser Bridge: service worker.
// Exposes this browser to the user's own Flygo AI agents through the Flygo Gateway WebSocket bridge
// (<server>/__apps/gateway/ws), the way the Playwright MCP Bridge extension does locally: the extension runs chrome.debugger /
// chrome.tabs calls for a CDP relay (capability "cdp"; Playwright runs on the server) and streams the events back. It also
// declares the tools it runs itself (network log / rules / download). It connects to EVERY Flygo server it is paired with
// (Flygo Chat on this machine signed in to several servers → one connection per server that has the bridge); each server's
// agents work in the tabs they opened.
import { Net, ensureOffscreen } from './net.js';
import { DECLARED_TOOLS, NET_OPS } from './tools.js';
import { learnPasswords, learnVault, pendingList, scrub, secretCancel, secretFill, secretRequest, vaultDelete, vaultList } from './secrets.js';

const VERSION = chrome.runtime.getManifest().version;
const PING_MS = 20_000;
const DC_PART = 60_000;  // WebRTC messages are capped near 256 KB of UTF-8
const PART = 200_000;

// ------------------------------------------------------------------ state
const st = {
  extId: null,          // random id of this browser profile (stable)
  name: '',             // display name chosen by the user
  pairings: {},         // server url -> {browser_id, token, name, slug}
  servers: {},          // server url -> {ws_url, user}: servers this browser connects to
  blocked: {},          // server url -> true: removed / signed out, don't pair again by itself until the user asks
  disabled: false,      // user pressed "Disconnect"
};
const live = { control: {}, lastError: null, update: null, notice: null, localApp: null, pairing: false };
const conns = new Map();      // server url -> {ws, state, rtt, pingAt, pingTimer, error, since}
const activity = new Map();   // server url -> last time an agent used this browser through it (popup "last activity")
const attached = new Set();   // tab ids with the debugger attached (any server)
const tabOwner = new Map();   // tab id -> server url whose agent controls it
const attaching = new Map();  // tab id -> pending chrome.debugger.attach
let creatingFor = null;       // server creating a tab right now (its onCreated is not a user tab)
const agentTabs = new Set();  // tabs created by an agent
let groupId = null;
let tickTimer = null;
let partSeq = 0;
const parts = new Map();
const norm = (u) => String(u || '').replace(/\/+$/, '');

const loaded = (async () => {
  const s = await chrome.storage.local.get(['extId', 'name', 'pairings', 'servers', 'blocked', 'direct', 'disabled']);
  st.extId = s.extId || randomId();
  st.name = s.name || '';
  st.pairings = s.pairings || {};
  st.servers = s.servers || {};
  st.blocked = s.blocked || {};
  if (s.direct?.server && !st.servers[s.direct.server]) st.servers[s.direct.server] = { ws_url: s.direct.ws_url, user: s.direct.user || null }; // bản 0.3
  st.disabled = !!s.disabled;
  if (!s.extId) await chrome.storage.local.set({ extId: st.extId });
})();
const save = () => chrome.storage.local.set({ name: st.name, pairings: st.pairings, servers: st.servers, blocked: st.blocked, disabled: st.disabled, direct: null });

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function browserInfo() {
  const ua = navigator.userAgentData;
  let engine = 'Chrome', ver = '';
  try {
    const h = await ua?.getHighEntropyValues(['fullVersionList', 'platformVersion']);
    const list = h?.fullVersionList ?? ua?.brands ?? [];
    const edge = list.find((b) => /Edge/i.test(b.brand));
    const chrome = list.find((b) => /Google Chrome|Chromium/i.test(b.brand));
    const pick = edge ?? chrome;
    if (pick) { engine = /Edge/i.test(pick.brand) ? 'Edge' : /Chromium/i.test(pick.brand) ? 'Chromium' : 'Chrome'; ver = String(pick.version).split('.')[0]; }
  } catch {}
  return { name: st.name || undefined, engine: `${engine}${ver ? ' ' + ver : ''}`, os: ua?.platform || navigator.platform || '' };
}

// ------------------------------------------------------------------ net (logs + rules, run here; shared by all servers)
const net = new Net({
  debuggerSend: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  attachedTabs: () => [...attached],
});

// ------------------------------------------------------------------ framing
// Everything goes over the direct WebRTC channel when it is open (c.dc), else over the WebSocket.
function sendTo(c, obj) {
  if (c?.dc && rtcPort) {
    const id = c.server;
    return frame(obj, DC_PART, (s) => rtcPort.postMessage({ op: 'send', id, s }));
  }
  sendWs(c, obj);
}
/** WebSocket only (WebRTC handshake, keep-alive). */
function sendWs(c, obj) {
  const ws = c?.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  frame(obj, PART, (s) => ws.send(s));
}
function frame(obj, part, out) {
  const s = scrub(JSON.stringify(obj)); // never let a password leave the browser (see secrets.js)
  if (s.length <= part) return out(s);
  const k = `e${++partSeq}`, n = Math.ceil(s.length / part);
  for (let i = 0; i < n; i++) out(JSON.stringify({ t: 'part', k, i, n, d: s.slice(i * part, (i + 1) * part) }));
}
const sendAll = (obj) => { for (const c of conns.values()) sendTo(c, obj); };
function joinPart(m, server) {
  if (m?.t !== 'part') return m;
  const key = `${server} ${m.k}`;
  let p = parts.get(key);
  if (!p) parts.set(key, (p = { n: m.n, got: 0, d: [] }));
  if (p.d[m.i] === undefined) { p.d[m.i] = m.d; p.got++; }
  if (p.got < p.n) return null;
  parts.delete(key);
  return JSON.parse(p.d.join(''));
}

// ------------------------------------------------------------------ RPC from a server's relay
async function addToGroup(tabId) {
  try {
    if (groupId !== null) { try { await chrome.tabGroups.get(groupId); } catch { groupId = null; } }
    groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupId !== null ? { groupId } : {}) });
    await chrome.tabGroups.update(groupId, { title: 'Flygo AI', color: 'blue' });
  } catch {}
}

const secretDeps = {
  tabsOf: (server) => [...tabOwner].filter(([, o]) => o === server).map(([t]) => t),
  attached: (tabId) => attached.has(tabId),
  changed: () => render(),
};

async function rpc(server, method, params) {
  switch (method) {
    case 'chrome.debugger.attach': {
      const [target, ver] = params;
      const owner = tabOwner.get(target.tabId);
      if ((attached.has(target.tabId) || attaching.has(target.tabId)) && owner && owner !== server) throw new Error('Tab đang được agent của máy chủ khác điều khiển');
      tabOwner.set(target.tabId, server);
      // One attach per tab even when Playwright asks twice at once (auto-attach + new target).
      if (!attached.has(target.tabId)) {
        let p = attaching.get(target.tabId);
        if (!p) {
          p = chrome.debugger.attach(target, ver || '1.3').finally(() => attaching.delete(target.tabId));
          attaching.set(target.tabId, p);
        }
        await p;
      }
      attached.add(target.tabId);
      tabOwner.set(target.tabId, server);
      await net.onAttach(target.tabId);
      void learnVault().catch(() => {});
      if (live.control[server]) void overlay(target.tabId, true, controlLabel(server));
      refreshBadge();
      return {};
    }
    case 'chrome.debugger.detach': {
      const [target] = params;
      if (tabOwner.get(target.tabId) !== server) return {};
      await chrome.debugger.detach(target).catch(() => {});
      attached.delete(target.tabId); tabOwner.delete(target.tabId);
      refreshBadge();
      return {};
    }
    case 'chrome.debugger.sendCommand': {
      const [target, m, p] = params;
      if (tabOwner.get(target.tabId) !== server) throw new Error('Tab không thuộc phiên điều khiển này');
      if (m === 'Input.dispatchMouseEvent' && !target.sessionId) void cursor(target.tabId, p);
      // Playwright's own Fetch interception is merged with our network rules (one debugger session per tab).
      if (!target.sessionId && (m === 'Fetch.enable' || m === 'Fetch.disable')) return net.pwFetch(target.tabId, m, p);
      const res = await chrome.debugger.sendCommand(target, m, p);
      // Results that read the page (snapshot, evaluate, DOM) may carry password-field values: learn them first so they get scrubbed.
      if (/^(Runtime|DOM|Accessibility)\./.test(m)) await learnPasswords(target.tabId, JSON.stringify(res ?? '').includes('textbox'));
      return res;
    }
    case 'chrome.tabs.create': {
      const [opts] = params;
      creatingFor = server;
      let tab;
      try { tab = await chrome.tabs.create({ url: opts?.url || 'about:blank', active: !!opts?.active }); } finally { creatingFor = null; }
      agentTabs.add(tab.id);
      tabOwner.set(tab.id, server);
      void addToGroup(tab.id);
      return tab;
    }
    case 'chrome.tabs.remove': {
      const [tabId] = params;
      if (tabOwner.has(tabId) && tabOwner.get(tabId) !== server) throw new Error('Tab không thuộc phiên điều khiển này');
      await chrome.tabs.remove(tabId).catch(() => {});
      return {};
    }
    case 'flygo.tabs': {
      // Tabs this server's agent may use: every debuggable tab not held by another server (active_only: the tab(s) the
      // user is looking at, attached when a session starts; others on demand with browser_tab_attach).
      const out = [];
      for (const t of await chrome.tabs.query(params?.active_only ? { active: true } : {})) {
        if (t.id === undefined || /^(chrome|edge|devtools|chrome-extension):/i.test(t.url || '')) continue;
        const o = tabOwner.get(t.id);
        if (o && o !== server && (attached.has(t.id) || attaching.has(t.id))) continue;
        out.push({ id: t.id, url: t.url, title: t.title, active: !!t.active, used_by_agent: attached.has(t.id) });
      }
      return out;
    }
    case 'tools/call': return await callDeclared(params?.name, params?.arguments || {});
    case 'flygo.secret_request': return await secretRequest(secretDeps, server, params);
    case 'flygo.secret_fill': return await secretFill(secretDeps, server, params);
    case 'flygo.detachAll': await detachAll(server); return { ok: true };
    case 'flygo.fetch': return await fetchForAgent(params?.url, params?.max_bytes);
    default:
      if (method.startsWith('flygo.net.')) return await net.handle(method.slice('flygo.net.'.length), params || {});
      throw new Error(`unsupported: ${method}`);
  }
}

/** Declared tools (run here). Returns an MCP tool result. */
async function callDeclared(name, args) {
  const text = (o, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] });
  try {
    if (NET_OPS[name]) return text(await net.handle(NET_OPS[name], args));
    if (name === 'browser_download') {
      const r = await fetchForAgent(args.url, 50 * 1024 * 1024);
      const fname = String(args.name || r.name || 'download');
      return { content: [
        { type: 'text', text: JSON.stringify({ ok: true, name: fname, bytes: r.bytes, type: r.type, status: r.status }) },
        { type: 'resource', resource: { uri: `file:///${encodeURIComponent(fname)}`, name: fname, mimeType: r.type, blob: r.base64 } },
      ] };
    }
    return text(`unknown tool ${name}`, true);
  } catch (e) { return text(String(e?.message || e), true); }
}

/** Detach the debugger from the tabs of one server (or all). */
async function detachAll(server) {
  for (const tabId of [...attached]) {
    if (server && tabOwner.get(tabId) !== server) continue;
    void overlay(tabId, false);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    attached.delete(tabId); tabOwner.delete(tabId);
  }
  refreshBadge();
}

async function fetchForAgent(url, maxBytes = 50 * 1024 * 1024) {
  const u = new URL(String(url));
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  const r = await fetch(u, { credentials: 'include' });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file too large (${buf.length} bytes)`);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const cd = r.headers.get('content-disposition') || '';
  const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1]) || (/filename="?([^";]+)"?/i.exec(cd)?.[1]) || u.pathname.split('/').pop() || 'download');
  return { base64: btoa(bin), bytes: buf.length, type: r.headers.get('content-type') || 'application/octet-stream', status: r.status, name };
}

// ------------------------------------------------------------------ chrome events -> the server owning the tab
const ownerConn = (tabId) => conns.get(tabOwner.get(tabId));
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attached.has(source.tabId)) return;
  const c = ownerConn(source.tabId);
  if (method === 'Fetch.requestPaused' && !source.sessionId) {
    net.onPaused(source.tabId, params).then((handled) => { if (!handled) sendTo(c, { method: 'chrome.debugger.onEvent', params: [source, method, params] }); });
    return;
  }
  net.onCdpEvent(source.tabId, method, params);
  sendTo(c, { method: 'chrome.debugger.onEvent', params: [source, method, params] });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const c = ownerConn(source.tabId);
  attached.delete(source.tabId); tabOwner.delete(source.tabId);
  refreshBadge();
  sendTo(c, { method: 'chrome.debugger.onDetach', params: [source, reason] });
  // The user pressed "Cancel" on Chrome's "is debugging this browser" bar: treat as Stop (every server).
  if (reason === 'canceled_by_user') { sendAll({ t: 'stop' }); void detachAll(); }
});
chrome.tabs.onCreated.addListener((tab) => {
  const owner = tab.openerTabId !== undefined && attached.has(tab.openerTabId) ? tabOwner.get(tab.openerTabId) : null;
  if (owner) { agentTabs.add(tab.id); tabOwner.set(tab.id, owner); void addToGroup(tab.id); sendTo(conns.get(owner), { method: 'chrome.tabs.onCreated', params: [tab] }); }
  // Created by an agent (chrome.tabs.create in progress): that server already knows it.
  else if (creatingFor) { tabOwner.set(tab.id, creatingFor); agentTabs.add(tab.id); }
  // Tabs the user opens are listed by browser_tabs_all; an agent takes one with browser_tab_attach.
});

// ------------------------------------------------------------------ "agent is controlling" effect in the page
// Glowing border + small label, pointer-events none and aria-hidden: doesn't block the agent or change what it reads.
function overlayFn(on, label) {
  const ID = '__flygo_bridge_overlay__';
  let host = document.getElementById(ID);
  if (!on) { host?.remove(); return; }
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b{position:fixed;inset:0;border:3px solid #1a73e8;border-radius:6px;box-shadow:inset 0 0 18px rgba(26,115,232,.55);animation:p 1.6s ease-in-out infinite}
      .b.in{animation:in .7s ease-out, p 1.6s ease-in-out .7s infinite}
      @keyframes in{0%{opacity:0;box-shadow:inset 0 0 120px rgba(26,115,232,.9)}100%{opacity:1}}
      @keyframes p{50%{box-shadow:inset 0 0 6px rgba(26,115,232,.35);border-color:#4f9bff}}
      .t{position:fixed;top:10px;right:10px;font:600 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:#1a73e8;border-radius:999px;padding:7px 11px;box-shadow:0 2px 8px rgba(0,0,0,.25);animation:s .5s ease-out}
      @keyframes s{0%{transform:translateY(-14px);opacity:0}100%{transform:none;opacity:1}}
    </style><div class="b in"></div><div class="t"></div>`;
    host.__t = root.querySelector('.t');
    (document.documentElement || document.body).appendChild(host);
  }
  if (host.__t) host.__t.textContent = label;
}
// Fake cursor: follows the agent's mouse events (CSS px, viewport coordinates, same as CDP) and ripples on click.
function cursorFn(x, y, type) {
  const ID = '__flygo_bridge_cursor__';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .c{position:fixed;left:0;top:0;width:22px;height:22px;transition:transform .35s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
      .r{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #1a73e8;opacity:0;pointer-events:none}
      .r.go{animation:rp .55s ease-out}
      @keyframes rp{0%{transform:scale(.2);opacity:.9}100%{transform:scale(1.6);opacity:0}}
    </style><svg class="c" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.4-7.6L20.5 11z" fill="#1a73e8" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="r"></div>`;
    host.__c = root.querySelector('.c'); host.__r = root.querySelector('.r');
    (document.documentElement || document.body).appendChild(host);
  }
  host.__c.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
  if (type === 'mousePressed') {
    const r = host.__r;
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  }
  clearTimeout(host.__hide);
  host.style.display = '';
  host.__hide = setTimeout(() => { host.style.display = 'none'; }, 8000);
}
let cursorBusy = 0;
async function cursor(tabId, p) {
  if (!p || typeof p.x !== 'number') return;
  if (p.type === 'mouseMoved' && Date.now() - cursorBusy < 40) return; // drop extra moves
  cursorBusy = Date.now();
  try { await chrome.scripting.executeScript({ target: { tabId }, func: cursorFn, args: [p.x, p.y, p.type], world: 'ISOLATED' }); } catch {}
}

async function overlay(tabId, on, label = '') {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: overlayFn, args: [on, label], world: 'ISOLATED' }); } catch {}
}
function controlLabel(server) {
  const c = live.control[server];
  return c ? `🤖 ${c.agent || 'Agent'} đang điều khiển` : '';
}
/** Show / hide the effect on every tab a server controls. */
function refreshOverlays(server) {
  for (const [tabId, owner] of tabOwner) if (owner === server && attached.has(tabId)) void overlay(tabId, !!live.control[server], controlLabel(server));
}
let blinkTimer = null;
function blinkBadge() {
  let n = 0;
  clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    chrome.action.setBadgeBackgroundColor({ color: n % 2 ? '#c2185b' : '#1a73e8' });
    if (++n >= 8) { clearInterval(blinkTimer); refreshBadge(); }
  }, 350);
}
// Page reloads remove the effect: put it back while the agent is still in control.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete' || !attached.has(tabId)) return;
  const owner = tabOwner.get(tabId);
  if (owner && live.control[owner]) void overlay(tabId, true, controlLabel(owner));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const c = ownerConn(tabId);
  attached.delete(tabId); agentTabs.delete(tabId); tabOwner.delete(tabId);
  if (c) sendTo(c, { method: 'chrome.tabs.onRemoved', params: [tabId] }); else sendAll({ method: 'chrome.tabs.onRemoved', params: [tabId] });
  refreshBadge();
});

// ------------------------------------------------------------------ Flygo Chat on this machine (pairing only)
const LOCAL_APP = 'http://127.0.0.1:47800';
async function localApp() {
  try {
    const r = await fetch(`${LOCAL_APP}/flygo/hello`, { signal: AbortSignal.timeout(1500), cache: 'no-store', headers: { 'X-Flygo-Bridge': chrome.runtime.id } });
    const j = r.ok ? await r.json() : null;
    if (j?.role !== 'pairing' || !j.server) return null;
    // Flygo Chat may be signed in to several servers; those with the Gateway bridge can all take this browser.
    const list = Array.isArray(j.servers) && j.servers.length ? j.servers : [{ url: j.server, current: true }];
    j.choices = [];
    for (const x of list) if (x?.url && await hasBridge(norm(x.url))) j.choices.push({ url: norm(x.url), name: x.name || '', current: !!x.current });
    j.supported = j.choices.length > 0;
    return j;
  } catch { return null; }
}
const bridgeCache = new Map();
async function hasBridge(server) {
  const c = bridgeCache.get(server);
  if (c && Date.now() - c.at < 10 * 60_000) return c.ok;
  let ok = false;
  try {
    const r = await fetch(`${server}/__apps/gateway/healthz`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    ok = r.ok && (await r.json().catch(() => null))?.ok === true;
  } catch {}
  bridgeCache.set(server, { ok, at: Date.now() });
  return ok;
}

/** Pair with one server through the Flygo Chat app signed in on this machine (no sign-in needed). */
async function pairLocal(target) {
  const r = await fetch(`${LOCAL_APP}/flygo/pair`, {
    method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json', 'X-Flygo-Bridge': chrome.runtime.id },
    body: JSON.stringify({ server: target, client: await browserInfo(), replace: st.pairings[target]?.browser_id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token || !j.ws_url) throw new Error(j.error || `Flygo Chat từ chối ghép (${r.status})`);
  const server = norm(j.server);
  st.pairings[server] = { browser_id: j.client?.id, token: j.token, name: j.client?.name, slug: j.client?.slug };
  st.servers[server] = { ws_url: j.ws_url, user: j.user || null };
  delete st.blocked[server];
  if (!st.name && j.client?.name) st.name = j.client.name;
  await save();
  live.notice = { text: `Đã kết nối ${new URL(server).host} qua Flygo Chat trên máy này.`, at: Date.now() };
}

// ------------------------------------------------------------------ connections
function closeConn(server, reason) {
  const c = conns.get(server);
  if (!c) return;
  conns.delete(server);
  if (c.pingTimer) clearInterval(c.pingTimer);
  rtcClose(c);
  try { c.ws?.close(1000, reason); } catch {}
  delete live.control[server];
  void detachAll(server);
}

async function tick() {
  await loaded;
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (st.disabled) { for (const s of [...conns.keys()]) closeConn(s, 'disabled'); return render(); }
  for (const [server, info] of Object.entries(st.servers)) {
    if (!conns.has(server) && info?.ws_url && st.pairings[server]?.token) connect(server);
  }
  // Flygo Chat on this machine: pair with every signed-in server that has the bridge and isn't connected yet.
  const app = await localApp();
  live.localApp = app;
  if (app?.supported && !live.pairing) {
    live.pairing = true;
    try {
      for (const c of app.choices) {
        if (st.servers[c.url] || st.blocked[c.url]) continue;
        try { await pairLocal(c.url); connect(c.url); }
        catch (e) { live.lastError = `${new URL(c.url).host}: ${String(e?.message || e)}`; }
      }
    } finally { live.pairing = false; }
  }
  render();
  tickTimer = setTimeout(() => void tick(), conns.size ? 30_000 : 5000);
}

function connect(server) {
  const info = st.servers[server];
  const c = { server, ws: null, state: 'connecting', rtt: null, pingAt: 0, pingTimer: null, error: null, since: null, dc: false, rtc: null };
  conns.set(server, c);
  let ws;
  try { ws = new WebSocket(info.ws_url); } catch (e) { c.state = 'error'; c.error = String(e?.message || e); conns.delete(server); return; }
  c.ws = ws;
  ws.onopen = async () => {
    c.state = 'open'; c.error = null; c.since = Date.now();
    const bi = await browserInfo();
    ws.send(JSON.stringify({
      t: 'hello', token: st.pairings[server]?.token,
      client: { type: 'extension', kind: 'browser', name: st.name || bi.engine, version: VERSION, engine: bi.engine, os: bi.os },
      tools: DECLARED_TOOLS, capabilities: ['cdp'], exclusive: true, info: bi,
    }));
    c.pingTimer = setInterval(() => {
      c.pingAt = Date.now(); sendTo(c, { t: 'ping' });
      if (c.dc) sendWs(c, { t: 'ka' }); // keeps the idle WebSocket (signalling + fallback) from being cut by proxies
    }, PING_MS);
    render();
  };
  ws.onmessage = (ev) => incoming(c, ev.data);
  ws.onclose = (ev) => {
    if (conns.get(server) !== c) return;
    conns.delete(server);
    if (c.pingTimer) clearInterval(c.pingTimer);
    rtcClose(c);
    delete live.control[server];
    void detachAll(server);
    if (ev.code === 4401 || ev.code === 4403) {
      // Removed from the account: forget this server, don't pair it again by itself.
      delete st.servers[server]; delete st.pairings[server]; st.blocked[server] = true; void save();
      live.lastError = `${new URL(server).host}: đã bị gỡ khỏi tài khoản.`;
    }
    render();
    setTimeout(() => void tick(), 3000 + Math.random() * 3000);
  };
  ws.onerror = () => { c.error = 'Không nối được máy chủ, đang thử lại…'; };
}

/** A message from the server, over the WebSocket or the WebRTC channel. */
function incoming(c, raw) {
  if (conns.get(c.server) !== c) return;
  let m;
  try { m = joinPart(JSON.parse(raw), c.server); } catch { return; }
  if (!m) return;
  if (m.t) return onFlygo(c, m);
  if (m.id !== undefined && m.method) {
    activity.set(c.server, Date.now());
    rpc(c.server, m.method, m.params).then((result) => sendTo(c, { id: m.id, result: result ?? {} }), (e) => sendTo(c, { id: m.id, error: { message: String(e?.message || e) } }));
  }
}

// ------------------------------------------------------------------ direct WebRTC channel (P2P)
// The WebSocket often goes through a CDN/proxy that stalls when a heavy page pushes megabytes of CDP events. A server
// that offers WebRTC (welcome.rtc) gets a data channel straight to it; the WebSocket stays for the handshake and fallback.
let rtcPort = null;
async function rtcConnect() {
  if (rtcPort) return rtcPort;
  await ensureOffscreen();
  if (rtcPort) return rtcPort;
  const port = chrome.runtime.connect({ name: 'rtc' });
  rtcPort = port;
  port.onDisconnect.addListener(() => {
    if (rtcPort === port) rtcPort = null;
    for (const c of conns.values()) if (c.rtc) { c.rtc = null; if (c.dc) { c.dc = false; render(); } rtcRetry(c); }
  });
  port.onMessage.addListener((m) => {
    const c = conns.get(m.id);
    if (!c?.rtc) { if (m.ev !== 'close') port.postMessage({ op: 'close', id: m.id }); return; }
    switch (m.ev) {
      case 'offer': sendWs(c, { t: 'rtc_offer', sdp: m.sdp }); break;
      case 'cand': sendWs(c, { t: 'rtc_cand', candidate: m.candidate, mid: m.mid }); break;
      case 'open': c.dc = true; c.rtc.tries = 0; render(); break;
      case 'msg': incoming(c, m.d); break;
      case 'close': {
        const was = c.dc;
        c.dc = false; c.rtc = null;
        if (was) render();
        rtcRetry(c);
        break;
      }
    }
  });
  return port;
}
async function rtcStart(c, iceServers) {
  if (c.rtc || conns.get(c.server) !== c) return;
  c.rtc = { iceServers, tries: (c.rtcTries || 0) + 1 };
  c.rtcTries = c.rtc.tries;
  try { (await rtcConnect()).postMessage({ op: 'open', id: c.server, iceServers: iceServers || [] }); }
  catch { c.rtc = null; }
}
function rtcClose(c) {
  if (c.rtc && rtcPort) try { rtcPort.postMessage({ op: 'close', id: c.server }); } catch {}
  c.rtc = null; c.dc = false;
}
/** Channel gone or never opened: the WebSocket carries on; try again later (backs off up to 5 min). */
function rtcRetry(c) {
  if (!c.rtcOffer || conns.get(c.server) !== c || c.state !== 'open') return;
  const wait = Math.min(300_000, 15_000 * 2 ** Math.min(4, (c.rtcTries || 1) - 1));
  clearTimeout(c.rtcTimer);
  c.rtcTimer = setTimeout(() => void rtcStart(c, c.rtcOffer.ice_servers), wait);
}

function onFlygo(c, m) {
  const server = c.server;
  switch (m.t) {
    case 'pong': if (c.pingAt) { c.rtt = Date.now() - c.pingAt; sendTo(c, { t: 'rtt', ms: c.rtt }); } break;
    case 'welcome': {
      const k = m.client || m.browser;
      if (k) {
        st.pairings[server] = { ...st.pairings[server], browser_id: k.id, name: k.name, slug: k.slug };
        if (!st.name) st.name = k.name;
        void save();
      }
      if (m.latest_version && newer(m.latest_version, VERSION)) live.update = { latest_version: m.latest_version, download_url: m.download_url };
      if (m.rtc) { c.rtcOffer = m.rtc; void rtcStart(c, m.rtc.ice_servers); }
      break;
    }
    case 'rtc_answer': if (c.rtc && rtcPort) rtcPort.postMessage({ op: 'answer', id: c.server, sdp: m.sdp }); return;
    case 'rtc_cand': if (c.rtc && rtcPort) rtcPort.postMessage({ op: 'cand', id: c.server, candidate: m.candidate, mid: m.mid }); return;
    case 'renamed':
      st.pairings[server] = { ...st.pairings[server], name: m.name, slug: m.slug };
      st.name = m.name;
      void save();
      break;
    case 'revoked':
      delete st.pairings[server]; delete st.servers[server]; st.blocked[server] = true;
      closeConn(server, 'revoked');
      void save();
      break;
    case 'control': {
      const was = !!live.control[server];
      if (m.active) live.control[server] = { agent: m.agent, machine: m.machine, since: Date.now(), taken_from: m.taken_from };
      else delete live.control[server];
      refreshBadge();
      refreshOverlays(server);
      if (m.active && !was) blinkBadge();
      break;
    }
    case 'update': if (m.required || (m.latest_version && newer(m.latest_version, VERSION))) live.update = m; break;
    case 'notice': live.notice = { text: m.text, at: Date.now() }; break;
    case 'secret_cancel': secretCancel(m.id); break;
    case 'error': c.error = m.message || m.code; if (m.code === 'outdated') live.update = { required: true, download_url: m.download_url }; break;
  }
  render();
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// ------------------------------------------------------------------ badge + popup
const openConns = () => [...conns.values()].filter((c) => c.state === 'open');
function refreshBadge() {
  const active = Object.keys(live.control).length > 0;
  const on = openConns().length > 0;
  chrome.action.setBadgeBackgroundColor({ color: active ? '#c2185b' : on ? '#1e9e5a' : '#9aa4b1' });
  chrome.action.setBadgeText({ text: active ? 'AI' : on ? String(openConns().length > 1 ? openConns().length : ' ') : '' });
  chrome.action.setTitle({ title: active ? `Flygo Browser Bridge: ${Object.values(live.control)[0].agent} đang điều khiển` : on ? `Flygo Browser Bridge: đã kết nối ${openConns().length} máy chủ` : 'Flygo Browser Bridge: chưa kết nối' });
}

async function snapshot() {
  await loaded;
  const servers = Object.entries(st.servers).map(([server, info]) => {
    const c = conns.get(server);
    const state = !c ? (st.disabled ? 'offline' : 'error') : c.state === 'open' ? 'online' : c.error ? 'error' : 'connecting';
    return { server, user: info?.user || null, state, rtt: c?.rtt ?? null, error: c?.error ?? null, slug: st.pairings[server]?.slug || null,
      since: c?.since ?? null, lastAt: activity.get(server) ?? null, path: c?.state === 'open' ? (c.dc ? 'p2p' : 'ws') : null };
  });
  return {
    version: VERSION, name: st.name, disabled: st.disabled, connected: openConns().length, servers,
    pairings: Object.fromEntries(Object.entries(st.pairings).map(([k, v]) => [k, { name: v.name, slug: v.slug, browser_id: v.browser_id }])),
    control: live.control, attached: attached.size, agentTabs: agentTabs.size, lastError: live.lastError,
    secrets: { pending: pendingList(), saved: await vaultList().catch(() => []) },
    update: live.update, notice: live.notice && Date.now() - live.notice.at < 60_000 ? live.notice : null, net: await net.summary(),
    localApp: live.localApp ? { server: live.localApp.server, user: live.localApp.user, supported: !!live.localApp.supported,
      choices: (live.localApp.choices || []).map((c) => ({ ...c, connected: !!st.servers[c.url] })) } : null,
  };
}
function render() { refreshBadge(); chrome.runtime.sendMessage({ type: 'state' }).catch(() => {}); }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.target === 'offscreen') return;
  (async () => {
    await loaded;
    switch (msg.type) {
      case 'get': return snapshot();
      case 'rename': {
        const name = String(msg.name || '').trim().slice(0, 60);
        if (!name) return snapshot();
        st.name = name; await save();
        sendAll({ t: 'rename', name });
        return snapshot();
      }
      case 'stop': sendAll({ t: 'stop' }); await detachAll(); live.control = {}; render(); return snapshot();
      case 'preview_effect': {
        // Popup "thử hiệu ứng" (kiểm tra): show the effect on the active tab for 3 s.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) { await overlay(tab.id, true, '🤖 Agent đang điều khiển'); setTimeout(() => void overlay(tab.id, false), 3000); blinkBadge(); }
        return snapshot();
      }
      case 'toggle': st.disabled = !st.disabled; await save(); if (st.disabled) { for (const s of [...conns.keys()]) closeConn(s, 'disabled'); await detachAll(); } void tick(); return snapshot();
      case 'login': await login(String(msg.server || '')); void tick(); return snapshot();
      case 'logout': {
        // msg.server: one server; none: all.
        const list = msg.server ? [norm(msg.server)] : Object.keys(st.servers);
        for (const s of list) { closeConn(s, 'logout'); delete st.servers[s]; delete st.pairings[s]; st.blocked[s] = true; }
        await save(); render(); return snapshot();
      }
      case 'vault_delete': await vaultDelete(String(msg.origin || '')); return snapshot();
      case 'pair_local': {
        live.localApp = await localApp();
        const list = msg.server ? [norm(msg.server)] : (live.localApp?.choices || []).map((c) => c.url).filter((u) => !st.servers[u]);
        for (const s of list) { delete st.blocked[s]; await pairLocal(s); }
        void tick(); return snapshot();
      }
    }
  })().then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

// ------------------------------------------------------------------ sign in to a server directly (no Flygo Chat on this machine)
async function login(serverInput) {
  let server = serverInput.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(server)) server = `https://${server}`;
  const u = new URL(server);
  if (u.protocol !== 'https:') throw new Error('Máy chủ phải dùng https');
  server = u.origin;
  const verifier = randomId() + randomId();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomId();
  const redirect = chrome.identity.getRedirectURL('cb');
  const start = `${server}/__apps/gateway/login?${new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, state })}`;
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url: start, interactive: true }));
  if (back.searchParams.get('state') !== state) throw new Error('Sai trạng thái đăng nhập');
  if (back.searchParams.get('error')) throw new Error(back.searchParams.get('error'));
  const r = await fetch(`${server}/__apps/gateway/api/pair-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: back.searchParams.get('code'), code_verifier: verifier, client: { type: 'extension', kind: 'browser', ...(await browserInfo()) }, replace: st.pairings[server]?.browser_id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || `Đăng nhập không được (${r.status})`);
  const k = j.client || j.browser;
  st.pairings[server] = { browser_id: k.id, token: j.token, name: k.name, slug: k.slug };
  st.servers[server] = { ws_url: j.ws_url, user: j.user?.name || null };
  delete st.blocked[server];
  if (!st.name) st.name = k.name;
  await save();
  live.notice = { text: `Đã đăng nhập ${u.host}${j.user?.name ? ` (${j.user.name})` : ''}.`, at: Date.now() };
}
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// ------------------------------------------------------------------ lifecycle
chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') void tick(); if (a.name === 'net-retention') void net.retention(); });
chrome.alarms.create('net-retention', { periodInMinutes: 30 });
chrome.runtime.onStartup.addListener(() => void tick());
chrome.runtime.onInstalled.addListener(() => void tick());
// For debugging from chrome://extensions (inspect service worker).
globalThis.__flygo = { st, live, net, attached, conns, tabOwner };
void tick();
