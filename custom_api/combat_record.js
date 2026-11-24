// module: combat_record
// purpose: the fleet's one combat ledger. Every combat fact and every combat decision a body makes is one JSON object on
//          its own trace line, whole by itself: when, which body, which fight, what kind of fact, the body's own state
//          (place, health, food, shield, hand, effects) and the fact's fields. A fight is rebuilt afterwards by reading these rows
//          in time order, with no prose matched and no line joined to another (Law 26). `--fight-record` reads it.
//
// contract:
//  - record(kind, fields) writes one row now. `kind` is [a-z_]+; fields are plain values.
//  - openFight(source) / closeFight() bracket a wave (battle_stations); every row between carries its `fight` id.
//  - start(bot) listens for the server's own word on a hit (entityHurt) and a death (entityDead), so a swing is
//    resolved as a hit or a miss and a mob this body last struck is booked as its kill.
//  - mirror(seat, verb, fields) carries a crew seat's crew_log event into the ledger (crew_log calls it for the
//    combat seats), so every decision the seats already announce is a row here too.
//  - parse(raw) reads a trace line back into the row, or null. Writer and reader live here together (Law 10).
//
// Kinds written here: fight_open, fight_close, swing, hit, miss, kill, backup_call, backup_call_end, backup_answer,
// backup_drop, flee_start, flee_end, and `seat` for every mirrored crew_log event (its `seat` and `verb` say which).

'use strict';

const TAG = 'combat_record';
const SCHEMA = 1;
const SWING_RESOLVE_MS = 500;   // the server's hurt for a swing lands within a tick or two; past this it was a miss
const KILL_CREDIT_MS = 3000;    // a mob dying this soon after this body's last landed hit is this body's kill

let _watcher = null;
const watcher = () => (_watcher || (_watcher = require('@kernel/watcher')));

let seq = 0;
let fightNo = 0;
let fight = null;               // { id, source, at }
const pending = new Map();      // mob id → { seq, at, mob } — swings waiting on the server's hurt
const landed = new Map();       // mob id → { at, name } — this body's last hit on each mob
let attached = false;

const botId = () => process.env.BOT_ID || 'default';
const round = (n, p = 2) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);
const mobOf = (e) => (e ? { name: e.name || e.displayName || 'unknown', id: e.id != null ? e.id : null } : null);

// The body as it stands at the row, read off the live bot (Invariant B).
function me() {
  const bot = global.bot;
  if (!bot || !bot.entity || !bot.entity.position) return null;
  const p = bot.entity.position;
  const off = bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] : null;
  return {
    x: round(p.x, 1), y: round(p.y, 1), z: round(p.z, 1),
    hp: round(bot.health, 1), food: typeof bot.food === 'number' ? bot.food : null,
    shield: !!(off && off.name === 'shield'),
    hand: (bot.heldItem && bot.heldItem.name) || null,
    // Status effects as `name:level` (poison:1); empty when none. Required here, not at load: combat_utils loads crew_log,
    // which loads this file.
    effects: require('@utils/combat_utils').activeEffects(bot).map((e) => `${e.name}:${e.amp + 1}`),
  };
}

// The world's clock at the row, as the server last sent it: `tod` the time of day in ticks (0 sunrise, 6000 noon,
// 12000 sunset, 18000 midnight), `day` the world's day number, `phase` the fleet's own reading (dusk and night are
// architect_config's isDuskTime / isNightTime, the clock the night gate reads).
function game() {
  const bot = global.bot;
  if (!bot || !bot.time || typeof bot.time.timeOfDay !== 'number') return null;
  const cfg = require('@thinking/architect_config');
  return { tod: bot.time.timeOfDay, day: typeof bot.time.day === 'number' ? bot.time.day : null,
    phase: cfg.isNightTime() ? 'night' : cfg.isDuskTime() ? 'dusk' : 'day' };
}

function record(kind, fields = {}) {
  if (!/^[a-z_]+$/.test(String(kind))) throw new Error(`combat_record: kind "${kind}" is not [a-z_]+ (Law 13)`);
  const row = { v: SCHEMA, t: Date.now(), bot: botId(), seq: ++seq, fight: fight ? fight.id : null, kind, game: game(), me: me(), ...fields };
  watcher().summary(TAG, JSON.stringify(row));
  return row.seq;
}

