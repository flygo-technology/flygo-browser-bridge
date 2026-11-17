// Passwords / OTP codes sent by the browser's owner through a one-time link (browser_ask_secret on the server).
// - request: one-time ECDH P-256 key pair made here; the server only gets the public key (it goes into the link's #fragment).
// - fill: the owner's page encrypts with that key (AES-GCM, AAD = request id); only this extension can decrypt. The value is
//   typed into the field the agent marked ([data-flygo-secret=id]) only if that field's frame is still on the requested origin.
// - vault: "remember on this browser" keeps the password per origin, encrypted with a non-extractable key held in IndexedDB.
const TTL = 5 * 60_000;
const pending = new Map(); // id -> {server, origin, kind, label, key, exp}

// ---------------------------------------------------------------- scrubbing
// Playwright's accessibility snapshot shows the value of password fields, and evaluate / network logs could too. Every message
// to the server is scrubbed of: values filled through links, remembered passwords, and the current values of password fields
// in the tabs the agent uses. Replaced with •••• before it leaves the browser.
const known = new Map(); // value -> expiry
const KEEP = 30 * 60_000;
export function addKnown(v, ms = KEEP) { if (typeof v === 'string' && v.length >= 4) known.set(v, Math.max(known.get(v) || 0, Date.now() + ms)); }
const forms = (v) => {
  const j = JSON.stringify(v).slice(1, -1);
  let b = '';
  try { b = btoa(String.fromCharCode(...new TextEncoder().encode(v))).replace(/=+$/, ''); } catch {}
  return [...new Set([v, j, JSON.stringify(j).slice(1, -1), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+'), b, b.replace(/\+/g, '-').replace(/\//g, '_')].filter((x) => x.length >= 4))];
};
export function scrub(str) {
  if (!known.size) return str;
  const now = Date.now();
  for (const [v, exp] of known) {
    if (exp < now) { known.delete(v); continue; }
    for (const f of forms(v)) if (f && str.includes(f)) str = str.split(f).join('••••');
  }
  return str;
}
function passwordValues() {
  const out = [];
  for (const i of document.querySelectorAll('input[type=password]')) if (i.value) out.push(i.value);
  return out;
}
const lastRead = new Map(); // tabId -> time
/** Learn the current password-field values of a tab (all frames). Throttled unless forced. */
export async function learnPasswords(tabId, force = false) {
  const now = Date.now();
  if (!force && now - (lastRead.get(tabId) || 0) < 300) return;
  lastRead.set(tabId, now);
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: passwordValues });
    for (const r of res) for (const v of r.result || []) addKnown(v);
  } catch {}
}
let vaultLoaded = false;
/** Remembered passwords count as known from the start (they may be filled without a link). */
export async function learnVault() {
  if (vaultLoaded) return;
  vaultLoaded = true;
  for (const origin of Object.keys(await vaultAll())) { const v = await vaultGet(origin); if (v) addKnown(v, 365 * 86400_000); }
}

const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

// ---------------------------------------------------------------- vault key (IndexedDB, non-extractable)
let vaultKeyP = null;
function idb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open('flygo-bridge', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
async function vaultKey() {
  vaultKeyP ||= (async () => {
    const db = await idb();
    const get = () => new Promise((ok, bad) => { const q = db.transaction('keys').objectStore('keys').get('vault'); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });
    let k = await get();
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise((ok, bad) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(k, 'vault'); tx.oncomplete = ok; tx.onerror = () => bad(tx.error); });
    }
    return k;
  })().catch((e) => { vaultKeyP = null; throw e; });
  return vaultKeyP;
}
async function vaultAll() { return (await chrome.storage.local.get('vault')).vault || {}; }
async function vaultPut(origin, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(origin) }, await vaultKey(), new TextEncoder().encode(value));
  const v = await vaultAll();
  v[origin] = { iv: b64.enc(iv), ct: b64.enc(ct), at: Date.now(), label: String(label || '').slice(0, 120) };
  await chrome.storage.local.set({ vault: v });
}
async function vaultGet(origin) {
  const e = (await vaultAll())[origin];
  if (!e) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(e.iv), additionalData: new TextEncoder().encode(origin) }, await vaultKey(), b64.dec(e.ct));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
export async function vaultList() {
  return Object.entries(await vaultAll()).map(([origin, e]) => ({ origin, at: e.at, label: e.label || '' })).sort((a, b) => b.at - a.at);
}
export async function vaultDelete(origin) {
  const v = await vaultAll();
  delete v[origin];
  await chrome.storage.local.set({ vault: v });
}

