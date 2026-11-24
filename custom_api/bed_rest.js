// api: bed_rest — the hive's ONE bed is the crew's spawn point.
//
// THE BED STANDS IN THE LOBBY: the first bed the hive builds, in its open middle (bot_hive_lobby), walked to like any cell
// of the hive.
//
// A body registers by clicking the bed: by day the server answers "Respawn point set" and the body does not sleep; by
// night the click lays it down, which sets the spawn too, and it gets up at once. Any number of players may share one
// bed; each respawns on a free cell beside it, and a bed broken or blocked in sends them to world spawn. So:
//   - a body whose registration does not name the standing bed has a spawn_register job (assessors/spawn_bed), and
//     spawn_bed_executor walks it to the bed and clicks;
//   - death_manager stands down from its teleport when the body came back beside the bed (respawnedAtBed);
//   - while the server spawns phantoms, a body near the bed lies down in it for a moment once a day (needsRest, rest;
//     the phantom_rest job, phantom_rest_executor).
//
// THE REGISTRATION IS THE SERVER'S ANSWER, KEPT IN THIS BODY'S CHAIR (`spawn_bed`, the bed's head cell): written only on
// "Respawn point set", cleared when the server says the spawn is gone (mineflayer's `spawnReset`, the "no home bed"
// notice on respawn) or when the bed no longer stands where the chair names it.
// The whole crew sleeping the night out is mothballed: Mothballed/Night_skip.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { classifyFloor } = require('@utils/movement/terrain_predicates');

const TAG = 'bed_rest';
const isBed = (block) => !!block && /_bed$/.test(block.name);
// How near the bed a respawned body comes back: vanilla stands it on a free cell beside one of the bed's halves.
const RESPAWN_REACH = 3;

// The hive's spawn bed in world cells, { id, foot: Vec3, head: Vec3, standing }, or null when the hive is unsited or
// plans no bed. The first of the beds the hive builds (architect_config HIVES bot_hive `beds`). `standing` is sensed: both halves read as a bed; a cell out of view reads as not standing.
function spawnBed(bot = global.bot) {
  const { BOT_HIVE, BUILDS } = require('@thinking/architect_config');
  if (BUILDS[BOT_HIVE].beds < 1) return null;
  const spot = require('@kernel/corporate_headquarters').readBuildingChair(BOT_HIVE, 'set_buildspot');
  if (!spot?.transpose_origin || typeof spot.transpose_origin.x !== 'number') return null;
  const building = require('@kernel/blueprint_registry').getBuilding(BOT_HIVE);
  const bed = building.design_intent.beds[0];
  if (!bed) return null;
  const { placeOffset } = require('@perception/blueprint_survey');
  const centre = building.transpose_origin || { x: 0, y: 0, z: 0 };
  const cell = (p) => { const w = placeOffset(spot.transpose_origin, centre, p); return new Vec3(w.x, w.y, w.z); };
  const foot = cell(bed.foot), head = cell(bed.head);
  const standing = !!bot && isBed(bot.blockAt(foot)) && isBed(bot.blockAt(head));
  return { id: bed.id, foot, head, standing };
}

const botId = () => process.env.BOT_ID || 'default';
function chair() { return require('@kernel/corporate_headquarters').readBoardroomChair(botId(), {}) || {}; }
function writeRegistration(cell) {
  const hq = require('@kernel/corporate_headquarters');
  const c = chair();
  if (cell) c.spawn_bed = { x: cell.x, y: cell.y, z: cell.z, at: Date.now() };
  else delete c.spawn_bed;
  hq.writeBoardroomChair(botId(), c);
}

// The server takes this body's spawn away when the bed is gone at its respawn; the chair forgets it with the server.
let _boundTo = null;
function bind(bot) {
  if (_boundTo === bot) return;
  _boundTo = bot;
  bot.on('spawnReset', () => {
    if (!chair().spawn_bed) return;
    watcher.summary(TAG, 'SPAWN_LOST the server reset this body\'s spawn (its bed is gone or blocked) — registration cleared.');
    writeRegistration(null);
  });
}

// needsRegistration(bot) → the standing spawn bed this body has not registered at, or null. A bed on ground the route
// search refuses (a hive floor closed while it is built or repaired: navigator.closedBy) is not owed yet: no body may
// walk to it, and the job would only fail until the floor opens.
function needsRegistration(bot = global.bot) {
  if (!bot || !bot.entity) return null;
  bind(bot);
  const bed = spawnBed(bot);
  if (!bed || !bed.standing) return null;
  if (require('@locomotion/navigator').closedBy(bed.head)) return null;
  const at = chair().spawn_bed;
  return at && at.x === bed.head.x && at.y === bed.head.y && at.z === bed.head.z ? null : bed;
}

