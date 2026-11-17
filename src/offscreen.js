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

// ------------------------------------------------------------------ direct WebRTC link to Flygo servers
// The service worker has no RTCPeerConnection, so the data channel lives here. One port ("rtc") from the service worker;
// messages: {op:"open", id, iceServers} → {ev:"offer", id, sdp}; {op:"answer", id, sdp}; {op:"cand", id, candidate, mid}
// both ways; {ev:"open", id}; {op:"send", id, s} / {ev:"msg", id, d}; {op:"close", id} / {ev:"close", id}.
const peers = new Map(); // id -> {pc, dc, queue}
const HIGH = 4 * 1024 * 1024; // hold sends above this much buffered data (keeps memory flat on a slow link)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rtc') return;
  const post = (m) => { try { port.postMessage(m); } catch {} };
  const drop = (id, why) => {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.dc?.close(); } catch {}
    try { p.pc.close(); } catch {}
    post({ ev: 'close', id, why });
  };
  const flush = (p) => {
    while (p.queue.length && p.dc.readyState === 'open' && p.dc.bufferedAmount < HIGH) p.dc.send(p.queue.shift());
  };
  port.onMessage.addListener(async (m) => {
    const p = peers.get(m.id);
    try {
      if (m.op === 'open') {
        if (p) drop(m.id, 'reopen');
        const pc = new RTCPeerConnection({ iceServers: (m.iceServers || []).map((u) => ({ urls: u })) });
        const dc = pc.createDataChannel('flygo', { ordered: true });
        const peer = { pc, dc, queue: [], cands: [], answered: false };
        peers.set(m.id, peer);
        dc.bufferedAmountLowThreshold = HIGH / 4;
        dc.onbufferedamountlow = () => flush(peer);
        dc.onopen = () => post({ ev: 'open', id: m.id });
        dc.onclose = () => drop(m.id, 'channel closed');
        dc.onmessage = (e) => post({ ev: 'msg', id: m.id, d: typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data) });
        pc.onicecandidate = (e) => { if (e.candidate?.candidate) post({ ev: 'cand', id: m.id, candidate: e.candidate.candidate, mid: e.candidate.sdpMid }); };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(m.id, pc.connectionState); };
        await pc.setLocalDescription(await pc.createOffer());
        post({ ev: 'offer', id: m.id, sdp: pc.localDescription.sdp });
      } else if (!p) {
        if (m.op === 'send') post({ ev: 'close', id: m.id, why: 'no peer' });
      } else if (m.op === 'answer') {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        p.answered = true;
        for (const c of p.cands.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (m.op === 'cand') {
        const c = { candidate: m.candidate, sdpMid: m.mid ?? '0' };
        if (p.answered) await p.pc.addIceCandidate(c).catch(() => {}); else p.cands.push(c);
      }
      else if (m.op === 'send') { p.queue.push(m.s); flush(p); }
      else if (m.op === 'close') drop(m.id, 'closed by worker');
    } catch (e) { drop(m.id, String(e?.message || e)); }
  });
  port.onDisconnect.addListener(() => { for (const id of [...peers.keys()]) drop(id, 'worker gone'); });
});
