// foreman/threat_board.js — THE THREAT BOARD: THE FOREMAN KEEPS THE CREW'S TARGETS, AND THE T-1 WORKS THE LIST IT IS GIVEN.
//
// The foreman controls the board; a full-time terminator (designations letter T) executes it. The board is read off the
// keeper's own body, which hangs over the base and is sent every monster the server tracks round it, so one reading serves
// the whole crew and no body reports what it sees (integrity_keeper.js SCOPE: entities reach only the body).
//
// ── WHAT GOES ON IT ───────────────────────────────────────────────────────────────────────────────────
// A THREAT is a mob the keeper's body sees that is all four:
//   1. hostile (threat_scanner.isHostile) and one the crew swings at first (combat_utils.shouldInitiate) or a terminator
//      takes (combat_utils.terminatorTakes); never a phantom, which a walk up to would only circle; an enderman only while it
//      is angry (combat_utils.endermanAngry), since one left alone harms no body;
//   2. on the surface: nothing solid above it to the top of the world (surface_filter.underSky; logs and leaves let the
//      sky through), so a mob in a cave or the mine is not the T-1's;
//   3. inside the threat zone: within THREAT_ZONE_B of a sited structure's origin;
//   4. not standing in water.
// A threat leaves the board when it dies (the server's entityDead), when it stops being all four, or when the body has not
// seen it for LOST_MS.
// A CALL is a mob a body ran from, put on the board by the help desk (addCall). It has no zone and no surface rule: a body
// of the crew is in trouble with it. It leaves when it dies, when the T-1 that took it finishes it, or after CALL_MAX_MS.
// One mob is one entry (`mob:<id>`): a threat that becomes a call is the call.
//
// ── THE LIST EACH T-1 IS GIVEN ────────────────────────────────────────────────────────────────────────
// For every T-1 in the world (its chair names a T designation and carries a body cell) the board orders its own list:
// calls first, then threats, the nearest to that T-1 first within each, leaving out a target another T-1 holds and one this
// T-1 finished without a kill within PASS_MS. The T-1 takes the first key when it has no target in hand
// (terminator_planner), says in its chair which target it holds (`t_target`) and, when it is done, which and why
// (`t_finished`), and reads the list again.
//
// ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────────────
// Subject `threats`: { generated_at, zone_b, anchors, targets: [{ key, source, id, name, pos, seen_ms, held_by, call,
// caller }], lists: { [t1]: [key] } }, posted on a change at most every POST_MS and renewed every RENEW_MS unchanged.
// Logged: THREAT_ON, THREAT_OFF, THREAT_TAKEN, THREAT_FINISHED.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const timeoutCrash = require('@utils/timeout_crash');
const { THREAT_ZONE_B } = require('@thinking/architect_config');
const { isBuildingTombstone } = require('./message_schema');

const TAG = 'threat_board';
const TICK_MS = 1000;            // how often the keeper's body is read for threats
const POST_MS = 1000;            // a changed board goes out at most this often
const RENEW_MS = 10000;          // an unchanged board is renewed this often
const LOST_MS = 5000;            // a threat the body has not seen this long is off the board
const CALL_MAX_MS = 300000;      // a call no one has ended is off the board after this
const PASS_MS = 60000;           // a target a T-1 finished without a kill is left off its list this long
const NOT_TAKEN = new Set(['phantom']);

let _bot = null;
let _plans = () => ({});
let _chairs = () => ({});
let _publish = () => {};
let _timer = null;
const _targets = new Map();      // key → { key, source, id, name, pos, first, seen, call, caller }
const _dead = new Set();         // mob ids the server said died since the last tick
const _passed = new Map();       // `${t1}|${key}` → until when that T-1's list leaves it out
const _finishedAt = new Map();   // t1 → the `at` of the last t_finished read from its chair
const _held = new Map();         // key → the T-1 holding it, as last said
let _sentKey = '';
let _postedAt = 0;

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const cell = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const round = (p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });
const onDead = (e) => { if (e && e.id != null) _dead.add(e.id); };

