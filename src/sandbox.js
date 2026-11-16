// Runs one network rule script: `async (req) => { <code> }`. No extension APIs, opaque origin.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
window.addEventListener('message', async (ev) => {
  const { id, code, req } = ev.data || {};
  if (!id) return;
  try {
    const fn = new AsyncFunction('req', String(code));
    const result = await fn(structuredClone(req));
    ev.source.postMessage({ id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) }, '*');
  } catch (e) {
    ev.source.postMessage({ id, error: String(e && e.message || e) }, '*');
  }
});
