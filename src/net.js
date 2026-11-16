// Network log and network rules. Everything runs inside this browser and is stored here (IndexedDB + chrome.storage);
// nothing is streamed to agents. Agents read and change it on demand through the browser_net_* tools.
//   - Log: chrome.webRequest records every request of every tab (when enabled). Bodies are kept only for URLs matching
//     `capture_bodies`, and only on tabs the debugger is attached to (CDP Network.getResponseBody).
//   - Rules: block / redirect / header changes use declarativeNetRequest (all tabs, no debugger needed, persisted by Chrome).
//     fulfill / rewrite_body / delay_ms / script use CDP Fetch on tabs the debugger is attached to. Scripts run in a
//     sandboxed page (offscreen document) with no extension privileges.

const DEFAULT_CFG = { enabled: false, capture_bodies: [], max_entries: 20000, max_mb: 50, keep_hours: 24 };
const BODY_MAX = 100 * 1024;
const FETCH_ACTIONS = ['fulfill', 'rewrite_body', 'delay_ms', 'script'];
const DNR_ACTIONS = ['block', 'redirect', 'request_headers', 'response_headers'];

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('flygo-net', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const s = db.createObjectStore('log', { keyPath: 'id' });
      s.createIndex('at', 'at');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction('log', mode);
  const out = fn(t.objectStore('log'));
  t.oncomplete = () => resolve(out);
  t.onerror = () => reject(t.error);
});