// anchors() → [{ name, x, z }]: every sited structure's origin; the zone is THREAT_ZONE_B round any of them.
function anchors() {
  const { roomKeyName } = require('./message_schema');
  const out = [];
  for (const [roomKey, entry] of Object.entries(_plans() || {})) {
    if (!entry || isBuildingTombstone(entry)) continue;
    const o = entry.set_buildspot && entry.set_buildspot.transpose_origin;
    if (o && typeof o.x === 'number') out.push({ name: roomKeyName(roomKey), x: o.x, z: o.z });
  }
  return out;
}

// threatNow(e, zone) → why the entity is not a threat now, or null when it is one (the four rules above).
function threatNow(e, zone) {
  const { isHostile } = require('@perception/threat_scanner');
  const { shouldInitiate, terminatorTakes, endermanAngry } = require('@utils/combat_utils');
  if (!isHostile(e) || NOT_TAKEN.has(String(e.name))) return 'not_hostile';
  if (!shouldInitiate(e.name) && !terminatorTakes(e.name)) return 'neutral';
  if (e.name === 'enderman' && !endermanAngry(_bot, e)) return 'calm_enderman';
  if (!zone.some((a) => flat(e.position, a) <= THREAT_ZONE_B)) return 'out_of_zone';
  const feet = e.position.floored();
  const at = _bot.blockAt(feet);
  if (at && (at.name === 'water' || at.name === 'flowing_water')) return 'in_water';
  const reader = { blockAt: (x, y, z) => _bot.blockAt(new Vec3(x, y, z)) };
  if (!require('@perception/surface_filter').underSky(reader, { x: feet.x, y: feet.y + 1, z: feet.z })) return 'not_under_sky';
  return null;
}

function off(t, why) {
  _targets.delete(t.key);
  _held.delete(t.key);
  watcher.summary(TAG, `THREAT_OFF key=${t.key} source=${t.source} mob=${t.name}#${t.id} why=${why} on_s=${Math.round((Date.now() - t.first) / 1000)} at=${cell(t.pos)}`);
}

// addCall(mob, caller, call) — the help desk puts a mob a body ran from on the board ({ id, name, pos }).
function addCall(mob, caller, call) {
  const key = `mob:${mob.id}`;
  const now = Date.now();
  const had = _targets.get(key);
  _targets.set(key, { key, source: 'called', id: mob.id, name: mob.name, pos: (had && had.pos) || mob.pos, first: now, seen: had ? had.seen : 0, call, caller });
  watcher.summary(TAG, `THREAT_ON key=${key} source=called mob=${mob.name}#${mob.id} call=${call} caller=${caller}${had ? ' (was a threat)' : ''} at=${cell(mob.pos)}`);
  // A call does not wait for the board's next post: a body of the crew is in trouble now.
  _sentKey = '';
  _postedAt = 0;
  if (_timer) tick();
}

// t1s(chairs) → [{ id, at }] every T-1 in the world: a T designation and a body cell in its chair.
function t1s(chairs) {
  const out = [];
  for (const [id, c] of Object.entries(chairs)) {
    if (!c || typeof c.designation !== 'string' || !c.designation.startsWith('T-')) continue;
    const b = c.body_cell;
    if (b && typeof b.x === 'number') out.push({ id, at: b, chair: c });
  }
  return out;
}

// readChairs(list, now) — each T-1's word on the target it holds and the one it finished.
function readChairs(list, now) {
  for (const { id, chair } of list) {
    const f = chair.t_finished;
    if (f && typeof f.key === 'string' && f.at !== _finishedAt.get(id)) {
      _finishedAt.set(id, f.at);
      const t = _targets.get(f.key);
      watcher.summary(TAG, `THREAT_FINISHED t1=${id} key=${f.key} why=${f.why}${t ? ` source=${t.source}` : ' (off the board already)'}`);
      if (!/^(killed|gone|ended)/.test(String(f.why))) _passed.set(`${id}|${f.key}`, now + PASS_MS);
      if (t && t.source === 'called') off(t, `finished by ${id}: ${f.why}`);
    }
    const key = typeof chair.t_target === 'string' ? chair.t_target : null;
    for (const [k, by] of [..._held]) if (by === id && k !== key) _held.delete(k);
    // The first T-1 to name a target holds it: a second naming the same mob (both read their lists before either chair
    // arrived) does not take it from the first, so the holder does not swap back and forth on every read.
    if (key && _targets.has(key) && !_held.has(key)) {
      _held.set(key, id);
      watcher.summary(TAG, `THREAT_TAKEN t1=${id} key=${key}`);
    }
  }
}

