'use strict';
// prediction_engine — where a mob and this body will be a moment from now, from the server's own position updates, and
// what the field will cost the body at each spot it could stand on next (THE FIELD AHEAD, below).
//
// ── WHY A PREDICTION ────────────────────────────────────────────────────────────────────────────────
// The server sends a walking mob's position only every three or four ticks (140–220 ms), so
// between updates the client holds a position up to a fifth of a second old. A creeper lights its fuse 3.0 b from the
// body, centre to centre (CreeperSwellGoal, distanceToSqr < 9), and the 3.0 b reach to its box first touches it about
// 3.4 b out: a window narrower than the ground a creeper covers between two updates. Judged on the stale position the
// first swing nearly always left with the creeper already inside its fuse distance (0 of 16 fights won unlit); judged
// on the predicted one, 15 of 16 (lanista --striker).
//
// The reach itself never changes: BOT_STRIKE_REACH, measured by combat_utils.reachGap exactly as a seen position is.
// Only the stale position is carried forward: the mob along the speed between its last two updates, the body along
// its own velocity.
//
// Sensing only (Invariant D): it moves nothing and says nothing; gunner and driver read it.

const { reachGap } = require('@utils/combat_utils');

// The swing is handled on the server's next tick, so the mob is judged where it will be then.
const SWING_LEAD_MS = 50;
// A walking mob's updates come up to ~350 ms apart on rolling ground; a report older than this is not carried further.
const STALE_CAP_MS = 400;
// A position change smaller than this between two updates is a mob standing where it was.
const MOVE_EPS_B = 0.03;
// The body's own travel once its keys drop, in ticks of its present velocity: ground friction leaves 0.546 of the
// speed each tick, so the coast sums to about 1.2 ticks of it.
const COAST_TICKS = 1.2;
const TICK_MS = 50;

let tracks = new Map();   // id → { at, x, z, vx, vz, movedAt } — vx/vz in b/ms, null until a second update
let movedHandler = null, goneHandler = null, attachedTo = null;

function onMoved(e) {
  if (!e || e.type === 'player' || !e.position) return;
  const now = Date.now();
  const t = tracks.get(e.id);
  const shifted = !t || Math.hypot(e.position.x - t.x, e.position.z - t.z) > MOVE_EPS_B;
  const next = { at: now, x: e.position.x, z: e.position.z, vx: null, vz: null, movedAt: shifted ? now : t.movedAt };
  if (t && now > t.at) {
    next.vx = (e.position.x - t.x) / (now - t.at);
    next.vz = (e.position.z - t.z) / (now - t.at);
  } else if (t) { next.vx = t.vx; next.vz = t.vz; }
  tracks.set(e.id, next);
}

// start(bot)/stop(bot) — the position-update listener, attached for the process with the commander (Law 8).
function start(bot) {
  if (attachedTo) return;
  tracks = new Map();
  movedHandler = onMoved;
  goneHandler = (e) => { if (e) tracks.delete(e.id); };
  bot.on('entityMoved', movedHandler);
  bot.on('entityGone', goneHandler);
  attachedTo = bot;
}

function stop(bot) {
  const b = bot || attachedTo;
  if (!b || !movedHandler) return;
  b.removeListener('entityMoved', movedHandler);
  b.removeListener('entityGone', goneHandler);
  movedHandler = null; goneHandler = null; attachedTo = null;
  tracks = new Map();
}

// mobAt(entity, leadMs) → where the mob will be `leadMs` from now: its last reported position carried along its measured
// speed for the age of that report plus the lead (capped at STALE_CAP_MS). The reported position when no speed is known.
function mobAt(entity, leadMs, now = Date.now()) {
  const t = entity && tracks.get(entity.id);
  if (!t || t.vx === null || now - t.at > STALE_CAP_MS) return entity.position;
  const dt = Math.min(STALE_CAP_MS, Math.max(0, now - t.at) + leadMs);
  return entity.position.offset(t.vx * dt, 0, t.vz * dt);
}