/** "*://api.example.com/v1/*" or "/regex/flags" -> RegExp */
export function toRegex(pattern) {
  const p = String(pattern || '*');
  const m = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (m) return new RegExp(m[1], m[2]);
  return new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
const clip = (s, n = BODY_MAX) => (typeof s === 'string' && s.length > n ? { text: s.slice(0, n), truncated: true, size: s.length } : s);
const hdrs = (list) => Object.fromEntries((list || []).map((h) => [h.name, h.value ?? '']));
const statusOk = (want, st) => {
  if (!want) return true;
  const w = String(want).trim();
  if (/^\dxx$/i.test(w)) return Math.floor(st / 100) === Number(w[0]);
  const m = /^(>=|<=|>|<)?\s*(\d{3})$/.exec(w);
  if (!m) return true;
  const n = Number(m[2]);
  return m[1] === '>=' ? st >= n : m[1] === '<=' ? st <= n : m[1] === '>' ? st > n : m[1] === '<' ? st < n : st === n;
};

export class Net {
  constructor({ debuggerSend, attachedTabs }) {
    this.send = debuggerSend;
    this.attachedTabs = attachedTabs;
    this.cfg = { ...DEFAULT_CFG };
    this.rules = [];
    this.pending = new Map();   // webRequest requestId -> entry
    this.recent = new Map();    // `${tab}|${url}` -> log id (to attach bodies captured over CDP)
    this.queue = [];
    this.flushTimer = null;
    this.pw = new Map();        // tabId -> Playwright's Fetch.enable patterns
    this.seq = 0;
    this.count = 0;
    this.dbp = idb();
    this.ready = chrome.storage.local.get(['netcfg', 'netrules', 'netcount']).then((s) => {
      this.cfg = { ...DEFAULT_CFG, ...(s.netcfg || {}) };
      this.rules = s.netrules || [];
      this.count = s.netcount || 0;
      this.captureRx = this.cfg.capture_bodies.map((p) => { try { return toRegex(p); } catch { return null; } }).filter(Boolean);
    });
    this.listen();
  }

  // ---------------------------------------------------------------- webRequest log
  listen() {
    const f = { urls: ['<all_urls>'] };
    chrome.webRequest.onBeforeRequest.addListener((d) => {
      if (!this.cfg.enabled) return;
      let body;
      if (d.requestBody?.formData) body = JSON.stringify(d.requestBody.formData);
      else if (d.requestBody?.raw?.[0]?.bytes) { try { body = new TextDecoder().decode(d.requestBody.raw[0].bytes); } catch {} }
      this.pending.set(d.requestId, { id: `${Date.now().toString(36)}-${(++this.seq).toString(36)}`, at: Date.now(), tab: d.tabId, method: d.method, url: d.url, type: d.type, initiator: d.initiator || null, req_body: clip(body) });
    }, f, ['requestBody']);
    chrome.webRequest.onSendHeaders.addListener((d) => { const e = this.pending.get(d.requestId); if (e) e.req_headers = hdrs(d.requestHeaders); }, f, ['requestHeaders', 'extraHeaders']);
    chrome.webRequest.onHeadersReceived.addListener((d) => { const e = this.pending.get(d.requestId); if (e) { e.status = d.statusCode; e.res_headers = hdrs(d.responseHeaders); } }, f, ['responseHeaders', 'extraHeaders']);
    chrome.webRequest.onCompleted.addListener((d) => this.done(d, null), f);
    chrome.webRequest.onErrorOccurred.addListener((d) => this.done(d, d.error), f);
  }
  done(d, error) {
    const e = this.pending.get(d.requestId);
    if (!e) return;
    this.pending.delete(d.requestId);
    e.status = d.statusCode ?? e.status ?? 0;
    e.ms = Date.now() - e.at;
    e.from_cache = !!d.fromCache;
    e.ip = d.ip || null;
    if (error) e.error = error;
    this.recent.set(`${e.tab}|${e.url}`, e.id);
    if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value);
    this.queue.push(e);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 500);
  }
  async flush() {
    this.flushTimer = null;
    const batch = this.queue.splice(0);
    if (!batch.length) return;
    const db = await this.dbp;
    await tx(db, 'readwrite', (s) => { for (const e of batch) s.put(e); });
    this.count += batch.length;
    if (this.count > this.cfg.max_entries) await this.trim(this.count - this.cfg.max_entries);
    await chrome.storage.local.set({ netcount: this.count });
  }
  async trim(n) {
    const db = await this.dbp;
    let removed = 0;
    await tx(db, 'readwrite', (s) => {
      const req = s.index('at').openCursor();
      req.onsuccess = () => { const c = req.result; if (!c || removed >= n) return; c.delete(); removed++; c.continue(); };
    });
    this.count = Math.max(0, this.count - removed);
  }
  async retention() {
    await this.ready;
    const db = await this.dbp;
    const before = Date.now() - this.cfg.keep_hours * 3600_000;
    let removed = 0;
    await tx(db, 'readwrite', (s) => {
      const req = s.index('at').openCursor(IDBKeyRange.upperBound(before));
      req.onsuccess = () => { const c = req.result; if (!c) return; c.delete(); removed++; c.continue(); };
    });
    this.count = Math.max(0, this.count - removed);
    // Rough size cap: if over max_mb, drop the oldest quarter.
    const est = await navigator.storage?.estimate?.();
    if (est?.usage && est.usage > this.cfg.max_mb * 1024 * 1024) await this.trim(Math.ceil(this.count / 4));
    await chrome.storage.local.set({ netcount: this.count });
    // Expired rules.
    const live = this.rules.filter((r) => !r.expires_at || r.expires_at > Date.now());
    if (live.length !== this.rules.length) { this.rules = live; await this.apply(); }
  }

  // ---------------------------------------------------------------- CDP (attached tabs)
  onCdpEvent(tabId, method, params) {
    if (!this.cfg.enabled || !this.captureRx?.length) return;
    if (method === 'Network.responseReceived') {
      const url = params.response?.url;
      if (url && this.captureRx.some((r) => r.test(url))) (this.want ||= new Map()).set(params.requestId, { url, tabId });
    } else if (method === 'Network.loadingFinished' && this.want?.has(params.requestId)) {
      const w = this.want.get(params.requestId);
      this.want.delete(params.requestId);
      setTimeout(() => void this.captureBody(w.tabId, params.requestId, w.url), 50);
    }
  }
  async captureBody(tabId, requestId, url) {
    try {
      const r = await this.send(tabId, 'Network.getResponseBody', { requestId });
      const body = r.base64Encoded ? `[base64] ${r.body}` : r.body;
      await this.flush();
      const id = this.recent.get(`${tabId}|${url}`);
      if (!id) return;
      const db = await this.dbp;
      await tx(db, 'readwrite', (s) => { const g = s.get(id); g.onsuccess = () => { if (g.result) s.put({ ...g.result, res_body: clip(body) }); }; });
    } catch {}
  }

  /** Playwright wants Fetch interception on this tab too: merge its patterns with ours. */
  async pwFetch(tabId, method, params) {
    if (method === 'Fetch.disable') this.pw.delete(tabId);
    else this.pw.set(tabId, params?.patterns?.length ? params.patterns : [{ urlPattern: '*' }]);
    await this.enableFetch(tabId);
    return {};
  }
  ourFetchPatterns() {
    const out = [];
    for (const r of this.rules) {
      const kind = Object.keys(r.action).find((k) => FETCH_ACTIONS.includes(k));
      if (!kind) continue;
      const stage = (r.action.stage || (kind === 'rewrite_body' ? 'response' : 'request')) === 'response' ? 'Response' : 'Request';
      const url = r.match.url && !/^\//.test(r.match.url) ? r.match.url : '*';
      out.push({ urlPattern: url, requestStage: stage });
    }
    return out;
  }
  async enableFetch(tabId) {
    const patterns = [...this.ourFetchPatterns(), ...(this.pw.get(tabId) || [])];
    try {
      if (patterns.length) await this.send(tabId, 'Fetch.enable', { patterns });
      else await this.send(tabId, 'Fetch.disable', {});
    } catch {}
  }
  async onAttach(tabId) { await this.ready; if (this.ourFetchPatterns().length) await this.enableFetch(tabId); }

  /** Fetch.requestPaused: true when handled here (not forwarded to Playwright). */
  async onPaused(tabId, p) {
    await this.ready;
    const stage = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined ? 'response' : 'request';
    const rule = this.rules.find((r) => {
      const kind = Object.keys(r.action).find((k) => FETCH_ACTIONS.includes(k));
      if (!kind || (r.expires_at && r.expires_at < Date.now())) return false;
      const want = r.action.stage || (kind === 'rewrite_body' ? 'response' : 'request');
      return want === stage && this.matches(r.match, tabId, p.request.url, p.request.method, p.resourceType);
    });
    const go = (m, params) => this.send(tabId, m, { requestId: p.requestId, ...params }).catch(() => {});
    if (!rule) {
      if (this.pw.has(tabId)) return false; // Playwright's interception
      await go(stage === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {});
      return true;
    }
    rule.hits = (rule.hits || 0) + 1;
    this.saveSoon();
    const a = rule.action;
    try {
      if (a.fulfill) {
        const body = a.fulfill.body_base64 ?? btoa(unescape(encodeURIComponent(String(a.fulfill.body ?? ''))));
        await go('Fetch.fulfillRequest', { responseCode: a.fulfill.status || 200, responseHeaders: Object.entries(a.fulfill.headers || {}).map(([name, value]) => ({ name, value: String(value) })), body });
      } else if (a.delay_ms) {
        await new Promise((r) => setTimeout(r, Math.min(Number(a.delay_ms) || 0, 30_000)));
        await go(stage === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {});
      } else if (a.rewrite_body) {
        const orig = await this.send(tabId, 'Fetch.getResponseBody', { requestId: p.requestId });
        const text = orig.base64Encoded ? decodeURIComponent(escape(atob(orig.body))) : orig.body;
        const rw = a.rewrite_body;
        const out = rw.regex ? text.replace(new RegExp(rw.find, rw.all === false ? '' : 'g'), rw.replace ?? '') : rw.all === false ? text.replace(rw.find, rw.replace ?? '') : text.split(rw.find).join(rw.replace ?? '');
        await go('Fetch.fulfillRequest', { responseCode: p.responseStatusCode || 200, responseHeaders: (p.responseHeaders || []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name)), body: btoa(unescape(encodeURIComponent(out))) });
      } else if (a.script) {
        await this.runScript(tabId, p, stage, a.script, go);
      }
    } catch (e) {
      rule.last_error = String(e?.message || e);
      await go(stage === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {});
    }
    return true;
  }

  async runScript(tabId, p, stage, code, go) {
    const req = { url: p.request.url, method: p.request.method, headers: p.request.headers || {}, body: p.request.postData, resource_type: p.resourceType, stage };
    if (stage === 'response') {
      req.status = p.responseStatusCode;
      req.response_headers = hdrs(p.responseHeaders);
      try { const b = await this.send(tabId, 'Fetch.getResponseBody', { requestId: p.requestId }); req.response_body = b.base64Encoded ? atob(b.body) : b.body; } catch {}
    }
    const r = await sandboxRun(code, req);
    const cont = () => go(stage === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {});
    if (!r || typeof r !== 'object') return cont();
    const enc = (s) => btoa(unescape(encodeURIComponent(String(s ?? ''))));
    const toList = (o) => Object.entries(o || {}).map(([name, value]) => ({ name, value: String(value) }));
    if (r.block) return go('Fetch.failRequest', { errorReason: 'BlockedByClient' });
    if (r.fulfill) return go('Fetch.fulfillRequest', { responseCode: r.fulfill.status || 200, responseHeaders: toList(r.fulfill.headers), body: enc(r.fulfill.body) });
    if (stage === 'request' && (r.redirect || r.headers)) return go('Fetch.continueRequest', { ...(r.redirect ? { url: String(r.redirect) } : {}), ...(r.headers ? { headers: toList(r.headers) } : {}) });
    if (stage === 'response' && r.response) {
      return go('Fetch.fulfillRequest', { responseCode: r.response.status || req.status || 200,
        responseHeaders: r.response.headers ? toList(r.response.headers) : (p.responseHeaders || []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name)),
        body: enc(r.response.body ?? req.response_body ?? '') });
    }
    return cont();
  }

  matches(m, tabId, url, method, type) {
    if (m.tabs?.length && !m.tabs.includes(tabId)) return false;
    if (m.methods?.length && !m.methods.map((x) => x.toUpperCase()).includes(String(method).toUpperCase())) return false;
    if (m.types?.length && type && !m.types.map(cdpType).includes(String(type))) return false;
    try { return toRegex(m.url).test(url); } catch { return false; }
  }

  // ---------------------------------------------------------------- rules -> declarativeNetRequest
  saveSoon() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => chrome.storage.local.set({ netrules: this.rules }), 2000); }

  async apply() {
    await chrome.storage.local.set({ netrules: this.rules });
    const dyn = [], ses = [];
    this.rules.forEach((r, i) => {
      const kind = Object.keys(r.action).find((k) => DNR_ACTIONS.includes(k));
      if (!kind || (r.expires_at && r.expires_at < Date.now())) return;
      r.dnr_id = i + 1;
      const cond = {};
      if (/^\//.test(r.match.url)) cond.regexFilter = toRegex(r.match.url).source; else cond.urlFilter = r.match.url || '*';
      if (r.match.methods?.length) cond.requestMethods = r.match.methods.map((x) => x.toLowerCase());
      if (r.match.types?.length) cond.resourceTypes = r.match.types;
      if (r.match.tabs?.length) cond.tabIds = r.match.tabs;
      const hdr = (o) => [...Object.entries(o?.set || {}).map(([header, value]) => ({ header, operation: 'set', value: String(value) })), ...(o?.remove || []).map((header) => ({ header, operation: 'remove' }))];
      const action = kind === 'block' ? { type: 'block' }
        : kind === 'redirect' ? { type: 'redirect', redirect: { url: r.action.redirect } }
        : { type: 'modifyHeaders', ...(kind === 'request_headers' ? { requestHeaders: hdr(r.action.request_headers) } : { responseHeaders: hdr(r.action.response_headers) }) };
      (cond.tabIds ? ses : dyn).push({ id: r.dnr_id, priority: 1000 + i, condition: cond, action });
    });
    const oldDyn = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
    const oldSes = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldDyn, addRules: dyn });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: oldSes, addRules: ses });
    for (const t of this.attachedTabs()) await this.enableFetch(t);
  }

  normalize(input) {
    const match = input?.match, action = input?.action;
    if (!match || typeof match !== 'object' || typeof match.url !== 'string') throw new Error('match.url is required');
    if (!action || typeof action !== 'object') throw new Error('action is required');
    const kinds = Object.keys(action).filter((k) => [...DNR_ACTIONS, ...FETCH_ACTIONS].includes(k));
    if (kinds.length !== 1) throw new Error(`action needs exactly one of: ${[...DNR_ACTIONS, ...FETCH_ACTIONS].join(', ')}`);
    toRegex(match.url);
    if (action.script && typeof action.script !== 'string') throw new Error('script must be a string');
    return {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(input.name || '').slice(0, 80) || undefined,
      match: { url: match.url, methods: match.methods, types: match.types, tabs: match.tabs }, action,
      created_at: Date.now(), expires_at: input.ttl_sec ? Date.now() + Number(input.ttl_sec) * 1000 : null, hits: 0,
    };
  }

  // ---------------------------------------------------------------- tools
  async handle(op, a) {
    await this.ready;
    switch (op) {
      case 'logConfig': {
        const next = { ...this.cfg };
        if (typeof a.enabled === 'boolean') next.enabled = a.enabled;
        if (Array.isArray(a.capture_bodies)) { for (const p of a.capture_bodies) toRegex(p); next.capture_bodies = a.capture_bodies.map(String).slice(0, 50); }
        for (const k of ['max_entries', 'max_mb', 'keep_hours']) if (Number.isFinite(a[k]) && a[k] > 0) next[k] = Math.min(Number(a[k]), k === 'max_entries' ? 200000 : k === 'max_mb' ? 500 : 24 * 30);
        this.cfg = next;
        this.captureRx = next.capture_bodies.map((p) => toRegex(p));
        await chrome.storage.local.set({ netcfg: next });
        return { config: next, ...(await this.summary()) };
      }
      case 'log': return this.query(a);
      case 'request': {
        await this.flush();
        const db = await this.dbp;
        const e = await new Promise((resolve) => tx(db, 'readonly', (s) => { const g = s.get(String(a.id)); g.onsuccess = () => resolve(g.result); }));
        if (!e) throw new Error('no such request (it may have been trimmed)');
        const field = { request_headers: 'req_headers', response_headers: 'res_headers', request_body: 'req_body', response_body: 'res_body' }[a.part];
        if (a.part) return { id: e.id, [a.part]: e[field ?? a.part] ?? null, untrusted: true };
        return { ...e, untrusted: true };
      }
      case 'logClear': {
        const db = await this.dbp;
        const before = a.before ? Date.parse(a.before) || Number(a.before) : null;
        await tx(db, 'readwrite', (s) => {
          if (!before) { s.clear(); return; }
          const req = s.index('at').openCursor(IDBKeyRange.upperBound(before));
          req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
        });
        if (!before) this.count = 0;
        await chrome.storage.local.set({ netcount: this.count });
        return { ok: true, ...(await this.summary()) };
      }
      case 'ruleAdd': { const r = this.normalize(a); this.rules.push(r); await this.apply(); return { ok: true, id: r.id, rules: this.rules.length }; }
      case 'ruleSet': {
        const list = Array.isArray(a.rules) ? a.rules.map((x) => this.normalize(x)) : [];
        this.rules = list; await this.apply();
        return { ok: true, ids: list.map((r) => r.id) };
      }
      case 'ruleList': return { rules: this.rules.map(({ dnr_id, ...r }) => r), fetch_rules_need_attached_tab: true };
      case 'ruleRemove': {
        const n = this.rules.length;
        this.rules = a.all ? [] : this.rules.filter((r) => r.id !== a.id);
        await this.apply();
        return { ok: true, removed: n - this.rules.length };
      }
    }
    throw new Error(`unknown net op ${op}`);
  }

  async query(a) {
    await this.flush();
    const db = await this.dbp;
    const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200);
    const rx = a.url_regex ? new RegExp(a.url_regex) : null;
    const since = a.since ? Date.parse(a.since) || Number(a.since) : 0;
    const until = a.cursor ? Number(a.cursor) : a.until ? Date.parse(a.until) || Number(a.until) : Infinity;
    const out = [];
    let next = null;
    await tx(db, 'readonly', (s) => {
      const range = IDBKeyRange.bound(since, until === Infinity ? Number.MAX_SAFE_INTEGER : until, false, !!a.cursor);
      const req = s.index('at').openCursor(range, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const e = c.value;
        if ((!rx || rx.test(e.url)) && (!a.method || e.method === String(a.method).toUpperCase()) && statusOk(a.status, e.status)
          && (!a.type || e.type === a.type) && (a.tab === undefined || e.tab === a.tab)) {
          if (out.length >= limit) { next = String(e.at); return; }
          out.push({ id: e.id, at: new Date(e.at).toISOString(), tab: e.tab, method: e.method, status: e.status, url: e.url.length > 300 ? e.url.slice(0, 300) + '…' : e.url, type: e.type, ms: e.ms, error: e.error, body: !!e.res_body });
        }
        c.continue();
      };
    });
    return { entries: out, next_cursor: next, logging: this.cfg.enabled, untrusted: true };
  }

  async summary() {
    await this.ready;
    return { logging: this.cfg.enabled, entries: this.count, rules: this.rules.length };
  }
}

function cdpType(t) {
  return ({ main_frame: 'Document', sub_frame: 'Document', xmlhttprequest: 'XHR', script: 'Script', image: 'Image', stylesheet: 'Stylesheet', font: 'Font', media: 'Media', websocket: 'WebSocket', other: 'Other' })[t] || t;
}

// ---------------------------------------------------------------- sandbox for script rules
let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  offscreenReady ||= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['IFRAME_SCRIPTING'], justification: 'Run network rule scripts written by the agent in a sandboxed iframe' })
    .finally(() => { offscreenReady = null; });
  await offscreenReady;
}
async function sandboxRun(code, req) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'run', code, req });
  if (r?.error) throw new Error(r.error);
  return r?.result ?? null;
}