// A cell beside the bed a body can stand in: level with the bed, not a bed, air for feet and head, a standable floor, and
// no peer standing in it. The whole crew registers at one bed, so the cells a peer holds are passed over.
function standBeside(bot, bed) {
  const air = (b) => !!b && b.boundingBox === 'empty';
  const from = bot.entity.position;
  const peers = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.type === 'player' && e.position)
    .map(e => e.position.floored());
  let best = null;
  for (const half of [bed.head, bed.foot]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = half.offset(dx, 0, dz);
      if (c.equals(bed.head) || c.equals(bed.foot)) continue;
      if (peers.some(p => p.x === c.x && p.z === c.z && Math.abs(p.y - c.y) <= 1)) continue;
      const feet = bot.blockAt(c), head = bot.blockAt(c.offset(0, 1, 0)), floor = bot.blockAt(c.offset(0, -1, 0));
      if (!air(feet) || !air(head) || !floor || isBed(floor) || !classifyFloor(bot, floor)) continue;
      const d = from.distanceTo(c.offset(0.5, 0, 0.5));
      if (!best || d < best.d) best = { cell: c, d };
    }
  }
  return best ? best.cell : null;
}

// inReach(bot, bed) → true when the server will take this body's click on the bed: its feet within the vanilla bed
// range of either half (3 blocks across, 2 up or down, from the half's floor centre) and the head within this body's
// interaction distance of its eyes.
const BED_RANGE_XZ = 3, BED_RANGE_Y = 2;
function inReach(bot, bed) {
  const { BLOCK_REACH } = require('@utils/fragment_utils');
  const p = bot.entity.position;
  const near = (c) => Math.abs(p.x - (c.x + 0.5)) <= BED_RANGE_XZ && Math.abs(p.y - c.y) <= BED_RANGE_Y
    && Math.abs(p.z - (c.z + 0.5)) <= BED_RANGE_XZ;
  const eye = p.offset(0, bot.entity.height || 1.62, 0);
  return (near(bed.head) || near(bed.foot)) && eye.distanceTo(bed.head.offset(0.5, 0.5, 0.5)) <= BLOCK_REACH;
}

// walkToBed(bot, bed, purpose) → { ok, why }: walk to the free cell beside the bed (or the nearest the body gets) and
// stand within reach of it. The whole crew comes to one bed.
async function walkToBed(bot, bed, purpose) {
  if (inReach(bot, bed)) return { ok: true, why: null };
  const stand = standBeside(bot, bed);
  if (!stand) return { ok: false, why: `${bed.id} has no free cell beside it` };
  await require('@locomotion/locomotion_dispatcher').goTo({ x: stand.x, y: stand.y, z: stand.z, leg: 'travel', purpose });
  if (inReach(bot, bed)) return { ok: true, why: null };
  const p = bot.entity.position.floored();
  return { ok: false, why: `the walk toward ${bed.id} ended at (${p.x},${p.y},${p.z}), out of reach of the bed` };
}

// THE SERVER'S ANSWER TO A CLICK. Vanilla refuses a bed too far off or obstructed before it touches the spawn; past those it
// sets the spawn (saying "Respawn point set" only when the spawn moves) and then refuses the sleep by day or beside
// monsters. So a refusal of the sleep is a registration too: it is the whole answer a body already registered there gets.
// An occupied bed is refused before any of it.
const SPAWN_SET = /respawn point set|sleep only at night|monsters nearby/i;
const NOT_SET = /too far away|obstructed|occupied/i;
const ANSWER_MS = 3000;
const WAKE_MS = 5000;

// freeBed(bot, bed) → { ok, block } once the bed reads as a bed and no peer lies in it, or { ok: false, why } when it is gone.
// THE BED HOLDS ONE. A peer lying in it (the block's own `occupied` state) gets up within its lie_ms, or at once after a
// night registration, so the body waits for the bed to free rather than being refused. Past occupied_wait_ms the click is
// made anyway and the server's own answer stands.
async function freeBed(bot, bed) {
  const { PHANTOM_REST } = require('@thinking/architect_config');
  const occupied = (b) => !!b && b.getProperties && b.getProperties().occupied === true;
  let block = bot.blockAt(bed.head);
  for (const until = Date.now() + PHANTOM_REST.occupied_wait_ms; ;) {
    if (!isBed(block)) return { ok: false, why: `${bed.id} no longer reads as a bed` };
    if (!occupied(block) || Date.now() >= until) return { ok: true, block };
    await new Promise(r => setTimeout(r, 250));
    block = bot.blockAt(bed.head);
  }
}

