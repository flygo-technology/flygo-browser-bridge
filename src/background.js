// Flygo Browser Bridge: service worker.
// Exposes this browser to the user's own Flygo AI agents through the Flygo Gateway WebSocket bridge
// (<server>/__apps/gateway/ws), the way the Playwright MCP Bridge extension does locally: the extension runs chrome.debugger /
// chrome.tabs calls for a CDP relay (capability "cdp"; Playwright runs on the server) and streams the events back. It also
// declares the tools it runs itself (network log / rules / download). Sign in once from the popup; then it reconnects by
// itself whenever the browser runs.
import { Net } from './net.js';
import { DECLARED_TOOLS, NET_OPS } from './tools.js';

const VERSION = chrome.runtime.getManifest().version;
const PING_MS = 20_000;
const PART = 200_000;

// ------------------------------------------------------------------ state
const st = {
  extId: null,          // random id of this browser profile (stable)
  name: '',             // display name chosen by the user
  pairings: {},         // server url -> {browser_id, token, name, slug}
  direct: null,         // {server, ws_url, user} of the server this browser is signed in to
  disabled: false,      // user pressed "Disconnect"
  noAutoPair: false,    // removed from the account / signed out: don't pair again by itself until the user asks
};
const live = {
  ws: null, mode: null, servers: [], control: {}, lastError: null, update: null, notice: null,
  rtt: null, connecting: false,
};
const attached = new Set();   // tab ids with the debugger attached
const agentTabs = new Set();  // tabs created by an agent
let groupId = null;
let pingTimer = null;
let tickTimer = null;
let partSeq = 0;
const parts = new Map();

const loaded = (async () => {
  const s = await chrome.storage.local.get(['extId', 'name', 'pairings', 'direct', 'disabled', 'noAutoPair', 'lastServer']);
  st.extId = s.extId || randomId();
  st.name = s.name || '';
  st.pairings = s.pairings || {};
  st.direct = s.direct || null;
  st.disabled = !!s.disabled;
  st.noAutoPair = !!s.noAutoPair;
  st.lastServer = s.lastServer || null;
  if (!s.extId) await chrome.storage.local.set({ extId: st.extId });
})();
const save = () => chrome.storage.local.set({ name: st.name, pairings: st.pairings, direct: st.direct, disabled: st.disabled, noAutoPair: st.noAutoPair, lastServer: st.lastServer || null });

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

// ------------------------------------------------------------------ net (logs + rules, run here)
const net = new Net({
  debuggerSend: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  attachedTabs: () => [...attached],
});

// ------------------------------------------------------------------ framing
function sendObj(obj) {
  const ws = live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const s = JSON.stringify(obj);
  if (s.length <= PART) return ws.send(s);
  const k = `e${++partSeq}`, n = Math.ceil(s.length / PART);
  for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: 'part', k, i, n, d: s.slice(i * PART, (i + 1) * PART) }));
}
function joinPart(m) {
  if (m?.t !== 'part') return m;
  let p = parts.get(m.k);
  if (!p) parts.set(m.k, (p = { n: m.n, got: 0, d: [] }));
  if (p.d[m.i] === undefined) { p.d[m.i] = m.d; p.got++; }
  if (p.got < p.n) return null;
  parts.delete(m.k);
  return JSON.parse(p.d.join(''));
}

// ------------------------------------------------------------------ RPC from the relay
async function addToGroup(tabId) {
  try {
    if (groupId !== null) { try { await chrome.tabGroups.get(groupId); } catch { groupId = null; } }
    groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupId !== null ? { groupId } : {}) });
    await chrome.tabGroups.update(groupId, { title: 'Flygo AI', color: 'purple' });
  } catch {}
}

