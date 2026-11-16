// Relays rule scripts to the sandboxed iframe (sandbox pages may evaluate code; they have no extension APIs).
const frame = document.getElementById('sb');
const ready = new Promise((r) => frame.addEventListener('load', r, { once: true }));
const waiting = new Map();
let seq = 0;
window.addEventListener('message', (ev) => {
  if (ev.source !== frame.contentWindow) return;
  const cb = waiting.get(ev.data?.id);
  if (cb) { waiting.delete(ev.data.id); cb(ev.data); }
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'run') return;
  ready.then(() => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reply({ error: 'script timed out (2 s)' }); }, 2000);
    waiting.set(id, (d) => { clearTimeout(t); reply(d.error ? { error: d.error } : { result: d.result }); });
    frame.contentWindow.postMessage({ id, code: msg.code, req: msg.req }, '*');
  });
  return true;
});
