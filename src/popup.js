// Status only: connections (one per Flygo server), who is controlling. Logging / interception are set by agents through tools.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
// Same shape as the server's slug, for a preview while typing (the server's answer replaces it).
const slugify = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}
let editing = false;
let focused = false;
let last = null;

function renderTag(s) {
  const slugs = editing
    ? [slugify($('name').value)].filter(Boolean)
    : [...new Set(Object.values(s.pairings || {}).map((p) => p.slug).filter(Boolean))];
  $('tag').innerHTML = slugs.length ? `Tag trong chat: ${slugs.map((x) => `<code>@${esc(x)}</code>`).join('')}` : '';
}

function render(s) {
  if (!s || s.error) return;
  last = s;
  $('ver').textContent = `Phiên bản ${s.version}`;
  const ctl = Object.entries(s.control || {});
  const servers = s.servers || [];
  const connecting = servers.some((x) => x.state === 'connecting');
  const pending = (s.localApp?.choices || []).filter((c) => !c.connected);
  let cls = '';
  if (ctl.length) {
    cls = 'ai';
    $('stTitle').textContent = ctl.length > 1 ? `${ctl.length} agent đang điều khiển` : `${ctl[0][1].agent || 'Agent'} đang điều khiển`;
    $('stSub').textContent = 'Trình duyệt đang được AI dùng';
  } else if (s.disabled) { cls = 'bad'; $('stTitle').textContent = 'Đã tạm ngắt'; $('stSub').textContent = 'Agent không dùng được trình duyệt này.'; }
  else if (s.connected) { cls = 'on'; $('stTitle').textContent = s.connected > 1 ? `Đã kết nối ${s.connected} máy chủ` : 'Đã kết nối'; $('stSub').textContent = 'Agent có thể dùng trình duyệt này'; }
  else if (servers.length) { cls = connecting ? 'warn' : 'bad'; $('stTitle').textContent = connecting ? 'Đang kết nối…' : 'Mất kết nối'; $('stSub').textContent = s.lastError || 'Đang thử lại…'; }
  else if (s.localApp?.supported) { cls = 'warn'; $('stTitle').textContent = 'Thấy Flygo Chat trên máy'; $('stSub').textContent = s.lastError || pending.map((c) => host(c.url)).join(' · '); }
  else { $('stTitle').textContent = 'Chưa kết nối'; $('stSub').textContent = s.lastError || 'Mở Flygo Chat trên máy này để tự kết nối.'; }
  $('status').className = 'card status ' + cls;
  $('resume').classList.toggle('hidden', !s.disabled);
  $('show').classList.toggle('hidden', !(ctl.length || s.agentTabs));

  $('control').classList.toggle('hidden', !ctl.length);
  $('ctlWho').innerHTML = ctl.map(([srv, c]) => `<div><b>${esc(c.agent || 'agent')}</b>${c.machine ? ` @ ${esc(c.machine)}` : ''}<small>${esc(host(srv))} · ${esc(ago(c.since))}</small></div>`).join('');

  const logOn = !!s.net?.logging;
  $('stats').innerHTML = `<span class="pill${s.attached ? ' live' : ''}">Tab <b>${s.attached}</b></span>`
    + `<span class="pill${s.net?.rules ? ' live' : ''}">Quy tắc <b>${s.net?.rules ?? 0}</b></span>`
    + `<span class="pill${logOn ? ' live' : ''}">Log <b>${logOn ? (s.net.entries ?? 0) : 'tắt'}</b></span>`;

  if (!editing) $('name').value = s.name || '';
  $('name').classList.toggle('need', !s.name && !editing);
  renderTag(s);
  $('nameHint').classList.toggle('hidden', !!s.name);
  if (!s.name && !focused) { focused = true; $('name').focus(); }

  const label = { online: 'Trực tuyến', connecting: 'Đang nối', error: 'Lỗi', offline: 'Tạm ngắt' };
  $('srvCount').textContent = servers.length || '';
  $('servers').innerHTML = servers.length
    ? servers.map((x) => {
      const h = host(x.server);
      const who = x.user || '';
      const when = x.lastAt ? ago(x.lastAt) : x.since ? ago(x.since) : '';
      const whenTip = x.lastAt ? `Agent dùng lần cuối ${ago(x.lastAt)}` : x.since ? `Nối từ ${ago(x.since)}` : '';
      const via = x.path ? `<span class="via ${x.path}" title="${x.path === 'p2p' ? 'Nối thẳng WebRTC tới máy chủ' : 'Qua WebSocket (có thể qua proxy/CDN)'}">${x.path === 'p2p' ? 'P2P' : 'WS'}${x.rtt ? ` ${x.rtt} ms` : ''}</span>` : '';
      return `<div class="srv" title="${esc(x.error || '')}"><div class="av">${esc(h.replace(/^(chat|app)\./, '')[0] || '?')}</div>`
        + `<div class="meta"><div class="h">${esc(h)}</div><div class="u">${via}${esc(who || 'Chưa có tài khoản')}</div></div>`
        + `<div class="side"><span class="badge ${x.state}">${label[x.state] || x.state}</span>${when ? `<span class="t" title="${esc(whenTip)}">${esc(when)}</span>` : ''}</div></div>`;
    }).join('')
    : '<div class="empty">Chưa có máy chủ nào. Đăng nhập Flygo Chat trên máy này để tự kết nối.</div>';

  const note = s.update ? `Có bản ${esc(s.update.latest_version || 'mới')}${s.update.required ? ' (bắt buộc)' : ''}${s.update.download_url ? ` · <a href="${esc(s.update.download_url)}" target="_blank">tải zip</a>` : ''}` : s.notice?.text ? esc(s.notice.text) : '';
  $('notice').innerHTML = note;
  $('notice').classList.toggle('hidden', !note);

  // Waiting for the owner to send a password / code through the link the agent shared.
  const waits = s.secrets?.pending || [];
  const kindName = { password: 'mật khẩu', otp: 'mã OTP', text: 'giá trị' };
  $('secretWait').innerHTML = waits.map((w) => {
    const left = Math.max(0, Math.round((w.exp - Date.now()) / 1000));
    return `<div>Đang chờ ${kindName[w.kind] || 'giá trị'} cho <b>${esc(host(w.origin))}</b>${w.agent ? ` (${esc(w.agent)})` : ''} · còn ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</div>`;
  }).join('');
  $('secretWait').classList.toggle('hidden', !waits.length);
  const saved = s.secrets?.saved || [];
  $('vaultBox').classList.toggle('hidden', !saved.length);
  $('vault').innerHTML = saved.map((v) => `<div class="mg"><span title="${esc(v.label)}">${esc(host(v.origin))}</span><button data-origin="${esc(v.origin)}">Xoá</button></div>`).join('');
  for (const b of $('vault').querySelectorAll('button')) b.onclick = async () => render(await ask({ type: 'vault_delete', origin: b.dataset.origin }));

  // Settings: remove a server (recovery), pair servers Flygo Chat knows but this browser skipped, or add one by hand.
  $('manage').innerHTML = servers.map((x) => `<div class="mg"><span>${esc(host(x.server))}</span><button data-server="${esc(x.server)}">Gỡ</button></div>`).join('');
  for (const b of $('manage').querySelectorAll('button')) b.onclick = async () => render(await ask({ type: 'logout', server: b.dataset.server }));
  $('pairApp').classList.toggle('hidden', s.disabled || !pending.length);
  $('pairAppHint').textContent = pending.length ? `Flygo Chat trên máy còn ${pending.length} máy chủ chưa nối: ${pending.map((c) => host(c.url)).join(', ')}` : '';
  $('login').classList.toggle('hidden', s.disabled);
}

