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

// createWhenBoard({ title, cues, port, log, editor }) → { url, ready: Promise<boolean>, close() }.
// `editor`, when given, is the show's wave book on the same page: { read() → book, write(book) → { ok, why }, mobs: [name],
// gates: [name], maxEvery }. The page loads the book once on open and saves it on Save; the show owns its checks.
function createWhenBoard({ title, cues, port = DEFAULT_PORT, log = console.log, editor = null }) {
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
    if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', page(title, editor));
    if (req.method === 'GET' && req.url === '/state') return send(res, 200, 'application/json', JSON.stringify(state()));
    if (editor && req.method === 'GET' && req.url === '/waves') {
      return send(res, 200, 'application/json', JSON.stringify({ book: editor.read(), mobs: editor.mobs, gates: editor.gates, maxEvery: editor.maxEvery }));
    }
    if (editor && req.method === 'POST' && req.url === '/waves') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const read = require('../../js_kernel/utils/external_library_guard').guardExternalSync('when_board', 'read the saved waves', () => JSON.parse(body));
        const parsed = read.ok && read.value && typeof read.value === 'object' ? read.value : null;
        const r = parsed ? editor.write(parsed) : { ok: false, why: `the page sent no wave book (${read.ok ? 'not an object' : read.reason})` };
        const said = r.ok ? `committed ${parsed.rounds.length} round(s)${r.used ? `; ${r.used}` : ''}` : r.why;
        log('board', r.ok ? `waves ${said}` : `waves NOT committed — ${r.why}`);
        send(res, r.ok ? 200 : 400, 'application/json', JSON.stringify({ words: said }));
      });
      return undefined;
    }
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

// openPage(url, log) — the board comes up in this machine's default browser, so nobody has to type its address. A browser
// that will not open is told, never fatal: the address is already in the log.
function openPage(url, log = console.log) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('board', `the browser did not open (${e.message}); open ${url} by hand`));
  child.unref();
}

// The page: no library, one file. Groups in the order the cues name them.
function page(title, editor = null) {
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
</script>${editor ? WAVES_PANEL : ''}</body></html>`;
}

// THE WAVES PANEL: the show's wave book, loaded once when the page opens and saved by Save. Each round is a list of
// monster lines (monster, how many, which gate) and how far apart its gates open. The show checks a save before keeping it.
const WAVES_PANEL = `<style>
.ed{margin-top:22px}.ed h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
.rd{background:var(--panel);border-radius:10px;padding:12px;margin:0 0 10px}.rd .hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px}
.rd .hd b{font-size:17px;margin-right:auto}.ln{display:flex;gap:8px;align-items:center;margin:0 0 6px;flex-wrap:wrap}
.ed select,.ed input{background:#2a2f38;color:var(--ink);border:1px solid #3b4250;border-radius:6px;padding:6px 8px;font:15px system-ui}
.ed input[type=number]{width:72px}.ed button{all:unset;cursor:pointer;background:#2a2f38;border-radius:6px;padding:6px 10px;font-size:14px}
.ed button:hover{filter:brightness(1.3)}.ed button.sv{background:var(--idle);font-weight:700;padding:10px 18px}
.ed.dirty button.sv{background:var(--busy);color:#111}.cb{display:flex;align-items:center;gap:10px;margin:0 0 10px;flex-wrap:wrap}
.wst{color:var(--dim);font-size:14px}.wst.bad{color:#f1948a}.wst.good{color:#7ee2a8}.wst.dirty{color:#f5c26b;font-weight:700}
</style><div class="ed" id="ed"><h2>Waves</h2>
<div class="cb"><button class="sv">Commit waves</button><span class="wst"></span></div>
<div id="waves">loading the wave book…</div>
<div class="cb"><button class="sv">Commit waves</button><span class="wst"></span></div></div><script>
let book=null,meta=null;
function mk(t,p,kids){const e=document.createElement(t);if(p)Object.assign(e,p);(kids||[]).forEach(k=>e.appendChild(typeof k==='string'?document.createTextNode(k):k));return e}
function wstatus(t,cls){document.querySelectorAll('.wst').forEach(s=>{s.textContent=t;s.className='wst '+(cls||'')});document.getElementById('ed').classList.toggle('dirty',cls==='dirty')}
function changed(){wstatus('uncommitted changes: press Commit waves to use them','dirty')}
function pick(opts,val,on){const s=mk('select');opts.forEach(o=>s.appendChild(mk('option',{value:o,textContent:o.replace('_',' '),selected:o===val})));s.onchange=()=>{on(s.value);changed()};return s}
function num(val,min,max,on){const i=mk('input',{type:'number',min:min,max:max,value:val});i.oninput=()=>{on(parseInt(i.value,10));changed()};return i}
function drawWaves(){const w=document.getElementById('waves');w.innerHTML='';
book.rounds.forEach((r,i)=>{const card=mk('div',{className:'rd'});
const up=mk('button',{textContent:'↑',title:'move up'});up.onclick=()=>{if(i>0){book.rounds.splice(i-1,0,book.rounds.splice(i,1)[0]);changed();drawWaves()}};
const dn=mk('button',{textContent:'↓',title:'move down'});dn.onclick=()=>{if(i<book.rounds.length-1){book.rounds.splice(i+1,0,book.rounds.splice(i,1)[0]);changed();drawWaves()}};
const rm=mk('button',{textContent:'remove round'});rm.onclick=()=>{book.rounds.splice(i,1);changed();drawWaves()};
card.appendChild(mk('div',{className:'hd'},[mk('b',{textContent:'Round '+(i+1)}),'gates open every ',num(r.every||0,0,meta.maxEvery,v=>{r.every=v}),' s (0 = all at once)',up,dn,rm]));
r.groups.forEach((g,k)=>{const x=mk('button',{textContent:'✕',title:'remove this line'});x.onclick=()=>{r.groups.splice(k,1);changed();drawWaves()};
card.appendChild(mk('div',{className:'ln'},[pick(meta.mobs,g.mob,v=>{g.mob=v}),num(g.count,1,32,v=>{g.count=v}),pick(['spread'].concat(meta.gates),g.gate,v=>{g.gate=v}),x]))});
const add=mk('button',{textContent:'+ monster'});add.onclick=()=>{r.groups.push({mob:meta.mobs[0],count:1,gate:'spread'});changed();drawWaves()};
card.appendChild(add);w.appendChild(card)});
const addR=mk('button',{textContent:'+ round'});addR.onclick=()=>{book.rounds.push({groups:[{mob:meta.mobs[0],count:1,gate:'spread'}],every:0});changed();drawWaves()};w.appendChild(addR)}
async function loadWaves(){const r=await fetch('/waves').then(r=>r.json(),()=>null);if(!r){wstatus('the wave book did not load','bad');return}
book=r.book;meta=r;drawWaves();wstatus('loaded: '+book.rounds.length+' round(s)','good')}
async function commitWaves(){if(!book)return;wstatus('committing…');
const r=await fetch('/waves',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(book)}).then(async x=>({ok:x.ok,...(await x.json())}),()=>({ok:false,words:'the show is gone'}));
wstatus(r.words,r.ok?'good':'bad')}
document.querySelectorAll('.ed button.sv').forEach(b=>{b.onclick=commitWaves});
loadWaves();
</script>`;

module.exports = { createWhenBoard, openPage, DEFAULT_PORT };
