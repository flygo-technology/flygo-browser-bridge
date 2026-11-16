// Flygo Browser Bridge: service worker.
// Exposes this browser to the user's own Flygo AI agents, the same way the Playwright MCP Bridge extension does:
// the extension runs chrome.debugger / chrome.tabs calls sent by a CDP relay and streams the events back.
//   - Local mode (preferred): a flygo-agent runner on this machine listens on 127.0.0.1:47800; the extension finds it
//     and connects automatically. Playwright, network logs and network rules run on this machine.
//   - Direct mode (fallback, no runner on this machine): the extension signs in to a Flygo server and connects to
//     <server>/__apps/browser/ws; Playwright then runs on the server.
// Network logging and network rules always run inside this browser (net.js); agents read and set them through tools.
import { Net } from './net.js';

const VERSION = chrome.runtime.getManifest().version;
const HUB = 'http://127.0.0.1:47800';
const HUB_WS = 'ws://127.0.0.1:47800/ext';
const PING_MS = 20_000;
const PART = 200_000;

// ------------------------------------------------------------------ state
const st = {
  extId: null,          // random id of this browser profile (stable)
  name: '',             // display name chosen by the user
  pairings: {},         // server url -> {browser_id, token, name, slug}
  direct: null,         // {server, ws_url} for direct mode
  disabled: false,      // user pressed "Disconnect"
};
const live = {
  ws: null, mode: null, hub: null, servers: [], control: {}, lastError: null, update: null, notice: null,
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
  const s = await chrome.storage.local.get(['extId', 'name', 'pairings', 'direct', 'disabled']);
  st.extId = s.extId || randomId();
  st.name = s.name || '';
  st.pairings = s.pairings || {};
  st.direct = s.direct || null;
  st.disabled = !!s.disabled;
  if (!s.extId) await chrome.storage.local.set({ extId: st.extId });
})();
const save = () => chrome.storage.local.set({ name: st.name, pairings: st.pairings, direct: st.direct, disabled: st.disabled });

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
    case 'flygo.detachAll': await detachAll(); return { ok: true };
    case 'flygo.fetch': return await fetchForAgent(params?.url, params?.max_bytes);
    default:
      if (method.startsWith('flygo.net.')) return await net.handle(method.slice('flygo.net.'.length), params || {});
      throw new Error(`unsupported: ${method}`);
  }
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
async function hubHello() {
  try {
    const r = await fetch(`${HUB}/flygo/hello`, { signal: AbortSignal.timeout(1500), cache: 'no-store', headers: { 'X-Flygo-Bridge': chrome.runtime.id } });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.role === 'browser-hub' ? j : null;
  } catch { return null; }
}

function closeWs(reason) {
  const ws = live.ws;
  live.ws = null; live.mode = null;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  try { ws?.close(1000, reason); } catch {}
}

async function tick() {
  await loaded;
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (st.disabled) { if (live.ws) closeWs('disabled'); return render(); }
  if (live.connecting) return;
  if (live.ws && live.mode === 'local') return;
  const hub = await hubHello();
  if (hub) {
    if (live.ws) closeWs('switching to local');
    return connect('local', hub);
  }
  live.hub = null;
  if (!live.ws && st.direct?.ws_url && st.pairings[st.direct.server]?.token) return connect('direct');
  render();
  // Keep looking while the service worker is alive; the alarm wakes it up again otherwise.
  tickTimer = setTimeout(() => void tick(), live.ws ? 30_000 : 3000);
}

function connect(mode, hub) {
  live.connecting = true;
  const url = mode === 'local' ? HUB_WS : st.direct.ws_url;
  let ws;
  try { ws = new WebSocket(url); } catch (e) { live.connecting = false; live.lastError = String(e?.message || e); return void setTimeout(tick, 5000); }
  ws.onopen = async () => {
    live.connecting = false;
    live.ws = ws; live.mode = mode; live.hub = hub ?? null; live.lastError = null;
    const info = await browserInfo();
    if (mode === 'local') ws.send(JSON.stringify({ t: 'hello', ext_id: st.extId, ext_version: VERSION, info, pairings: st.pairings }));
    else ws.send(JSON.stringify({ t: 'hello', token: st.pairings[st.direct.server]?.token, ext_version: VERSION, info }));
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
    if (ev.code === 4401 && mode === 'direct') { live.lastError = 'Sign-in expired or removed. Sign in again.'; st.direct = null; void save(); }
    live.control = {};
    void detachAll();
    render();
    setTimeout(() => void tick(), mode === 'local' ? 1000 + Math.random() * 2000 : 5000);
  };
  ws.onerror = () => { live.lastError = mode === 'local' ? null : 'Cannot reach the Flygo server'; };
}

function onFlygo(m, mode) {
  const server = m.server || (mode === 'direct' ? st.direct?.server : null);
  switch (m.t) {
    case 'pong': if (live.pingAt) { live.rtt = Date.now() - live.pingAt; sendObj({ t: 'rtt', ms: live.rtt }); } break;
    case 'welcome':
      if (mode === 'local') { live.hub = { ...(live.hub || {}), ...(m.hub || {}) }; live.servers = m.servers || []; }
      else if (m.browser && server) {
        st.pairings[server] = { ...st.pairings[server], browser_id: m.browser.id, name: m.browser.name, slug: m.browser.slug };
        if (!st.name) st.name = m.browser.name;
        live.servers = [{ server, state: 'online', user: st.direct?.user || null }];
        void save();
      }
      if (m.latest_version && newer(m.latest_version, VERSION)) live.update = { latest_version: m.latest_version, download_url: m.download_url };
      break;
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
    case 'error': live.lastError = m.message || m.code; break;
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
    version: VERSION, name: st.name, disabled: st.disabled, mode: live.mode, connecting: live.connecting, hub: live.hub, servers: live.servers,
    pairings: Object.fromEntries(Object.entries(st.pairings).map(([k, v]) => [k, { name: v.name, slug: v.slug, browser_id: v.browser_id }])),
    control: live.control, attached: attached.size, agentTabs: agentTabs.size, rtt: live.rtt, lastError: live.lastError,
    update: live.update, notice: live.notice && Date.now() - live.notice.at < 60_000 ? live.notice : null,
    direct: st.direct ? { server: st.direct.server, user: st.direct.user || null } : null, net: await net.summary(),
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
      case 'logout': if (st.direct) { delete st.pairings[st.direct.server]; st.direct = null; await save(); closeWs('logout'); } return snapshot();
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
  const start = `${server}/__apps/browser/login?${new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, state })}`;
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url: start, interactive: true }));
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in state mismatch');
  if (back.searchParams.get('error')) throw new Error(back.searchParams.get('error'));
  const r = await fetch(`${server}/__apps/browser/api/pair-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: back.searchParams.get('code'), code_verifier: verifier, browser: await browserInfo(), replace: st.pairings[server]?.browser_id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || `Sign-in failed (${r.status})`);
  st.pairings[server] = { browser_id: j.browser.id, token: j.token, name: j.browser.name, slug: j.browser.slug };
  st.direct = { server, ws_url: j.ws_url, user: j.user?.name || null };
  if (!st.name) st.name = j.browser.name;
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
