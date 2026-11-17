// Flygo Browser Bridge: service worker.
// Exposes this browser to the user's own Flygo AI agents through the Flygo Gateway WebSocket bridge
// (<server>/__apps/gateway/ws), the way the Playwright MCP Bridge extension does locally: the extension runs chrome.debugger /
// chrome.tabs calls for a CDP relay (capability "cdp"; Playwright runs on the server) and streams the events back. It also
// declares the tools it runs itself (network log / rules / download). It connects to EVERY Flygo server it is paired with
// (Flygo Chat on this machine signed in to several servers → one connection per server that has the bridge); each server's
// agents work in the tabs they opened.
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
  servers: {},          // server url -> {ws_url, user}: servers this browser connects to
  blocked: {},          // server url -> true: removed / signed out, don't pair again by itself until the user asks
  disabled: false,      // user pressed "Disconnect"
};
const live = { control: {}, lastError: null, update: null, notice: null, localApp: null, pairing: false };
const conns = new Map();      // server url -> {ws, state, rtt, pingAt, pingTimer, error}
const attached = new Set();   // tab ids with the debugger attached (any server)
const tabOwner = new Map();   // tab id -> server url whose agent controls it
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
function sendTo(c, obj) {
  const ws = c?.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const s = JSON.stringify(obj);
  if (s.length <= PART) return ws.send(s);
  const k = `e${++partSeq}`, n = Math.ceil(s.length / PART);
  for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: 'part', k, i, n, d: s.slice(i * PART, (i + 1) * PART) }));
}
const sendAll = (obj) => { for (const c of conns.values()) sendTo(c, obj); };
function joinPart(m) {
  if (m?.t !== 'part') return m;
  let p = parts.get(m.k);
  if (!p) parts.set(m.k, (p = { n: m.n, got: 0, d: [] }));
  if (p.d[m.i] === undefined) { p.d[m.i] = m.d; p.got++; }
  if (p.got < p.n) return null;
  parts.delete(m.k);
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

async function rpc(server, method, params) {
  switch (method) {
    case 'chrome.debugger.attach': {
      const [target, ver] = params;
      const owner = tabOwner.get(target.tabId);
      if (attached.has(target.tabId) && owner && owner !== server) throw new Error('Tab đang được agent của máy chủ khác điều khiển');
      if (!attached.has(target.tabId)) await chrome.debugger.attach(target, ver || '1.3');
      attached.add(target.tabId);
      tabOwner.set(target.tabId, server);
      await net.onAttach(target.tabId);
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
      // Playwright's own Fetch interception is merged with our network rules (one debugger session per tab).
      if (!target.sessionId && (m === 'Fetch.enable' || m === 'Fetch.disable')) return net.pwFetch(target.tabId, m, p);
      return await chrome.debugger.sendCommand(target, m, p);
    }
    case 'chrome.tabs.create': {
      const [opts] = params;
      const tab = await chrome.tabs.create({ url: opts?.url || 'about:blank', active: !!opts?.active });
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
    case 'tools/call': return await callDeclared(params?.name, params?.arguments || {});
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
  const c = { server, ws: null, state: 'connecting', rtt: null, pingAt: 0, pingTimer: null, error: null };
  conns.set(server, c);
  let ws;
  try { ws = new WebSocket(info.ws_url); } catch (e) { c.state = 'error'; c.error = String(e?.message || e); conns.delete(server); return; }
  c.ws = ws;
  ws.onopen = async () => {
    c.state = 'open'; c.error = null;
    const bi = await browserInfo();
    ws.send(JSON.stringify({
      t: 'hello', token: st.pairings[server]?.token,
      client: { type: 'extension', kind: 'browser', name: st.name || bi.engine, version: VERSION, engine: bi.engine, os: bi.os },
      tools: DECLARED_TOOLS, capabilities: ['cdp'], exclusive: true, info: bi,
    }));
    c.pingTimer = setInterval(() => { c.pingAt = Date.now(); sendTo(c, { t: 'ping' }); }, PING_MS);
    render();
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = joinPart(JSON.parse(ev.data)); } catch { return; }
    if (!m) return;
    if (m.t) return onFlygo(c, m);
    if (m.id !== undefined && m.method) {
      rpc(server, m.method, m.params).then((result) => sendTo(c, { id: m.id, result: result ?? {} }), (e) => sendTo(c, { id: m.id, error: { message: String(e?.message || e) } }));
    }
  };
  ws.onclose = (ev) => {
    if (conns.get(server) !== c) return;
    conns.delete(server);
    if (c.pingTimer) clearInterval(c.pingTimer);
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
      break;
    }
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
    case 'control':
      if (m.active) live.control[server] = { agent: m.agent, machine: m.machine, since: Date.now(), taken_from: m.taken_from };
      else delete live.control[server];
      refreshBadge();
      break;
    case 'update': if (m.required || (m.latest_version && newer(m.latest_version, VERSION))) live.update = m; break;
    case 'notice': live.notice = { text: m.text, at: Date.now() }; break;
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
    return { server, user: info?.user || null, state: c ? (c.state === 'open' ? 'online' : 'connecting') : 'offline', rtt: c?.rtt ?? null, error: c?.error ?? null, slug: st.pairings[server]?.slug || null };
  });
  return {
    version: VERSION, name: st.name, disabled: st.disabled, connected: openConns().length, servers,
    pairings: Object.fromEntries(Object.entries(st.pairings).map(([k, v]) => [k, { name: v.name, slug: v.slug, browser_id: v.browser_id }])),
    control: live.control, attached: attached.size, agentTabs: agentTabs.size, lastError: live.lastError,
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
      case 'share_tab': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) { agentTabs.add(tab.id); void addToGroup(tab.id); sendAll({ method: 'chrome.tabs.onCreated', params: [{ ...tab, openerTabId: undefined, flygoShared: true }] }); }
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