function tick() {
  const now = Date.now();
  const zone = anchors();
  if (_bot && _bot.entity && _bot.entity.position) {
    for (const e of Object.values(_bot.entities || {})) {
      if (!e || e === _bot.entity || !e.position || e.isValid === false || e.type === 'player') continue;
      const key = `mob:${e.id}`;
      const t = _targets.get(key);
      if (t) { t.pos = e.position.clone(); t.seen = now; }
      if (t && t.source === 'called') continue;
      const why = threatNow(e, zone);
      if (!why && !t) {
        _targets.set(key, { key, source: 'threat', id: e.id, name: e.name, pos: e.position.clone(), first: now, seen: now, call: null, caller: null });
        watcher.summary(TAG, `THREAT_ON key=${key} source=threat mob=${e.name}#${e.id} at=${cell(e.position)}`);
      } else if (why && t) off(t, why);
    }
  }
  for (const t of [..._targets.values()]) {
    if (_dead.has(t.id)) { off(t, 'killed'); continue; }
    if (t.source === 'threat' && now - t.seen > LOST_MS) { off(t, 'unseen'); continue; }
    if (t.source === 'called' && now - t.first > CALL_MAX_MS) off(t, 'call_expired');
  }
  _dead.clear();
  for (const [k, until] of [..._passed]) if (now > until) _passed.delete(k);
  const chairs = _chairs() || {};
  const list = t1s(chairs);
  readChairs(list, now);
  const lists = {};
  for (const { id, at } of list) {
    const mine = [..._targets.values()].filter((t) => !(_held.has(t.key) && _held.get(t.key) !== id) && !_passed.has(`${id}|${t.key}`));
    mine.sort((a, b) => (a.source === 'called' ? 0 : 1) - (b.source === 'called' ? 0 : 1) || flat(a.pos, at) - flat(b.pos, at));
    lists[id] = mine.map((t) => t.key);
  }
  const key = `${[..._targets.keys()].join('+')}|${[..._held].join('+')}|${JSON.stringify(lists)}`;
  if ((key !== _sentKey && now - _postedAt >= POST_MS) || now - _postedAt >= RENEW_MS) {
    _sentKey = key;
    _postedAt = now;
    _publish('threats', {
      generated_at: new Date(now).toISOString(),
      renew_ms: RENEW_MS,
      zone_b: THREAT_ZONE_B,
      anchors: zone.length,
      targets: [..._targets.values()].map((t) => ({ key: t.key, source: t.source, id: t.id, name: t.name, pos: round(t.pos), seen_ms: t.seen ? now - t.seen : null, held_by: _held.get(t.key) || null, call: t.call, caller: t.caller })),
      lists,
    });
  }
}

// attach(bot) — the keeper's body; its entity table and the server's word of each death are what the board reads.
function attach(bot) {
  if (_bot === bot) return;
  if (_bot) _bot.removeListener('entityDead', onDead);
  _bot = bot;
  _bot.on('entityDead', onDead);
}

// start({ bot, plans, chairs, publish }) — plans() → the buildings the hub holds; chairs() → every connected body's chair;
// publish(subject, verdict) sends it out.
function start({ bot, plans, chairs, publish }) {
  if (_timer) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): start() called twice.`);
  _plans = plans;
  _chairs = chairs;
  _publish = publish;
  attach(bot);
  _timer = timeoutCrash.every(TAG, 'read the threats round the base and order each T-1\'s list', tick, TICK_MS);
  tick();
}

function stop() {
  if (_timer) timeoutCrash.stop(_timer);
  _timer = null;
  if (_bot) _bot.removeListener('entityDead', onDead);
}

module.exports = { start, attach, stop, addCall, tick };