// selfAt(bot, ticks) → where this body will be `ticks` from now on its present velocity (mineflayer's, b per tick).
function selfAt(bot, ticks) {
  const p = bot.entity.position, v = bot.entity.velocity;
  if (!v) return p;
  return p.offset(v.x * ticks, 0, v.z * ticks);
}

// swingGap(bot, entity) → the reach the swing is judged at: from the body where it will be when the server handles the
// swing to the mob where it will be then. null when either is unreadable.
function swingGap(bot, entity) {
  if (!bot.entity?.position || !entity?.position) return null;
  return reachGap(bot, selfAt(bot, SWING_LEAD_MS / TICK_MS), entity, mobAt(entity, SWING_LEAD_MS));
}

// stopGap(bot, entity, leadMs) → the flat centre-to-centre distance once this body has coasted to a stop and the mob has
// walked on for `leadMs`: the gap the feet can no longer change by letting go of their keys.
function stopGap(bot, entity, leadMs) {
  if (!bot.entity?.position || !entity?.position) return null;
  const me = selfAt(bot, COAST_TICKS);
  const it = mobAt(entity, leadMs);
  return Math.hypot(me.x - it.x, me.z - it.z);
}

// closing(bot, entity) → b/s the mob is walking toward this body (negative walking away, 0 standing still), null with
// no measured speed.
function closing(bot, entity) {
  const t = entity && tracks.get(entity.id);
  if (!t || t.vx === null || !bot.entity?.position) return null;
  if (Date.now() - t.at > STALE_CAP_MS) return 0;
  const p = bot.entity.position, q = entity.position;
  const dx = p.x - q.x, dz = p.z - q.z, len = Math.hypot(dx, dz);
  if (!(len > 0)) return null;
  return ((t.vx * dx + t.vz * dz) / len) * 1000;
}

// stillMs(entity) → ms since the mob's position last changed: a stale report alone is not a stop, a walking mob's updates
// can be far apart. Infinity for a mob never seen to move.
function stillMs(entity, now = Date.now()) {
  const t = entity && tracks.get(entity.id);
  return t ? now - t.movedAt : Infinity;
}

// ── THE FIELD AHEAD: WHERE TO STAND NEXT ─────────────────────────────────────────────────────────────
// The T-1A's engine (designations ENGINES A), kept for human players: the driver runs it only while a player stands in the
// field (combat_utils.fieldAheadOn). A mixed field fights the body every way at once:
// blows within a brawler's reach, arrows from every shooter, a witch's throws, a creeper's blast. The body has two defences, its feet and its shield, and a spot answers all of them at once
// or none of them: a spot is good when no brawler can reach it, every shooter stands within the shield's one front half
// from it, no lit fuse can reach it, and the mob that matters most is nearer. So every spot a stride away is priced against
// the whole field as it will stand PLAN_LEAD_MS from now (each mob carried along its measured speed, mobAt), and the
// feet take the cheapest. A brawler standing between the body and the witch prices the straight line dear, so the walk
// curves round it; a witch ahead with archers behind prices the near side of her dear (the archers off the shield's
// half), so the walk goes past her and turns. The prices are in blocks: what a cost buys is walking that much further.
//
// threatPicture(active, swellingIds) → the field as the price reads it: one row per mob, its kind and its place ahead.
//   brawler  walks to the body and strikes (combat_utils BRAWLER); priced by its reach.
//   shooter  shoots from where it stands (KITER): a skeleton's arrow, a drowned's trident, a witch's throw. Priced by
//            whether the shield's half can hold it.
//   fuse     a creeper: priced by its blast once lit, by its fuse distance before.
// spotCost(spot, picture, target) → { cost, terms }: the price of standing at `spot` (x, z), the terms named for the record.
const PLAN_LEAD_MS = 500;
const BRAWLER_KEEP_B = 2.4;       // a brawler nearer than this lands its blow (zombie reach ~2 b centre to centre, plus the step)
const BRAWLER_PRICE = 3;          // per block inside its keep
const STRIKE_STAND_B = 2.6;       // centre to centre: the arm's 3.0 b reach to the box, with the box's half-width spent
const TARGET_PRICE = 1;           // per block the priority target stands beyond the arm
const GUARD_HALF_DEG = 150;       // what the raised shield holds: 180° less the margin the guard's own lag needs
const GUARD_PRICE = 2;            // per 30° of the shooters' arc beyond what the shield holds
const GUARD_NEAR_B = 5;           // a brawler this near joins the shooters in what the shield must face
const BLAST_B = 5;                // a lit creeper's blast reaches the body hurt within this (a creeper's power 3)
const BLAST_PRICE = 6;            // per block inside a lit blast: no other cost outbids it
const FUSE_B = 3.2;               // an unlit creeper lights within 3 b of the body
const FUSE_PRICE = 2;