// ---------------------------------------------------------------- typing into the marked field
function focusMarked(id) {
  const el = document.querySelector(`[data-flygo-secret="${CSS.escape(id)}"]`);
  if (!el) return { found: false };
  el.focus();
  try { if (typeof el.select === 'function') el.select(); else document.execCommand('selectAll'); } catch {}
  return { found: true, origin: location.origin };
}
function checkMarked(id, value, fallback) {
  const el = document.querySelector(`[data-flygo-secret="${CSS.escape(id)}"]`);
  if (!el) return { ok: false };
  const cur = 'value' in el ? el.value : el.textContent;
  if (cur !== value && fallback) {
    // Typing did not land (focus elsewhere): set the value the way frameworks notice (native setter + input/change events).
    if ('value' in el) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    } else el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const ok = ('value' in el ? el.value : el.textContent) === value;
  if (ok) el.removeAttribute('data-flygo-secret');
  return { ok };
}

/** Type value into the field marked with id, in a tab this server controls, only on the given origin. */
async function fillMarked(deps, server, id, origin, value) {
  for (const tabId of deps.tabsOf(server)) {
    let res;
    try { res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: focusMarked, args: [id] }); } catch { continue; }
    const hit = res.find((r) => r.result?.found);
    if (!hit) continue;
    if (hit.result.origin !== origin) return { ok: false, final: true, error: `Tab đã chuyển sang ${hit.result.origin}, không phải ${origin}: không điền.` };
    try { if (deps.attached(tabId)) await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: value }); } catch {}
    const [chk] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [hit.frameId] }, func: checkMarked, args: [id, value, true] });
    return chk?.result?.ok ? { ok: true } : { ok: false, error: 'Không gõ được vào ô (trang chặn?).' };
  }
  return { ok: false, error: 'Không thấy ô cần điền nữa (tab đã đóng hoặc trang đã tải lại). Agent cần hỏi lại.', final: true };
}

// ---------------------------------------------------------------- RPC from the server
export async function secretRequest(deps, server, p) {
  const id = String(p?.id || ''), origin = String(p?.origin || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^https?:\/\/[^/]+$/.test(origin)) throw new Error('yêu cầu không hợp lệ');
  const kind = ['otp', 'text'].includes(p.kind) ? p.kind : 'password';
  if (kind === 'password') {
    const saved = await vaultGet(origin).catch(() => null);
    if (saved !== null) {
      addKnown(saved, 365 * 86400_000);
      const r = await fillMarked(deps, server, id, origin, saved);
      if (r.ok) return { filled: true, from: 'saved' };
    }
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  const rec = { server, origin, kind, label: String(p.label || '').slice(0, 120), agent: String(p.agent || ''), exp: Date.now() + TTL };
  pending.set(id, { ...rec, key: kp.privateKey });
  // Survive a service-worker restart within the 5 minutes (session storage stays in memory, never on disk).
  try { await chrome.storage.session.set({ [`sec:${id}`]: { ...rec, jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) } }); } catch {}
  deps.changed();
  return { pub };
}

async function takePending(id) {
  let p = pending.get(id);
  if (!p) {
    const s = (await chrome.storage.session.get(`sec:${id}`))[`sec:${id}`];
    if (s) p = { ...s, key: await crypto.subtle.importKey('jwk', s.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']) };
  }
  return p && p.exp > Date.now() ? p : null;
}
function drop(id) { pending.delete(id); chrome.storage.session.remove(`sec:${id}`).catch(() => {}); }

export async function secretFill(deps, server, p) {
  const id = String(p?.id || '');
  const req = await takePending(id);
  if (!req || req.server !== server) return { ok: false, final: true, error: 'Yêu cầu không còn trên trình duyệt (hết hạn hoặc đã dùng).' };
  let msg;
  try {
    const epub = await crypto.subtle.importKey('raw', b64.dec(p.epub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: epub }, req.key, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(p.iv), additionalData: new TextEncoder().encode(id) }, key, b64.dec(p.ct));
    msg = JSON.parse(new TextDecoder().decode(pt));
  } catch { return { ok: false, error: 'Giải mã không được (link sai hoặc đã đổi).' }; }
  const value = String(msg?.v ?? '');
  if (!value) return { ok: false, error: 'Giá trị trống.' };
  addKnown(value, req.kind === 'otp' ? 10 * 60_000 : req.kind === 'password' ? 365 * 86400_000 : KEEP);
  const r = await fillMarked(deps, server, id, req.origin, value);
  if (r.final || r.ok) { drop(id); deps.changed(); }
  if (!r.ok) return r;
  let remembered = false;
  if (msg.remember && req.kind === 'password') { try { await vaultPut(req.origin, value, req.label); remembered = true; } catch {} }
  return { ok: true, remembered };
}

export function secretCancel(id) { drop(String(id || '')); }

export function pendingList() {
  const now = Date.now();
  for (const [id, p] of pending) if (p.exp <= now) pending.delete(id);
  return [...pending.values()].map((p) => ({ origin: p.origin, kind: p.kind, label: p.label, agent: p.agent, exp: p.exp }));
}
