// colosseum_show — the whole show raised by one command: the colosseum's world, the server, the cameras, the gladiator on its
// post, the crowd, the guards, the ruler and the When Board, in the order that keeps the body still until all of it stands.
//
// A BENCH: it drives the tools that already own each act and decides nothing they own.
//   1. Anything standing on this copy's seat comes down (fleet_control down; the camera crew).
//   2. The colosseum save point is put back (fleet_control restore), only where clearing this seat is authorized
//      (record_homes.clearAuthorized): a restore puts the world back as a rollback does. The save point is found by the
//      world it was taken on, so a seat moved to another world (a new seed) still finds it: the seat is pointed at the
//      colosseum's world for the show and back at its own when the show is over. A save point is never overwritten
//      (fleet_control snapshot) nor pruned (world_rollback prune).
//   3. The world, the cameras and the body come up with a continue start, the body HELD for the operator (go 'operator'):
//      it is raised and placed and does not start work.
//   4. The body is put on the colosseum's centre stand, then designated a gladiator (G-1) with its post: the stand, bowing
//      toward the throne (the sentry verb). It is still from the moment it is in the arena.
//   5. lanista runs the show with the board, the crowd, the guards and the ruler: wave 0 waits for the emperor's one
//      release, then every round in the book runs back to back (--auto), and a fall brings the TNT down as the crowd
//      raises red (--fall-tnt). When the show ends, the fleet and the cameras come down.
//
// Usage (developer door open, from Auren_Bot/):
//   node Auren_Workshop/tools/colosseum_show.js                       # the colosseum show from its save point, cameras watching
//   node Auren_Workshop/tools/colosseum_show.js --record=film         # the same with OBS bound and waiting for the board's record
//   node Auren_Workshop/tools/colosseum_show.js --take                # THE SHOW FILMS ITSELF, nobody pressing anything: the first
//                                                                     # round staged, every camera rolls, it is released 14 s into
//                                                                     # the recording (--take=<s>), the book runs, the take is cut
//                                                                     # and wrapped a few seconds after the TNT (lanista --take),
//                                                                     # then everything comes down
//   node Auren_Workshop/tools/colosseum_show.js --keep-world          # the world as it stands, no restore
// Flags: --bot=<name> (VedaBot) --template=<save point> (colosseum) --show=<name> (book: the waves saved from the board) --crowd=<n> (10)
//        --kit=<items> (iron sword, shield in the off hand, iron armour) --record=cameras|film (cameras)
// Exit codes: lanista's when the show ran; 2 when the bring-up stopped (the line above says where).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/colosseum_show.js');

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const BOT_DIR = path.join(__dirname, '..', '..');
const DEFAULTS = {
  bot: 'VedaBot', template: 'colosseum', show: 'book', crowd: '10', record: 'cameras',
  kit: 'iron_sword,shield,iron_helmet,iron_chestplate,iron_leggings,iron_boots',
};
const FLEET_UP_MS = 6 * 60 * 1000;   // the longest the bring-up may take before the bench gives up (Law 8)
const BODY_WAIT_MS = 60 * 1000;