function threatPicture(active, swellingIds = [], now = Date.now()) {
  const { combatTactic } = require('@utils/combat_utils');
  const lit = new Set(swellingIds);
  const out = [];
  for (const h of active || []) {
    if (!h || !h.entity || !h.entity.position) continue;
    const at = mobAt(h.entity, PLAN_LEAD_MS, now);
    const kind = h.name === 'creeper' ? 'fuse' : combatTactic(h.name, h.entity) === 'KITER' ? 'shooter' : 'brawler';
    out.push({ id: h.id, name: h.name, kind, x: at.x, z: at.z, lit: lit.has(h.id) });
  }
  return out;
}

// arcDeg(spot, points) → the narrowest arc (degrees) round `spot` holding every point: what the shield must face.
function arcDeg(spot, points) {
  if (points.length < 2) return 0;
  const a = points.map((p) => Math.atan2(p.z - spot.z, p.x - spot.x)).sort((p, q) => p - q);
  let widestGap = 2 * Math.PI - (a[a.length - 1] - a[0]);
  for (let i = 1; i < a.length; i++) widestGap = Math.max(widestGap, a[i] - a[i - 1]);
  return (2 * Math.PI - widestGap) * 180 / Math.PI;
}

function spotCost(spot, picture, target = null) {
  const terms = { brawler: 0, guard: 0, blast: 0, fuse: 0, target: 0 };
  const faced = [];
  for (const t of picture) {
    const d = Math.hypot(t.x - spot.x, t.z - spot.z);
    if (t.kind === 'brawler') {
      if (d < BRAWLER_KEEP_B) terms.brawler += BRAWLER_PRICE * (BRAWLER_KEEP_B - d);      if (d < GUARD_NEAR_B) faced.push(t);
    } else if (t.kind === 'shooter') {
      faced.push(t);
    } else if (t.lit) {
      if (d < BLAST_B) terms.blast += BLAST_PRICE * (BLAST_B - d);
    } else if (d < FUSE_B) {
      terms.fuse += FUSE_PRICE * (FUSE_B - d);
    }
  }
  const arc = arcDeg(spot, faced);
  if (arc > GUARD_HALF_DEG) terms.guard = GUARD_PRICE * (arc - GUARD_HALF_DEG) / 30;
  if (target) {
    const t = picture.find((p) => p.id === target.id);
    if (t) {
      const d = Math.hypot(t.x - spot.x, t.z - spot.z);
      // A shooter is walked to: it never comes. A brawler is held at the arm's length: it comes by itself.
      terms.target = TARGET_PRICE * (t.kind === 'shooter' ? Math.max(0, d - STRIKE_STAND_B) : Math.abs(d - STRIKE_STAND_B));
    }
  }
  const cost = terms.brawler + terms.guard + terms.blast + terms.fuse + terms.target;
  return { cost, terms, arc: Math.round(arc) };
}

module.exports = {
  start, stop, mobAt, selfAt, swingGap, stopGap, closing, stillMs, SWING_LEAD_MS, COAST_TICKS,
  threatPicture, spotCost, arcDeg, PLAN_LEAD_MS,
};
