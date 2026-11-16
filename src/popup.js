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
  if (s.disabled) { $('stTitle').textContent = 'ĐÃ NGẮT'; $('stSub').textContent = 'Agent không dùng được trình duyệt này.'; }
  else if (s.mode === 'local') { $('stTitle').textContent = 'ĐÃ NỐI · CỤC BỘ'; $('stSub').textContent = `qua flygo-agent trên ${s.hub?.machine_name || 'máy này'}${s.rtt ? ` · ${s.rtt} ms` : ''}`; }
  else if (s.mode === 'direct') { $('stTitle').textContent = 'ĐÃ NỐI · TRỰC TIẾP'; $('stSub').textContent = `${host(s.direct?.server)}${s.rtt ? ` · ${s.rtt} ms` : ''}`; }
  else { $('stTitle').textContent = s.connecting ? 'ĐANG NỐI…' : 'ĐANG DÒ FLYGO…'; $('stSub').textContent = s.lastError || 'Mở Flygo Chat (máy tính) hoặc runner trên máy này.'; }

  $('control').classList.toggle('hidden', !ctl.length);
  $('ctlWho').innerHTML = ctl.map(([srv, c]) => `<div>▸ <b>${esc(c.agent || 'agent')}</b>${c.machine ? ` @ ${esc(c.machine)}` : ''} <span style="color:var(--mute)">· ${esc(host(srv))}</span></div>`).join('');

  if (!editing) $('name').value = s.name || '';
  const slugs = [...new Set(Object.values(s.pairings || {}).map((p) => p.slug).filter(Boolean))];
  $('tag').textContent = slugs.length ? `tag trong chat: ${slugs.map((x) => '@' + x).join('  ')}` : '';

  const servers = s.servers?.length ? s.servers : s.direct ? [{ server: s.direct.server, state: s.mode ? 'online' : 'offline', user: s.direct.user }] : [];
  $('servers').innerHTML = servers.length ? servers.map((x) => `<div class="srv"><span class="h">${esc(host(x.server))}${x.user ? ` · ${esc(x.user)}` : ''}</span><span class="s ${x.state}">${({ online: '● ONLINE', connecting: '◌ ĐANG NỐI', offline: '○ OFFLINE', error: '✕ LỖI' })[x.state] || x.state}</span></div>`).join('')
    : '<div class="srv"><span class="h" style="color:var(--mute)">chưa nối máy chủ nào</span></div>';
  $('servers').classList.toggle('hidden', !servers.length && !s.mode);

  $('stats').innerHTML = `<span>TAB <b>${s.attached}</b></span><span>QUY TẮC <b>${s.net?.rules ?? 0}</b></span><span>LOG <b>${s.net?.logging ? (s.net.entries ?? 0) : 'tắt'}</b></span>`;
  const note = s.update ? `⬆ Có bản ${s.update.latest_version || 'mới'}${s.update.required ? ' (bắt buộc)' : ''}${s.update.download_url ? ` · <a href="${esc(s.update.download_url)}" target="_blank" style="color:var(--cyan)">tải zip</a>` : ''}` : s.notice?.text ? esc(s.notice.text) : '';
  $('notice').innerHTML = note;
  $('notice').classList.toggle('hidden', !note);
  $('login').classList.toggle('hidden', !!s.mode || s.disabled || !!s.hub);
  $('toggle').textContent = s.disabled ? 'NỐI LẠI' : 'NGẮT';
  $('share').classList.toggle('hidden', !s.mode);
}
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function refresh() { render(await ask({ type: 'get' })); }
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'state') void refresh(); });
$('stop').onclick = async () => render(await ask({ type: 'stop' }));
$('toggle').onclick = async () => render(await ask({ type: 'toggle' }));
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