async function rpc(method, params) {
  switch (method) {
    case 'chrome.debugger.attach': {
      const [target, ver] = params;
      await chrome.debugger.attach(target, ver || '1.3');
      attached.add(target.tabId);
      await net.onAttach(target.tabId);
      refreshBadge();
      return {};
    }
    case 'chrome.debugger.detach': {
      const [target] = params;
      await chrome.debugger.detach(target).catch(() => {});
      attached.delete(target.tabId);
      refreshBadge();
      return {};
    }
    case 'chrome.debugger.sendCommand': {
      const [target, m, p] = params;
      // Playwright's own Fetch interception is merged with our network rules (one debugger session per tab).
      if (!target.sessionId && (m === 'Fetch.enable' || m === 'Fetch.disable')) return net.pwFetch(target.tabId, m, p);
      return await chrome.debugger.sendCommand(target, m, p);
    }
    case 'chrome.tabs.create': {
      const [opts] = params;
      const tab = await chrome.tabs.create({ url: opts?.url || 'about:blank', active: !!opts?.active });
      agentTabs.add(tab.id);
      void addToGroup(tab.id);
      return tab;
    }
    case 'chrome.tabs.remove': {
      const [tabId] = params;
      await chrome.tabs.remove(tabId).catch(() => {});
      return {};
    }
    case 'tools/call': return await callDeclared(params?.name, params?.arguments || {});
    case 'flygo.detachAll': await detachAll(); return { ok: true };
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

async function detachAll() {
  for (const tabId of [...attached]) { await chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); }
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

// ------------------------------------------------------------------ chrome events -> relay
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attached.has(source.tabId)) return;
  if (method === 'Fetch.requestPaused' && !source.sessionId) {
    net.onPaused(source.tabId, params).then((handled) => { if (!handled) forward('chrome.debugger.onEvent', [source, method, params]); });
    return;
  }
  net.onCdpEvent(source.tabId, method, params);
  forward('chrome.debugger.onEvent', [source, method, params]);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  refreshBadge();
  forward('chrome.debugger.onDetach', [source, reason]);
  // The user pressed "Cancel" on Chrome's "is debugging this browser" bar: treat as Stop.
  if (reason === 'canceled_by_user') { sendObj({ t: 'stop' }); void detachAll(); }
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && attached.has(tab.openerTabId)) { agentTabs.add(tab.id); void addToGroup(tab.id); }
  forward('chrome.tabs.onCreated', [tab]);
});
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); agentTabs.delete(tabId); forward('chrome.tabs.onRemoved', [tabId]); refreshBadge(); });

function forward(method, params) { if (live.ws) sendObj({ method, params }); }

// ------------------------------------------------------------------ connection
function closeWs(reason) {
  const ws = live.ws;
  live.ws = null; live.mode = null;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  try { ws?.close(1000, reason); } catch {}
}

