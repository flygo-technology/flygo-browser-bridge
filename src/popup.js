// Status only: connections (one per Flygo server), who is controlling. Logging / interception are set by agents through tools.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
let editing = false;

function render(s) {
  if (!s || s.error) return;
  $('ver').textContent = `v${s.version}`;
  const ctl = Object.entries(s.control || {});
  const servers = s.servers || [];
  const connecting = servers.some((x) => x.state === 'connecting');
  $('status').className = 'status ' + (ctl.length ? 'ai' : s.connected ? 'on' : connecting ? 'warn' : '');
  const pending = (s.localApp?.choices || []).filter((c) => !c.connected);
  if (s.disabled) { $('stTitle').textContent = 'Đã ngắt'; $('stSub').textContent = 'Agent không dùng được trình duyệt này.'; }
  else if (s.connected) { $('stTitle').textContent = s.connected > 1 ? `Đã kết nối ${s.connected} máy chủ` : 'Đã kết nối'; $('stSub').textContent = servers.filter((x) => x.state === 'online').map((x) => host(x.server)).join(' · '); }
  else if (servers.length) { $('stTitle').textContent = connecting ? 'Đang kết nối…' : 'Mất kết nối'; $('stSub').textContent = s.lastError || 'Đang thử lại…'; }
  else if (s.localApp?.supported) { $('stTitle').textContent = 'Thấy Flygo Chat trên máy'; $('stSub').textContent = s.lastError || pending.map((c) => host(c.url)).join(' · '); }
  else { $('stTitle').textContent = 'Chưa kết nối'; $('stSub').textContent = s.lastError || 'Mở Flygo Chat trên máy này để tự kết nối.'; }

  $('control').classList.toggle('hidden', !ctl.length);
  $('ctlWho').innerHTML = ctl.map(([srv, c]) => `<div><b>${esc(c.agent || 'agent')}</b>${c.machine ? ` @ ${esc(c.machine)}` : ''} <span style="color:var(--mute)">· ${esc(host(srv))}</span></div>`).join('');

  if (!editing) $('name').value = s.name || '';
  const slugs = [...new Set(Object.values(s.pairings || {}).map((p) => p.slug).filter(Boolean))];
  $('tag').textContent = slugs.length ? `Tag trong chat: ${slugs.map((x) => '@' + x).join('  ')}` : '';

  const label = { online: 'Trực tuyến', connecting: 'Đang nối', offline: 'Ngoại tuyến', error: 'Lỗi' };
  $('servers').innerHTML = servers.length
    ? servers.map((x) => `<div class="srv"><span class="h" title="${esc(x.error || '')}">${esc(host(x.server))}${x.user ? ` · ${esc(x.user)}` : ''}</span>`
      + `<span class="s ${x.state}">${label[x.state] || x.state}${x.rtt ? ` · ${x.rtt} ms` : ''}</span>`
      + `<a href="#" class="rm" data-server="${esc(x.server)}" title="Gỡ máy chủ này">×</a></div>`).join('')
    : '<div class="srv"><span class="h" style="color:var(--mute)">Chưa nối máy chủ nào</span></div>';
  for (const a of document.querySelectorAll('.rm')) a.onclick = async (e) => { e.preventDefault(); render(await ask({ type: 'logout', server: a.dataset.server })); };

  $('stats').innerHTML = `<span>Tab <b>${s.attached}</b></span><span>Quy tắc <b>${s.net?.rules ?? 0}</b></span><span>Log <b>${s.net?.logging ? (s.net.entries ?? 0) : 'tắt'}</b></span>`;
  const note = s.update ? `Có bản ${s.update.latest_version || 'mới'}${s.update.required ? ' (bắt buộc)' : ''}${s.update.download_url ? ` · <a href="${esc(s.update.download_url)}" target="_blank">tải zip</a>` : ''}` : s.notice?.text ? esc(s.notice.text) : '';
  $('notice').innerHTML = note;
  $('notice').classList.toggle('hidden', !note);

  // Máy chủ Flygo Chat trên máy đã đăng nhập mà trình duyệt chưa nối (vd đã gỡ trước đó).
  $('pairApp').classList.toggle('hidden', s.disabled || !pending.length);
  $('pairAppHint').textContent = pending.length ? `Flygo Chat trên máy còn ${pending.length} máy chủ chưa nối: ${pending.map((c) => host(c.url)).join(', ')}` : '';
  $('login').classList.toggle('hidden', s.disabled);
  $('toggle').textContent = s.disabled ? 'Nối lại' : 'Ngắt';
  $('logout').classList.toggle('hidden', !servers.length);
  $('share').classList.toggle('hidden', !s.connected);
}

async function refresh() { render(await ask({ type: 'get' })); }
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'state') void refresh(); });
$('gear').onclick = () => { const m = $('manual'); m.classList.toggle('hidden'); $('gear').classList.toggle('on', !m.classList.contains('hidden')); };
$('stop').onclick = async () => render(await ask({ type: 'stop' }));
$('toggle').onclick = async () => render(await ask({ type: 'toggle' }));
$('share').onclick = async () => render(await ask({ type: 'share_tab' }));
$('logout').onclick = async () => render(await ask({ type: 'logout' }));
$('doPairApp').onclick = async () => { const r = await ask({ type: 'pair_local' }); if (r?.error) { $('stSub').textContent = r.error; return; } render(r); };
$('name').onfocus = () => { editing = true; };
$('name').onblur = async () => { editing = false; render(await ask({ type: 'rename', name: $('name').value })); };
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
