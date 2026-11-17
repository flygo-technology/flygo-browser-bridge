// Status only: connection, servers, who is controlling. Logging / interception are set by agents through tools.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
let editing = false;

function host(u) { try { return new URL(u).host; } catch { return u; } }

function render(s) {
  if (!s || s.error) return;
  $('ver').textContent = `v${s.version}`;
  const ctl = Object.entries(s.control || {});
  const st = $('status');
  st.className = 'status ' + (ctl.length ? 'ai' : s.mode ? 'on' : s.connecting ? 'warn' : '');
  if (s.disabled) { $('stTitle').textContent = 'Đã ngắt'; $('stSub').textContent = 'Agent không dùng được trình duyệt này.'; }
  else if (s.mode) { $('stTitle').textContent = 'Đã kết nối'; $('stSub').textContent = `${host(s.direct?.server)}${s.direct?.user ? ` · ${s.direct.user}` : ''}${s.rtt ? ` · ${s.rtt} ms` : ''}`; }
  else if (s.direct) { $('stTitle').textContent = s.connecting ? 'Đang kết nối…' : 'Mất kết nối'; $('stSub').textContent = s.lastError || `đang thử lại ${host(s.direct.server)}…`; }
  else if (s.localApp?.supported) { $('stTitle').textContent = 'Thấy Flygo Chat trên máy'; $('stSub').textContent = s.lastError || `${host(s.localApp.server)} · ${s.localApp.user || ''}`; }
  else { $('stTitle').textContent = 'Chưa kết nối'; $('stSub').textContent = s.lastError || 'Đăng nhập Flygo để agent của bạn dùng trình duyệt này.'; }

  $('control').classList.toggle('hidden', !ctl.length);
  $('ctlWho').innerHTML = ctl.map(([srv, c]) => `<div><b>${esc(c.agent || 'agent')}</b>${c.machine ? ` @ ${esc(c.machine)}` : ''} <span style="color:var(--mute)">· ${esc(host(srv))}</span></div>`).join('');

  if (!editing) $('name').value = s.name || '';
  const slugs = [...new Set(Object.values(s.pairings || {}).map((p) => p.slug).filter(Boolean))];
  $('tag').textContent = slugs.length ? `Tag trong chat: ${slugs.map((x) => '@' + x).join('  ')}` : '';

  const servers = s.direct ? [{ server: s.direct.server, state: s.mode ? 'online' : s.connecting ? 'connecting' : 'offline', user: s.direct.user }] : [];
  $('servers').innerHTML = servers.length ? servers.map((x) => `<div class="srv"><span class="h">${esc(host(x.server))}${x.user ? ` · ${esc(x.user)}` : ''}</span><span class="s ${x.state}">${({ online: 'Trực tuyến', connecting: 'Đang nối', offline: 'Ngoại tuyến', error: 'Lỗi' })[x.state] || x.state}</span></div>`).join('')
    : '<div class="srv"><span class="h" style="color:var(--mute)">Chưa nối máy chủ nào</span></div>';
  $('servers').classList.toggle('hidden', !servers.length && !s.mode);

  $('stats').innerHTML = `<span>Tab <b>${s.attached}</b></span><span>Quy tắc <b>${s.net?.rules ?? 0}</b></span><span>Log <b>${s.net?.logging ? (s.net.entries ?? 0) : 'tắt'}</b></span>`;
  const note = s.update ? `Có bản ${s.update.latest_version || 'mới'}${s.update.required ? ' (bắt buộc)' : ''}${s.update.download_url ? ` · <a href="${esc(s.update.download_url)}" target="_blank" style="color:var(--cyan)">tải zip</a>` : ''}` : s.notice?.text ? esc(s.notice.text) : '';
  $('notice').innerHTML = note;
  $('notice').classList.toggle('hidden', !note);
  $('pairApp').classList.toggle('hidden', !!s.direct || s.disabled || !s.localApp?.supported);
  const choices = s.localApp?.choices || [];
  if (s.localApp?.supported) $('pairAppHint').textContent = choices.length > 1 ? `Flygo Chat trên máy đăng nhập ${choices.length} máy chủ. Chọn máy chủ:` : `Flygo Chat trên máy này: ${host(choices[0]?.url || s.localApp.server)} · ${s.localApp.user || ''}`;
  const sel = $('pairServer');
  sel.classList.toggle('hidden', choices.length < 2);
  if (choices.length > 1 && sel.options.length !== choices.length) {
    sel.innerHTML = choices.map((c) => `<option value="${esc(c.url)}">${esc(c.name || host(c.url))}${c.current ? ' (đang mở)' : ''}</option>`).join('');
    const pre = choices.find((c) => c.url === s.lastServer) || choices.find((c) => c.current);
    if (pre) sel.value = pre.url;
  }
  // Đăng nhập máy chủ khác luôn có (vd Flygo Chat trên máy đang dùng một máy chủ khác).
  $('login').classList.toggle('hidden', !!s.direct || s.disabled);
  $('loginHint').textContent = s.localApp && !s.localApp.supported
    ? `Flygo Chat trên máy đang dùng ${host(s.localApp.server)} (máy chủ này chưa có bridge). Đăng nhập máy chủ khác:`
    : s.localApp ? 'Hoặc đăng nhập một máy chủ khác:' : 'Địa chỉ máy chủ Flygo Chat của bạn:';
  if (!$('server').value && s.lastServer) $('server').value = host(s.lastServer);
  $('logout').classList.toggle('hidden', !s.direct);
  $('toggle').textContent = s.disabled ? 'Nối lại' : 'Ngắt';
  $('share').classList.toggle('hidden', !s.mode);
}
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function refresh() { render(await ask({ type: 'get' })); }
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'state') void refresh(); });
$('stop').onclick = async () => render(await ask({ type: 'stop' }));
$('toggle').onclick = async () => render(await ask({ type: 'toggle' }));
$('logout').onclick = async () => render(await ask({ type: 'logout' }));
$('doPairApp').onclick = async () => { const r = await ask({ type: 'pair_local', server: $('pairServer').classList.contains('hidden') ? null : $('pairServer').value }); if (r?.error) { $('stSub').textContent = r.error; return; } render(r); };
$('share').onclick = async () => render(await ask({ type: 'share_tab' }));
$('name').onfocus = () => { editing = true; };
$('name').onblur = async () => { editing = false; render(await ask({ type: 'rename', name: $('name').value })); };
$('name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
$('doLogin').onclick = async () => {
  $('doLogin').disabled = true;
  const r = await ask({ type: 'login', server: $('server').value });
  $('doLogin').disabled = false;
  if (r?.error) { $('stSub').textContent = r.error; return; }
  render(r);
};
void refresh();
setInterval(refresh, 2000);