// Flygo Chat desktop on this machine (signed in) answers on 127.0.0.1:47800 for pairing only.
const LOCAL_APP = 'http://127.0.0.1:47800';
async function localApp() {
  try {
    const r = await fetch(`${LOCAL_APP}/flygo/hello`, { signal: AbortSignal.timeout(1500), cache: 'no-store', headers: { 'X-Flygo-Bridge': chrome.runtime.id } });
    const j = r.ok ? await r.json() : null;
    if (j?.role !== 'pairing' || !j.server) return null;
    // Flygo Chat may be signed in to several servers; only those with the Gateway bridge can take this browser.
    const list = Array.isArray(j.servers) && j.servers.length ? j.servers : [{ url: j.server, current: true }];
    j.choices = [];
    for (const x of list) if (x?.url && await hasBridge(String(x.url))) j.choices.push({ url: String(x.url).replace(/\/+$/, ''), name: x.name || '', current: !!x.current });
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
    const r = await fetch(`${server.replace(/\/+$/, '')}/__apps/gateway/healthz`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    ok = r.ok && (await r.json().catch(() => null))?.ok === true;
  } catch {}
  bridgeCache.set(server, { ok, at: Date.now() });
  return ok;
}

/** Server to pair with: the one chosen before, else the app's open server, else the first with a bridge. */
function pickServer(app, wanted) {
  const c = app?.choices || [];
  return (wanted && c.find((x) => x.url === wanted)) || (st.lastServer && c.find((x) => x.url === st.lastServer)) || c.find((x) => x.current) || c[0] || null;
}

/** Pair with the Flygo Chat app signed in on this machine (no sign-in needed). */
async function pairLocal(wanted) {
  const app = live.localApp || await localApp();
  const target = pickServer(app, wanted);
  if (!target) throw new Error('Flygo Chat trên máy chưa đăng nhập máy chủ nào có bridge');
  const r = await fetch(`${LOCAL_APP}/flygo/pair`, {
    method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json', 'X-Flygo-Bridge': chrome.runtime.id },
    body: JSON.stringify({ server: target.url, client: await browserInfo(), replace: st.pairings[target.url]?.browser_id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token || !j.ws_url) throw new Error(j.error || `Flygo Chat từ chối ghép (${r.status})`);
  const server = String(j.server).replace(/\/+$/, '');
  st.pairings[server] = { browser_id: j.client?.id, token: j.token, name: j.client?.name, slug: j.client?.slug };
  st.direct = { server, ws_url: j.ws_url, user: j.user || null };
  st.lastServer = server;
  st.noAutoPair = false;
  if (!st.name && j.client?.name) st.name = j.client.name;
  await save();
  live.notice = { text: `Đã kết nối qua Flygo Chat trên máy này (${j.user || 'tài khoản của bạn'}).`, at: Date.now() };
}

async function tick() {
  await loaded;
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (st.disabled) { if (live.ws) closeWs('disabled'); return render(); }
  if (live.connecting || live.ws || live.pairing) return render();
  if (st.direct?.ws_url && st.pairings[st.direct.server]?.token) return connect('direct');
  // Not signed in: if Flygo Chat runs on this machine, pair with it automatically.
  const app = await localApp();
  live.localApp = app;
  if (app?.supported && !st.noAutoPair && !live.pairing) {
    live.pairing = true;
    try { await pairLocal(); return connect('direct'); }
    catch (e) { live.lastError = String(e?.message || e); }
    finally { live.pairing = false; }
  }
  render();
  tickTimer = setTimeout(() => void tick(), 5000);
}

function connect(mode) {
  live.connecting = true;
  const url = st.direct.ws_url;
  let ws;
  try { ws = new WebSocket(url); } catch (e) { live.connecting = false; live.lastError = String(e?.message || e); return void setTimeout(tick, 5000); }
  ws.onopen = async () => {
    live.connecting = false;
    live.ws = ws; live.mode = mode; live.lastError = null;
    const info = await browserInfo();
    ws.send(JSON.stringify({
      t: 'hello', token: st.pairings[st.direct.server]?.token,
      client: { type: 'extension', kind: 'browser', name: st.name || info.engine, version: VERSION, engine: info.engine, os: info.os },
      tools: DECLARED_TOOLS, capabilities: ['cdp'], exclusive: true, info,
    }));
    pingTimer = setInterval(() => { live.pingAt = Date.now(); sendObj({ t: 'ping' }); }, PING_MS);
    render();
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = joinPart(JSON.parse(ev.data)); } catch { return; }
    if (!m) return;
    if (m.t) return onFlygo(m, mode);
    if (m.id !== undefined && m.method) {
      rpc(m.method, m.params).then((result) => sendObj({ id: m.id, result: result ?? {} }), (e) => sendObj({ id: m.id, error: { message: String(e?.message || e) } }));
    }
  };
  ws.onclose = (ev) => {
    live.connecting = false;
    if (live.ws === ws) { live.ws = null; live.mode = null; if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }
    if (ev.code === 4401 || ev.code === 4403) { live.lastError = 'Đã bị gỡ khỏi tài khoản. Bấm Kết nối để nối lại.'; st.direct = null; st.noAutoPair = true; void save(); }
    live.control = {};
    void detachAll();
    render();
    setTimeout(() => void tick(), 3000 + Math.random() * 3000);
  };
  ws.onerror = () => { live.lastError = 'Không nối được máy chủ Flygo, đang thử lại…'; };
}

function onFlygo(m, mode) {
  const server = m.server || (mode === 'direct' ? st.direct?.server : null);
  switch (m.t) {
    case 'pong': if (live.pingAt) { live.rtt = Date.now() - live.pingAt; sendObj({ t: 'rtt', ms: live.rtt }); } break;
    case 'welcome': {
      const c = m.client || m.browser;
      if (c && server) {
        st.pairings[server] = { ...st.pairings[server], browser_id: c.id, name: c.name, slug: c.slug };
        if (!st.name) st.name = c.name;
        live.servers = [{ server, state: 'online', user: st.direct?.user || null }];
        void save();
      }
      if (m.latest_version && newer(m.latest_version, VERSION)) live.update = { latest_version: m.latest_version, download_url: m.download_url };
      break;
    }
    case 'status': live.servers = m.servers || []; break;
    case 'paired':
      if (m.pairing) st.pairings[m.server] = { ...st.pairings[m.server], ...m.pairing };
      else delete st.pairings[m.server];
      if (m.pairing?.name && !st.name) st.name = m.pairing.name;
      void save();
      break;
    case 'renamed':
      if (server) st.pairings[server] = { ...st.pairings[server], name: m.name, slug: m.slug };
      st.name = m.name;
      void save();
      break;
    case 'revoked':
      if (server) delete st.pairings[server];
      if (mode === 'direct') { st.direct = null; closeWs('revoked'); }
      void save();
      break;
    case 'control':
      if (m.active) live.control[server || '?'] = { agent: m.agent, machine: m.machine, since: Date.now(), taken_from: m.taken_from };
      else delete live.control[server || '?'];
      refreshBadge();
      break;
    case 'update': if (m.required || (m.latest_version && newer(m.latest_version, VERSION))) live.update = m; break;
    case 'notice': live.notice = { text: m.text, at: Date.now() }; break;
    case 'error': live.lastError = m.message || m.code; if (m.code === 'outdated') live.update = { required: true, download_url: m.download_url }; break;
  }
  render();
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// ------------------------------------------------------------------ badge + popup
function refreshBadge() {
  const active = Object.keys(live.control).length > 0;
  const color = active ? '#ff2bd6' : live.ws ? '#00f0ff' : '#555a6b';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: active ? 'AI' : live.ws ? ' ' : '' });
  chrome.action.setTitle({ title: active ? `Flygo Browser Bridge: ${Object.values(live.control)[0].agent} is controlling` : live.ws ? 'Flygo Browser Bridge: connected' : 'Flygo Browser Bridge: not connected' });
}

async function snapshot() {
  await loaded;
  return {
    version: VERSION, name: st.name, disabled: st.disabled, mode: live.mode, connecting: live.connecting, servers: live.servers,
    pairings: Object.fromEntries(Object.entries(st.pairings).map(([k, v]) => [k, { name: v.name, slug: v.slug, browser_id: v.browser_id }])),
    control: live.control, attached: attached.size, agentTabs: agentTabs.size, rtt: live.rtt, lastError: live.lastError,
    update: live.update, notice: live.notice && Date.now() - live.notice.at < 60_000 ? live.notice : null,
    direct: st.direct ? { server: st.direct.server, user: st.direct.user || null } : null, net: await net.summary(),
    localApp: live.localApp ? { server: live.localApp.server, user: live.localApp.user, supported: !!live.localApp.supported, choices: live.localApp.choices || [] } : null,
    lastServer: st.lastServer || null,
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
        sendObj({ t: 'rename', name });
        return snapshot();
      }
      case 'stop': sendObj({ t: 'stop' }); await detachAll(); live.control = {}; render(); return snapshot();
      case 'share_tab': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) { agentTabs.add(tab.id); void addToGroup(tab.id); forward('chrome.tabs.onCreated', [{ ...tab, openerTabId: undefined, flygoShared: true }]); }
        return snapshot();
      }
      case 'toggle': st.disabled = !st.disabled; await save(); if (st.disabled) { closeWs('disabled'); await detachAll(); } void tick(); return snapshot();
      case 'login': await login(String(msg.server || '')); void tick(); return snapshot();
      case 'logout': if (st.direct) { delete st.pairings[st.direct.server]; st.direct = null; st.noAutoPair = true; await save(); closeWs('logout'); } return snapshot();
      case 'pair_local': st.noAutoPair = false; await save(); live.localApp = await localApp(); await pairLocal(msg.server || null); void tick(); return snapshot();
    }
  })().then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