// ── THE FIGHT BRACKET ──
function openFight(source) {
  fightNo++;
  fight = { id: `${botId()}:${fightNo}`, source: source || null, at: Date.now() };
  record('fight_open', { source: fight.source });
  return fight.id;
}
function closeFight(fields = {}) {
  if (!fight) return;
  record('fight_close', { ms: Date.now() - fight.at, ...fields });
  fight = null;
}
const fightId = () => (fight ? fight.id : null);

// ── SWINGS, RESOLVED BY THE SERVER ──
// swing(entity, fields) writes the swing and waits SWING_RESOLVE_MS for the server to say the mob was hurt.
function swing(entity, fields = {}) {
  const mob = mobOf(entity);
  const n = record('swing', { mob, ...fields });
  if (!mob || mob.id == null) return;
  const prior = pending.get(mob.id);
  if (prior) resolveMiss(mob.id, prior);
  const entry = { seq: n, at: Date.now(), mob };
  pending.set(mob.id, entry);
  require('@utils/timeout_crash').later(TAG, 'resolve a swing the server has not answered as a miss', () => {
    if (pending.get(mob.id) === entry) resolveMiss(mob.id, entry);
  }, SWING_RESOLVE_MS);
}
function resolveMiss(id, entry) {
  pending.delete(id);
  record('miss', { mob: entry.mob, swing: entry.seq, waited_ms: Date.now() - entry.at });
}
// mobHealth(entity) → the mob's health as the server last sent it: mineflayer's own field, else the living entity's health
// metadata (index 9, a float). It is read on the hurt, before the metadata that carries this blow, so each hit row shows
// the health the blow landed on.
function mobHealth(entity) {
  if (Number.isFinite(entity.health)) return entity.health;
  const m = entity.metadata && entity.metadata[9];
  return typeof m === 'number' ? m : null;
}
function onHurt(entity) {
  if (!entity || entity.id == null) return;
  const entry = pending.get(entity.id);
  if (!entry) return;
  pending.delete(entity.id);
  landed.set(entity.id, { at: Date.now(), name: entry.mob.name });
  record('hit', { mob: entry.mob, swing: entry.seq, after_ms: Date.now() - entry.at, mob_hp: round(mobHealth(entity), 1) });
}
function onDead(entity) {
  if (!entity || entity.id == null) return;
  const last = landed.get(entity.id);
  landed.delete(entity.id);
  pending.delete(entity.id);
  if (!last || Date.now() - last.at > KILL_CREDIT_MS) return;
  record('kill', { mob: mobOf(entity), last_hit_ms: Date.now() - last.at });
}

// ── MIRRORED SEAT EVENTS (crew_log) ──
const SEATS = new Set(['commander', 'gunner', 'driver', 'battle_stations', 'self_preservation', 'combat_board', 'enderman_gaze']);
function mirror(seat, verb, fields = {}) {
  if (!SEATS.has(String(seat).toLowerCase())) return;
  const { subject, ...rest } = fields;
  const m = typeof subject === 'string' ? subject.match(/^(.+)#(\d+)$/) : null;
  record('seat', { seat: String(seat).toLowerCase(), verb, mob: m ? { name: m[1], id: Number(m[2]) } : (subject || null), fields: rest });
}

function start(bot) {
  if (attached) return;
  attached = true;
  bot.on('entityHurt', onHurt);
  bot.on('entityDead', onDead);
}

// parse(raw) → the row, or null for any line that is not one of ours.
const LINE_RE = /\[COMBAT_RECORD\]\s*\S*\s*(\{.*\})\s*$/;
function parse(raw) {
  const m = typeof raw === 'string' ? raw.match(LINE_RE) : null;
  // The row is this file's own JSON.stringify; one that does not parse is a defect and travels (Law 16).
  return m ? JSON.parse(m[1]) : null;
}

module.exports = { record, openFight, closeFight, fightId, swing, mirror, start, parse, SCHEMA, SWING_RESOLVE_MS, KILL_CREDIT_MS };