async function refresh() { render(await ask({ type: 'get' })); }
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'state') void refresh(); });
$('gear').onclick = () => { const m = $('manual'); m.classList.toggle('hidden'); $('gear').classList.toggle('on', !m.classList.contains('hidden')); };
$('stop').onclick = async () => render(await ask({ type: 'stop' }));
$('resume').onclick = async () => render(await ask({ type: 'toggle' }));
$('show').onclick = async () => { await ask({ type: 'show_agent' }); window.close(); };
$('doPairApp').onclick = async () => { const r = await ask({ type: 'pair_local' }); if (r?.error) { $('stSub').textContent = r.error; return; } render(r); };
$('name').onfocus = () => { editing = true; if (last) renderTag(last); };
$('name').oninput = () => { if (last) renderTag(last); };
$('name').onblur = async () => {
  editing = false;
  const name = $('name').value.trim();
  if (!name || name === last?.name) return last && render(last);
  render(await ask({ type: 'rename', name }));
};
$('name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
$('doLogin').onclick = async () => {
  $('doLogin').disabled = true;
  const r = await ask({ type: 'login', server: $('server').value });
  $('doLogin').disabled = false;
  if (r?.error) { $('stSub').textContent = r.error; return; }
  $('server').value = '';
  render(r);
};
void refresh();
setInterval(refresh, 2000);