// ------------------------------------------------------------------ direct-mode sign-in (no runner on this machine)
async function login(serverInput) {
  let server = serverInput.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(server)) server = `https://${server}`;
  const u = new URL(server);
  if (u.protocol !== 'https:') throw new Error('The server must use https');
  server = u.origin;
  const verifier = randomId() + randomId();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomId();
  const redirect = chrome.identity.getRedirectURL('cb');
  const start = `${server}/__apps/gateway/login?${new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, state })}`;
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url: start, interactive: true }));
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in state mismatch');
  if (back.searchParams.get('error')) throw new Error(back.searchParams.get('error'));
  const r = await fetch(`${server}/__apps/gateway/api/pair-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: back.searchParams.get('code'), code_verifier: verifier, client: { type: 'extension', kind: 'browser', ...(await browserInfo()) }, replace: st.pairings[server]?.browser_id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || `Sign-in failed (${r.status})`);
  const c = j.client || j.browser;
  st.pairings[server] = { browser_id: c.id, token: j.token, name: c.name, slug: c.slug };
  st.direct = { server, ws_url: j.ws_url, user: j.user?.name || null };
  st.lastServer = server;
  st.noAutoPair = false;
  if (!st.name) st.name = c.name;
  await save();
  live.notice = { text: `Signed in to ${u.host} as ${j.user?.name || 'you'}.`, at: Date.now() };
}
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// ------------------------------------------------------------------ lifecycle
chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') void tick(); if (a.name === 'net-retention') void net.retention(); });
chrome.alarms.create('net-retention', { periodInMinutes: 30 });
chrome.runtime.onStartup.addListener(() => void tick());
chrome.runtime.onInstalled.addListener(() => void tick());
// For debugging from chrome://extensions (inspect service worker).
globalThis.__flygo = { st, live, net, attached };
void tick();
