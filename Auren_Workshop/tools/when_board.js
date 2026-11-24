// when_board — the show's cue board: one page on a second monitor, one button per cue.
//
// The board says WHEN, never HOW. A cue is a name, a state read off the show, and one call into the unit that already
// owns the act (the emperor's console, the crowd, the TNT, the recorder). The smart part lives in that unit; the board
// only fires it. Every button shows its state in words and colour, read fresh on every poll, so nobody has to remember
// what a lever does: green is on, red is off, grey cannot be used now, amber is busy or armed.
//
// It may fire the world, the crowd, the gates and the recorder. It never steers a bot under trial (the North Star:
// a body acting on its own judgment with no one commanding it).
//
// Hosted by the process running the show and closed with it (Law 8), on this machine only (127.0.0.1).
//
// A cue: { id, label, group, confirm?, read() → { state: 'on'|'off'|'idle'|'busy'|'unavailable', words }, fire() → Promise<words> }.
// `confirm` makes the button arm on the first press and fire on a second press within ARM_MS, for a cue that can end a take.

'use strict';

const http = require('http');

const DEFAULT_PORT = 7711;
const POLL_MS = 500;
const ARM_MS = 3000;

// createWhenBoard({ title, cues, port, log }) → { url, ready: Promise<boolean>, close() }.
function createWhenBoard({ title, cues, port = DEFAULT_PORT, log = console.log }) {
  const byId = new Map(cues.map(c => [c.id, c]));
  const busy = new Set();
  const last = new Map();   // id → the words the last firing answered with

  const read = (c) => {
    if (busy.has(c.id)) return { state: 'busy', words: 'working…' };
    return c.read();
  };
  const state = () => cues.map(c => ({ id: c.id, label: c.label, group: c.group, confirm: !!c.confirm, ...read(c), last: last.get(c.id) || '' }));

  const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', page(title));
    if (req.method === 'GET' && req.url === '/state') return send(res, 200, 'application/json', JSON.stringify(state()));
    const m = req.method === 'POST' && /^\/fire\/([a-z0-9_-]+)$/.exec(req.url);
    if (!m) return send(res, 404, 'application/json', JSON.stringify({ words: 'no such page' }));
    const cue = byId.get(m[1]);
    if (!cue) return send(res, 404, 'application/json', JSON.stringify({ words: `no cue named ${m[1]}` }));
    const now = read(cue);
    if (now.state === 'unavailable' || now.state === 'busy') return send(res, 409, 'application/json', JSON.stringify({ words: now.words }));
    busy.add(cue.id);
    log('board', `${cue.label} pressed`);
    Promise.resolve().then(() => cue.fire()).then(
      (words) => { busy.delete(cue.id); last.set(cue.id, words || ''); log('board', `${cue.label} → ${words || 'done'}`); send(res, 200, 'application/json', JSON.stringify({ words: words || 'done' })); },
      (e) => { busy.delete(cue.id); last.set(cue.id, `failed: ${e.message}`); log('board', `${cue.label} FAILED — ${e.message}`); send(res, 500, 'application/json', JSON.stringify({ words: `failed: ${e.message}` })); },
    );
  });
  const url = `http://127.0.0.1:${port}/`;
  const ready = new Promise((resolve) => {
    server.once('error', (e) => { log('board', `NOT UP — ${e.code === 'EADDRINUSE' ? `port ${port} is taken (another board still open?); pass --board=<port>` : e.message}`); resolve(false); });
    server.listen(port, '127.0.0.1', () => { log('board', `the When Board is up: open ${url} on the second monitor`); resolve(true); });
  });
  return { url, ready, close() { server.close(); server.closeAllConnections(); } };
}

// The page: no library, one file. Groups in the order the cues name them.
function page(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>When Board</title><style>
:root{--bg:#14161a;--panel:#1d2026;--ink:#e8e8e8;--dim:#8a8f98;--on:#1f9d55;--off:#c0392b;--idle:#3b4250;--busy:#d68910}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px system-ui,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}#sub{color:var(--dim);margin:0 0 16px;font-size:13px}
.group{margin:0 0 18px}.group h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
.row{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
button{all:unset;cursor:pointer;background:var(--panel);border-radius:10px;padding:14px;border-left:8px solid var(--idle);min-height:74px;display:flex;flex-direction:column;gap:6px}
button:hover{filter:brightness(1.15)}button .l{font-weight:700;font-size:18px}button .w{font-size:13px;color:var(--dim)}
button.on{border-color:var(--on)}button.on .w{color:#7ee2a8}button.off{border-color:var(--off)}button.off .w{color:#f1948a}
button.busy,button.armed{border-color:var(--busy)}button.armed{background:#3a2a10}button.unavailable{opacity:.45;cursor:not-allowed}
button .x{font-size:12px;color:var(--dim)}
</style></head><body><h1>${title.replace(/</g, '&lt;')}</h1><p id="sub">connecting…</p><div id="board"></div><script>
const armed={};let cues=[];
function draw(){const g={};for(const c of cues)(g[c.group]=g[c.group]||[]).push(c);
const b=document.getElementById('board');b.innerHTML='';for(const[name,list]of Object.entries(g)){const d=document.createElement('div');d.className='group';
d.innerHTML='<h2>'+name+'</h2><div class="row"></div>';const row=d.querySelector('.row');for(const c of list){const k=document.createElement('button');
const isArmed=armed[c.id]&&armed[c.id]>Date.now();k.className=isArmed?'armed':c.state;
k.innerHTML='<span class="l"></span><span class="w"></span><span class="x"></span>';k.querySelector('.l').textContent=c.label;
k.querySelector('.w').textContent=isArmed?'ARMED: press again to fire':c.words;k.querySelector('.x').textContent=c.last||'';
k.onclick=()=>press(c);row.appendChild(k)}b.appendChild(d)}}
async function press(c){if(c.state==='unavailable'||c.state==='busy')return;
if(c.confirm&&!(armed[c.id]>Date.now())){armed[c.id]=Date.now()+${ARM_MS};draw();setTimeout(draw,${ARM_MS + 50});return}
delete armed[c.id];const r=await fetch('/fire/'+c.id,{method:'POST'}).then(r=>r.json(),()=>({words:'the show is gone'}));
c.last=r.words;poll()}
async function poll(){const r=await fetch('/state').then(r=>r.json(),()=>null);
const s=document.getElementById('sub');if(!r){s.textContent='the show has closed (this board is dead)';cues=cues.map(c=>({...c,state:'unavailable'}));draw();return}
s.textContent='live · '+new Date().toLocaleTimeString();cues=r;draw()}
poll();setInterval(poll,${POLL_MS});
</script></body></html>`;
}

module.exports = { createWhenBoard, DEFAULT_PORT };