// getUp(bot) — asks the server to take the body out of its bed: the `entity_action` leave-bed command. mineflayer's wake()
// writes it as the number 2, which a server whose entity actions are a string mapper (entityActionUsesStringMapper) reads
// as stop_sprinting, so the body never leaves the bed. The command is named there, as place_authority.setSneak does.
// The server's wake animation then clears bot.isSleeping (mineflayer's entityWake).
function getUp(bot) {
  const actionId = bot.supportFeature('entityActionUsesStringMapper') ? 'leave_bed' : 2;
  bot._client.write('entity_action', { entityId: bot.entity.id, actionId, jumpBoost: 0 });
}

// secondBeat(bot) → resolves when the server has laid the body down or refused the sleep, or ANSWER_MS has passed.
function secondBeat(bot) {
  if (bot.isSleeping) return Promise.resolve();
  return new Promise((resolve) => {
    const onMsg = (m) => { if (/sleep only at night|monsters nearby/i.test(m)) done(); };
    const timer = setTimeout(done, ANSWER_MS);
    function done() { clearTimeout(timer); bot.removeListener('messagestr', onMsg); bot.removeListener('sleep', done); resolve(); }
    bot.on('messagestr', onMsg);
    bot.on('sleep', done);
  });
}

// register(bot, bed) → { ok, why }. Clicks the bed and waits for the server's answer. A click at night lays the body down
// (which sets the spawn as well); it is got up at once.
// A NIGHT QUEUE IS A WAIT, NOT A REFUSAL: at night every click lays its body down, so a crew registering together finds the one
// bed taken in turn. "Occupied" sends the body back to wait for the bed to free (freeBed), up to OCCUPIED_TRIES clicks.
const OCCUPIED_TRIES = 4;
async function register(bot, bed) {
  let r;
  for (let i = 0; i < OCCUPIED_TRIES; i++) {
    r = await registerOnce(bot, bed);
    if (r.ok || !/occupied/i.test(r.why || '')) return r;
  }
  return { ...r, why: `${r.why} (${OCCUPIED_TRIES} clicks)` };
}
async function registerOnce(bot, bed) {
  const { guardExternal } = require('@utils/external_library_guard');
  const free = await freeBed(bot, bed);
  if (!free.ok) return free;
  const block = free.block;
  const heard = new Promise((resolve) => {
    const onMsg = (m) => {
      if (SPAWN_SET.test(m)) done({ set: true, said: m });
      else if (NOT_SET.test(m)) done({ set: false, said: m });
    };
    const onSleep = () => done({ set: true, said: 'lay down' });
    const timer = setTimeout(() => done({ set: false, said: null }), ANSWER_MS);
    function done(v) {
      clearTimeout(timer); bot.removeListener('messagestr', onMsg); bot.removeListener('sleep', onSleep); resolve(v);
    }
    bot.on('messagestr', onMsg);
    bot.on('sleep', onSleep);
  });
  const click = await guardExternal(TAG, `click ${bed.id}`, () => bot.activateBlock(block));
  if (!click.ok) return { ok: false, why: `the click failed: ${click.reason}` };
  const answer = await heard;
  // "RESPAWN POINT SET" IS THE FIRST BEAT, NOT THE LAST: the server then either lays the body down (night) or refuses the
  // sleep (day, monsters). The body is got up only after that second beat, or a click at night leaves it in the bed
  // a moment after this check, and its next walk is set back into the bed step after step.
  if (answer.set && /respawn point set/i.test(answer.said || '')) await secondBeat(bot);
  if (bot.isSleeping) {
    await guardExternal(TAG, 'get up after registering', () => getUp(bot));
    // The body is up only once the server says so: a walk begun from the bed is set back into it, step after step.
    for (const by = Date.now() + WAKE_MS; bot.isSleeping && Date.now() < by;) await new Promise(r => setTimeout(r, 100));
    if (bot.isSleeping) return { ok: false, answered: true, why: `the body was still in ${bed.id} ${WAKE_MS / 1000}s after getting up` };
  }
  if (!answer.set) {
    return { ok: false, answered: !!answer.said, why: answer.said ? `the server refused: "${answer.said}"` : `no answer from the server within ${ANSWER_MS / 1000}s` };
  }
  writeRegistration(bed.head);
  return { ok: true, why: null, said: answer.said };
}

// respawnedAtBed(bot) → the spawn bed when this body stands beside it after a respawn, else null. death_manager asks it
// before choosing a recovery point: a body the server put at its bed is home already.
function respawnedAtBed(bot) {
  const bed = spawnBed(bot);
  if (!bed || !bed.standing) return null;
  const p = bot.entity.position;
  const near = (c) => Math.abs(Math.floor(p.x) - c.x) <= RESPAWN_REACH && Math.abs(Math.floor(p.z) - c.z) <= RESPAWN_REACH
    && Math.abs(Math.floor(p.y) - c.y) <= 2;
  return near(bed.head) || near(bed.foot) ? bed : null;
}