const log = (msg) => console.log(`[COLOSSEUM] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const node = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(BOT_DIR, script), ...args], { cwd: BOT_DIR, encoding: 'utf8', ...opts });

function camerasDown() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(BOT_DIR, 'Auren_Workshop', 'scripts', 'start_cameras.ps1'), '-Down'], { cwd: BOT_DIR, stdio: 'ignore' });
}
function everythingDown(why) {
  log(`taking the seat down (${why})`);
  node('Auren_Workshop/fleet_control.js', ['down'], { stdio: 'ignore' });
  camerasDown();
  if (pointedFrom) { pointAt(pointedFrom); log(`the seat points at its own world '${pointedFrom}' again`); pointedFrom = null; }
}

// ── THE SAVE POINT'S WORLD ──────────────────────────────────────────────────────────────────────────────
// A save point lives under the world it was taken on (memory_snapshots/<world>/<name>, world_snapshots/<world>/<name>).
let pointedFrom = null;   // the world the seat ran before the show pointed it at the colosseum's; put back by everythingDown
const serverDir = () => require('@utils/workstation').needServerDir();
// saveWorlds(name) → the worlds holding a save point of that name.
function saveWorlds(name) {
  const root = path.join(serverDir(), 'memory_snapshots');
  return fs.existsSync(root) ? fs.readdirSync(root).filter(w => fs.existsSync(path.join(root, w, name))) : [];
}
// pointAt(world) — server.properties level-name, written while the server is down (Law 26: build while off).
function pointAt(world) {
  const file = path.join(serverDir(), 'server.properties');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, /^level-name=.*$/m.test(text)
    ? text.replace(/^level-name=.*$/m, `level-name=${world}`)
    : `${text.replace(/\n?$/, '\n')}level-name=${world}\n`);
}

// fleetUp(env, args) → Promise<{ ok, child, why }>: start_auren as a child; resolved once its startup steps are proved.
function fleetUp(env, args) {
  const child = spawn(process.execPath, [path.join(BOT_DIR, 'start_auren.js'), ...args], { cwd: BOT_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ child, ...r }); } };
    const timer = setTimeout(() => finish({ ok: false, why: `the fleet was not up after ${FLEET_UP_MS / 60000} min` }), FLEET_UP_MS);
    const onLine = (line) => {
      if (/✓|✗|SHUTDOWN/.test(line)) log(`fleet: ${line.replace(/^\[[^\]]+\]\s*\[FOREMAN\]\s*/, '').trim()}`);
      if (/the soak is running/.test(line)) { clearTimeout(timer); finish({ ok: true }); }
      if (/SHUTDOWN|✗/.test(line)) { clearTimeout(timer); finish({ ok: false, why: line.trim() }); }
    };
    let buf = '';
    const feed = (d) => { buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => { clearTimeout(timer); finish({ ok: false, why: `start_auren exited ${code} before the fleet was up` }); });
  });
}

async function main() {
  const args = { ...DEFAULTS, ...Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; })) };
  // `--take`: a show that films itself is a filmed show; the seconds are lanista's to read (its default with none given).
  if (args.take) args.record = 'film';
  if (!['cameras', 'film'].includes(args.record)) { console.error(`--record=${args.record}: cameras or film.`); return 2; }
  const set = require('./arena_set');
  require('../workshop_paths').registerAliases();

  // 1. A clean seat.
  everythingDown('before the show');

  // 2. The template world.
  if (!args['keep-world']) {
    const clear = require('@utils/record_homes').clearAuthorized();
    if (!clear.authorized) { log(`NOT RESTORED — ${clear.why}. Authorize clearing this seat first, or run with --keep-world.`); return 2; }
    const worlds = saveWorlds(args.template);
    if (worlds.length !== 1) {
      log(`NOT RESTORED — ${worlds.length ? `the save point '${args.template}' is held by ${worlds.length} worlds (${worlds.join(', ')})`
        : `no world holds a save point '${args.template}' (memory_snapshots/<world>/${args.template})`}`);
      return 2;
    }
    const own = require('@utils/server_settings').levelName(serverDir());
    if (own !== worlds[0]) { pointedFrom = own; pointAt(worlds[0]); log(`the seat runs '${own}'; pointed at the colosseum's world '${worlds[0]}' for the show`); }
    const r = node('Auren_Workshop/fleet_control.js', ['restore', `--name=${args.template}`, `--world=${worlds[0]}`]);
    if (r.status !== 0) { log(`NOT RESTORED — ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`); everythingDown('not restored'); return 2; }
    log(`the world is the save point '${args.template}' again (world '${worlds[0]}')`);
  }

  // 3. World, cameras, body: the body held.
  const seats = Object.keys(JSON.parse(fs.readFileSync(set.ARENA_CAMERAS, 'utf8'))).map(n => `Cam_${n}`);
  const env = { AUREN_RECORD: args.record, AUREN_CAMERAS: 'rider', AUREN_SEATS: seats.join(','), ...(args.record === 'film' ? { AUREN_FILM_ROLL: 'board' } : {}) };
  log(`raising the world, the cameras (${seats.join(', ')}, rider) and ${args.bot}, held`);
  const fleet = await fleetUp(env, ['--start', 'continue', '--only', args.bot, '--go', 'operator', '--soak', '180', '--landing', 'usual', '--wake', 'error,loop,crash,lost']);
  if (!fleet.ok) { log(`NOT UP — ${fleet.why}`); everythingDown('the bring-up stopped'); return 2; }

  // 4. The body on the stand, then the gladiator's post.
  const center = set.placed();
  if (!center) { log('NOT RUN — no colosseum is placed on this world (arena_set.js --place)'); everythingDown('no set'); return 2; }
  const d = set.design(), stand = set.toWorld(center, d.points.center), throne = set.toWorld(center, d.points.emperor);
  const rcon = require('@utils/rcon_link');
  const t0 = Date.now();
  for (;;) {
    const said = (await rcon.once([`tp ${args.bot} ${stand.x + 0.5} ${stand.y} ${stand.z + 0.5} 180 0`]))[0].body || '';
    if (/^Teleported/i.test(said.trim())) break;
    if (Date.now() - t0 > BODY_WAIT_MS) { log(`NOT RUN — ${args.bot} never stood in the world to be put on the stand (${said.trim() || 'no answer'})`); everythingDown('no body'); return 2; }
    await sleep(1000);
  }
  log(`${args.bot} is on the stand (${stand.x},${stand.y},${stand.z})`);
  const c = p => `${p.x},${p.y},${p.z}`;
  const armed = node('Auren_Workshop/fleet_control.js', ['verb', 'sentry', `--bot=${args.bot}`, '--kit=G-1', `--post=${c(stand)}`, `--face=${c(throne)}`]);
  if (armed.status !== 0) { log(`NOT RUN — the sentry verb was refused: ${(armed.stderr || armed.stdout || '').trim()}`); everythingDown('no gladiator'); return 2; }
  log(`${args.bot} is the gladiator G-1, its post the stand, bowing toward the throne`);

  // 5. The show.
  const show = spawn(process.execPath, [path.join(BOT_DIR, 'Auren_Workshop', 'tools', 'lanista.js'),
    `--bot=${args.bot}`, '--arena', '--time=noon', `--show=${args.show}`, '--board', `--crowd=${args.crowd}`, '--guard', '--ruler', '--gladiator', `--kit=${args.kit}`, '--auto', '--fall-tnt',
    ...(args.take ? [args.take === true ? '--take' : `--take=${args.take}`] : [])],
  { cwd: BOT_DIR, stdio: 'inherit' });
  const code = await new Promise(r => show.on('exit', r));
  log(`the show ended (lanista exit ${code})`);
  everythingDown('the show is over');
  if (fleet.child.exitCode === null) await new Promise(r => fleet.child.once('exit', r));
  // `--take`: with the seat down and its records still, camera files the cut left loose are wrapped into their take
  // (the recorder's own wrap; nothing loose is nothing to do).
  if (args.take) {
    const recorder = require('@utils/workstation').findRecorder();
    const wrapped = recorder && require(recorder).wrapTake();
    log(wrapped ? 'the take is wrapped in footage/' : 'THE TAKE IS NOT WRAPPED — the camera files are loose in footage/ (footage_clipper.js wrap)');
  }
  return code;
}

main().then(code => process.exit(code || 0));
