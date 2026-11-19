// Large uploads without moving the bytes through the server: the extension downloads the file on this machine (chrome.downloads,
// with the browser's own cookies, so chat attachments work too) or takes a file already in an allowed local folder, then hands the
// file to the page's <input type=file> by path (CDP DOM.setFileInputFiles). Only files the extension downloaded itself, or files
// under the agent's workspace / Downloads / Desktop, can be attached: an agent cannot pick arbitrary local files (keys, documents).
const ALLOWED = /\/(flygo-agent\/workspaces|Downloads|Desktop)\//;
const ours = new Set(); // absolute paths this extension downloaded

function waitDownload(id, ms) {
  return new Promise((ok, bad) => {
    const t = setTimeout(() => { chrome.downloads.onChanged.removeListener(on); bad(new Error('tải tệp quá lâu')); }, ms);
    const check = async () => {
      const [it] = await chrome.downloads.search({ id });
      if (!it) return done(new Error('mất lượt tải'));
      if (it.state === 'complete') return done(null, it);
      if (it.state === 'interrupted') return done(new Error(`tải hỏng: ${it.error || 'interrupted'}`));
    };
    const done = (e, it) => { clearTimeout(t); chrome.downloads.onChanged.removeListener(on); e ? bad(e) : ok(it); };
    const on = (d) => { if (d.id === id && (d.state || d.error)) void check(); };
    chrome.downloads.onChanged.addListener(on);
    void check();
  });
}

export async function upload(deps, server, p) {
  const id = String(p?.id || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(id)) throw new Error('yêu cầu không hợp lệ');
  let file, bytes = 0;
  if (p.path) {
    const path = String(p.path);
    if (!path.startsWith('/') || path.includes('/../') || !(ALLOWED.test(path) || ours.has(path)))
      return { ok: false, error: 'Chỉ gắn được tệp trong ~/flygo-agent/workspaces, ~/Downloads hoặc ~/Desktop của máy này (hoặc đưa URL).' };
    file = path;
  } else {
    const url = String(p.url || '');
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'cần url http(s) hoặc path' };
    const name = String(p.name || url.split('?')[0].split('/').pop() || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    const dl = await chrome.downloads.download({ url, filename: `flygo-agent/${name}`, conflictAction: 'uniquify', saveAs: false });
    const it = await waitDownload(dl, 30 * 60_000);
    file = it.filename; bytes = it.fileSize || it.totalBytes || 0;
    ours.add(file);
  }
  for (const tabId of deps.tabsOf(server)) {
    let r;
    try { r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: `document.querySelector('[data-flygo-upload="${id}"]')` }); } catch { continue; }
    const objectId = r?.result?.objectId;
    if (!objectId) continue;
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { files: [file], objectId });
    return { ok: true, name: file.split('/').pop(), bytes };
  }
  return { ok: false, error: 'Không thấy ô chọn tệp đã đánh dấu (trang đã tải lại?). Gọi lại browser_upload_file.' };
}