// ── PHANTOM REST (architect_config PHANTOM_REST) ─────────────────────────────────────────────────────────────────────
// Phantoms come to a player who has not slept for three days. The server's gamerule spawn_phantoms is the switch: asked
// over the console every PHANTOM_REST.ask_ms, and until the first answer, and whenever it cannot be asked, the rest is off.
const SLEEP_FROM_TICK = 12541, SLEEP_UNTIL_TICK = 23458;   // vanilla's window for lying down in clear weather
const _phantoms = { on: false, at: 0, asking: false };
function phantomsOn() {
  const { PHANTOM_REST } = require('@thinking/architect_config');
  // Asked only inside this body's planning turn (the spawn_bed assessor's read), where no other body is at the console;
  // a read outside it (the rest executor) takes the last answer.
  if (!_phantoms.asking && Date.now() - _phantoms.at >= PHANTOM_REST.ask_ms && require('@kernel/foreman_link').inPlanningTurn()) {
    _phantoms.asking = true;
    const { guardExternal } = require('@utils/external_library_guard');
    guardExternal(TAG, 'ask the server whether phantoms spawn', () => require('@utils/rcon_link').once(['gamerule spawn_phantoms']))
      .then((r) => {
        const body = r.ok ? (r.value?.[0]?.body || '') : '';
        const on = /\btrue\b/i.test(body);
        if (on !== _phantoms.on) watcher.summary(TAG, `PHANTOM_REST ${on ? 'on' : 'off'} — the server says: ${body || r.reason || 'nothing'}`);
        _phantoms.on = on;
      })
      .finally(() => { _phantoms.at = Date.now(); _phantoms.asking = false; });
  }
  return _phantoms.on;
}

// lastRestAge() → the world age (ticks) this body last lay down at, or null when it never has (its chair's `rested`).
function lastRestAge() {
  const at = chair().rested;
  return at && Number.isFinite(at.age) ? at.age : null;
}

// needsRest(bot) → the spawn bed when this body should lie down against phantoms now, else null: phantoms spawn, the
// bed stands on open ground, it is night (the lie-down window), the body is within PHANTOM_REST.near_blocks of the bed,
// and it has not lain down for longer than PHANTOM_REST.rest_after_ticks.
function needsRest(bot = global.bot) {
  if (!bot?.entity || !bot.time) return null;
  const { PHANTOM_REST } = require('@thinking/architect_config');
  if (!phantomsOn()) return null;
  const tod = bot.time.timeOfDay;
  if (!(tod >= SLEEP_FROM_TICK && tod <= SLEEP_UNTIL_TICK)) return null;
  const bed = spawnBed(bot);
  if (!bed || !bed.standing) return null;
  if (require('@locomotion/navigator').closedBy(bed.head)) return null;
  if (bot.entity.position.distanceTo(bed.head) > PHANTOM_REST.near_blocks) return null;
  const refused = chair().rest_refused_at;
  if (refused && Date.now() - refused < PHANTOM_REST.retry_ms) return null;
  const last = lastRestAge();
  return last === null || Number(bot.time.age) - last > PHANTOM_REST.rest_after_ticks ? bed : null;
}

// rest(bot, bed) → { ok, why }: lies down in the bed, stays PHANTOM_REST.lie_ms, gets up, and keeps the world age it lay
// down at on the chair. Lying down registers the spawn there too.
async function rest(bot, bed) {
  const { PHANTOM_REST } = require('@thinking/architect_config');
  const { guardExternal } = require('@utils/external_library_guard');
  const free = await freeBed(bot, bed);
  if (!free.ok) return free;
  const block = free.block;
  const lay = await guardExternal(TAG, `lie down in ${bed.id}`, () => bot.sleep(block));
  if (!lay.ok) {
    const c = chair();
    c.rest_refused_at = Date.now();
    require('@kernel/corporate_headquarters').writeBoardroomChair(botId(), c);
    return { ok: false, why: `the lie-down was refused: ${lay.reason}` };
  }
  await new Promise(r => setTimeout(r, PHANTOM_REST.lie_ms));
  if (bot.isSleeping) await guardExternal(TAG, 'get up after resting', () => getUp(bot));
  const c = chair();
  c.rested = { age: Number(bot.time.age), at: Date.now() };
  require('@kernel/corporate_headquarters').writeBoardroomChair(botId(), c);
  writeRegistration(bed.head);
  return { ok: true, why: null };
}

module.exports = { spawnBed, needsRegistration, standBeside, inReach, walkToBed, register, respawnedAtBed, needsRest, rest };
