// The tank crew's gunner: owns the body's FACING and when it SWINGS, at tick rate. Decides nothing about
// where the body goes. start(bot) attaches a physicsTick handler; stop(bot) detaches it. While ENGAGED,
// re-reads the commander's target off crew_board every tick and snaps facing to one of eight compass
// points with a hysteresis band. ONLY writer of the yaw during an engagement (Invariant D). Never reads a
// plan, presses a movement key, sets sprint, or touches jump.
// NOTHING IN THIS FILE MAY AWAIT: an awaiting seat yields to the next tick and the crew rotation crosses
// itself; `combat_utils.equipBestWeapon` is a real server round trip, so SECTION 4b fires it un-awaited behind a
// pending latch. Sprint is the driver's key, never this seat's.
// THE ARM WORKS ALONE: the commander says a fight is on and which mobs are in it; this seat charges the swing while any
// of them stands in strike reach and, on the charged tick, strikes the closest of them (THE SWING TARGET). The
// commander's focus is the driver's chase target and only steers the facing between swings.

'use strict';

const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { quantizeYawSticky, YAW_HYSTERESIS_RAD } = require('@utils/movement/motion_primitives');
const { BOT_STRIKE_REACH } = require('@utils/combat_utils');
// Imports only each threat's time-to-land deadline, never the raw notch/swell decode (Law 16).
const { BOW_DRAW_MS, TRIDENT_THROW_MS, arrowFlightMs } = require('@utils/calculators/archer_calculator');
const { SWELL_TO_BLAST_MS } = require('@api/combat_counters/fuse_meter');
const predictionEngine = require('@api/combat_counters/prediction_engine');
const fireballReturn = require('@utils/fireball_return');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');
const Vec3 = require('vec3');
// The two terrain verbs, read from the modules that own them (Law 16); this seat supplies only facing/timing.
const { performDig } = require('@utils/movement/dig_authority');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { performPlace } = require('@utils/movement/place_authority');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
const { isBlockSolid, isDoorBlock } = require('@utils/pathfinding_utils');
const { isReplaceable } = require('@utils/movement/terrain_predicates');

const TAG = 'gunner';

// ── WHO THIS ARM HAS ACTUALLY LANDED ON — mob id → count of released swings that connected ──────────
// The kill-attribution fact: `battle_stations.retireTarget` reads it at every retirement (Law 25). Keyed
// by mob and never cleared mid-run — an entity is the unit, not the engagement.
const _connected = new Map();

// connectedTo(mobId) → how many of this arm's released swings landed on that mob.
function connectedTo(mobId) { return _connected.get(mobId) || 0; }
const writeBoard = crewBoard.claimPen('gunner');

// ---------------------------------------------------------------------------
// SECTION 1: State
// ---------------------------------------------------------------------------
// Module-level: one gunner per process. Reset at every engagement boundary (Law 8).
let attached = false;
let tickHandler = null;
let engaged = false;

// Held facing (radians) — the `held` half of the hysteresis.
let heldYaw = null;
let targetId = null;

// Cooldown cached against held-item name (equips change the name; 20 inventory scans/s buys nothing).
let cachedWeaponName = null;
let cachedCooldownMs = 625;

// EQUIP LATCH (SECTION 4b). `equipPending` marks a swap IN FLIGHT (Invariant B).
let equipPending = false;

// SHIELD LATCH. `shieldUp` = what was COMMANDED, not what the server did (Law 25).
let threatId = null;
let threatWhy = null;
let shieldUp = false;
let shieldUpAt = null;      // when the raise packet went out; the `held` half of the guard's cost
let shieldClearAt = null;   // when the threat stopped; the shield holds SHIELD_HOLD_MS past it
let resumingGuard = false;  // the guard was lowered for one swing and its next raise resumes it
let loweredAt = null;        // ms the shield last came down (THE LOWERING, lowerForSwing)
let restUntil = 0;           // THE VOLLEY REST: no guard is raised against a group of shooters before this
let lowerUnswung = false;    // lowered for a swing that has not been thrown yet
let kbSince = null;         // tick a knockback swing at a melee focus began waiting for sprint, or null
const KNOCKBACK_WAIT_TICKS = 3;
// A KNOCKBACK SWING ONCE BEGUN IS THROWN: the reach gate is read when the wait starts, and only an arrow, a friend in the
// sweep or the mob leaving strike reach calls it off. A wait re-judged every tick flaps the shield down and up on a mob
// whose distance jitters across the gate, and a shield raised for under 5 ticks blocks nothing. A called-off wait is
// not begun again for KNOCKBACK_RETRY_TICKS, so the re-raised shield stands long enough to block.
const KNOCKBACK_RETRY_TICKS = 10;
let kbRetryTick = 0;

let stats = null;
function _blankStats() {
  return {
    ticks: 0,            // ticks the gunner ran while engaged
    volleyRests: 0,      // guards lowered for THE VOLLEY REST
    aimed: 0,            // ticks a facing was WRITTEN (a quantum boundary was crossed)
    heldSteady: 0,       // ticks the band kept the existing facing though the bearing had moved
    switches: 0,         // same as `aimed`, kept separate because `aimed` counts the first aim too
    noTarget: 0,         // ticks engaged with no hostile in the entity table
    inReach: 0,          // ticks the closest mob was inside the strike reach
    charged: 0,          // ticks inside reach AND the swing clock was full
    swings: 0,           // packets actually released — the BOARD reads this
    swingsHeld: 0,       // ticks the arm was withheld because the guard was up — the price of his premise
    equipChecks: 0,      // times the hand was found off the pick before a charge
    equipFails: 0,       // swaps that came back empty-handed — no weapon anywhere in the pack
    barehandedSwings: 0, // swings released with an empty main hand
    sweepWithheldTicks: 0, // ticks in reach with a friend inside the sweep, so no swing was sent
    wallsTried: 0, wallsSet: 0, wallsFailed: 0, wallsStanding: 0, wallsFlanked: 0, wallTicks: 0,   // THE BLAST WALL
    fleeTicks: 0,   // ticks the body faced its run (A RUNNING BODY FACES ITS RUN)
    // The terrain errand's counters (Law 6): accepted−(done+failed+dropped) is the number in flight.
    terrainAccepted: 0,  // asks this seat took on
    terrainRefused: 0,   // asks turned away because the yaw was spoken for
    terrainDone: 0,      // jobs the seat believes changed the world — a claim, verified by the asker
    terrainFailed: 0,    // jobs attempted and not achieved
    terrainDropped: 0,   // jobs abandoned mid-flight because the want changed or stopped
    fastSwitches: 0,     // switches < STUTTER_GAP_TICKS apart — a working band drives this to 0
    minSwitchGapTicks: null,
    guardTicks: 0,       // SHIELD AUDIT (SECTION 2b), ticks only — raise/lower events carry the counts
    settleTicks: 0,            // guard ticks spent in the 5-tick hold AFTER the threat cleared
    swingLowers: 0,            // guards lowered for one swing (lowerForSwing)
    critSwings: 0, critWaitTicks: 0, critsLanded: 0, witchDashTicks: 0, charges: 0,
    knockbackSwings: 0,        // swings at a melee mob thrown with the driver's sprint held
    swingsOffChase: 0,         // swings at a mob other than the chase target (THE SWING TARGET)
    savedTicks: 0,             // ticks the arm was kept from a mob in reach for a creeper walking in (THE SAVED SWING)
    lowersUnswung: 0,          // shield lowered for a swing and raised again with none thrown
    knockbackAborted: 0,       // knockback waits called off before the swing (an arrow, a friend, the mob out of reach)
    knockbackUnsprinted: 0,    // knockback swings thrown at KNOCKBACK_WAIT_TICKS without sprint
    knockbackWaitTicks: 0,     // ticks a knockback swing waited, shield down, for sprint
    facedThreatOverClosest: 0, // ticks the facing was on something other than the nearest active mob
    guardArcTicks: 0,          // ticks the guard faced the middle of every blow's arc
    guardSplitTicks: 0,        // ticks the blows spread wider than one window and the most-covering window was faced
    swingsIntoArrow: 0,        // ticks a charged swing waited because a draw or an arrow would land in its window
    lastSwingAt: null,
  };
}
let lastSwitchTick = null;
// The terrain job IN FLIGHT — never a queued request (see serveTerrain).
let _job = null;
// dropJob — a job dropped while its dig is still swinging stops that dig, so the next dig the body starts
// begins clean instead of cancelling a break nobody is waiting on (mineflayer aborts a dig a new one replaces).
function dropJob(bot) {
  if (_job && !_job.settled && _job.kind === 'dig' && bot && bot.targetDigBlock) {
    guardExternalSync(TAG, 'stopDigging for a dropped terrain job', () => bot.stopDigging());
  }
  _job = null;
}
const STUTTER_GAP_TICKS = 4;   // 200 ms — two switches closer together than this are the judder

// ---------------------------------------------------------------------------
// SECTION 2: The two acts
// ---------------------------------------------------------------------------

// focusTarget() → the crew's COMMITTED target (commander's `focus`), or null. Monster data is derived
// only by the commander, which owns it (Law 16).
function focusTarget() {
  return crewBoard.readCommander().focus;
}

// ---------------------------------------------------------------------------
// SECTION 2b: The shield
// ---------------------------------------------------------------------------
// THE SHIELD IS FOR WHAT IS SHOT AND FOR A BLAST, NEVER FOR A MELEE BLOW (combat_utils WHAT THE SHIELD IS FOR). Two cases,
// both needing a shield in the off-hand (combat_utils.holdsShield):
//   notched_arrow — a TIMER, not a toggle: raises just before the arrow or trident lands and lowers 5 ticks after the
//     threat clears; only a mob whose shot a shield stops (combat_utils.shieldStops), so a witch drinking raises nothing.
//   swell — raises on its first tick (raiseAtOf), behind the blast wall or where the wall missed. A creeper is struck
//     with the knockback swing like any melee mob until it swells; from the swell it is never struck (THE SWING TARGET),
//     and is tanked behind the wall and the shield, never run from (driver).
// A melee mob is struck with the knockback swing as fast as the arm charges, the shield down. In a mixed fight the arm
// keeps striking the melee mob and the shield comes up only for each shot (NO SWING INTO AN ARROW).
// Triggers are server-read, not modelled (Law 23): the commander posts id lists (`swelling`, `notching`, `active`),
// sole announcer of combat data (Law 16). Only a positive signal raises (Law 25).
const SHIELD_ACTIVE_MS = 250;   // 5 ticks between the raise and the first block

// How long before the threat's deadline the raise fires (MARGIN) and how long the shield holds after the
// threat clears (HOLD), covering the arrow still in flight. Neither floors at 0.
const SHIELD_MARGIN_MS = 150;
const SHIELD_HOLD_MS = 150;
const STAY_UP_GAP_MS = 400;

// shieldOrder({ threats, now }) → { guard, why, against, againstName, since }. Pure decision, no
// bot/packets (Law 16). `threats` = [{ id, why, since }], each a deadline (notch, swell). Picks the EARLIEST threat; it
// sets the raise's timing, and takes the facing only when no mob is in focus (onPhysicsTick).
function shieldOrder({ threats, now }) {
  if (!threats || !threats.length) {
    return { guard: false, why: null, against: null, againstName: null, since: null };
  }
  // EVERY DRAW IS TIMED, not only the oldest: the guard is up while any threat's blow is due (hot), and it names the
  // due threat whose draw began first. A deadline shorter than the raise cost has no late moment: guard at once (Law 13).
  const due = threats.filter((t) => raiseAtOf(t) <= 0 || hot(t, now));
  let first = (due.length ? due : threats)[0];
  for (const t of (due.length ? due : threats)) if (t.since < first.since) first = t;
  // A SWELL IS NAMED BEFORE ANY DRAW: the volley rest lowers a guard named for an arrow, and one taken 1.2 s into a fuse
  // left the blast (16.6 hp) a shield raised 167 ms before it, short of the 250 ms a raise takes.
  const swell = due.find((t) => t.why === 'swell');
  if (swell) first = swell;
  const name = (first.entity && first.entity.name) || 'mob';
  return { guard: due.length > 0, why: first.why, against: first.id, againstName: name, since: first.since };
}

// A deadline threat's time to land from its start, and when its raise is due.
// A trident drowned's draw is its throw interval (drawMsOf).
function deadlineOf(t) { return t.why === 'swell' ? SWELL_TO_BLAST_MS : (t.drawMs || BOW_DRAW_MS); }
function drawMsOf(h) { return combatUtils.throwsTrident(h.entity) ? TRIDENT_THROW_MS : BOW_DRAW_MS; }
// A swell is guarded from its first tick: the client sees it late (a 1382 ms fuse measured against the 1500 ms one), so
// a timed raise came up with less than SHIELD_ACTIVE_MS to spare, and a swing inside a fuse rarely kills the creeper.
function raiseAtOf(t) { return t.why === 'swell' ? 0 : deadlineOf(t) - (SHIELD_ACTIVE_MS + SHIELD_MARGIN_MS); }
// hot(t, now) → this draw's blow can land before a shield raised now would block, or its arrow is in the air.
function hot(t, now) { return !!t.inFlight || now - t.since >= raiseAtOf(t); }

// ── NO SWING INTO AN ARROW ──────────────────────────────────────────────────────────────────────────
// A swing lowers the shield for up to SWING_EXPOSURE_MS: the wait for sprint, the swing tick, and the five ticks a
// re-raised shield takes to block again. No swing is thrown while any mob's draw would land inside that window or
// an arrow is in the air; the arm waits behind the shield and swings once the blow has been blocked.
const SWING_EXPOSURE_MS = 500;
// A BODY WITH NO SHIELD HAS NOTHING TO WAIT BEHIND: a draw or an arrow never holds its swing (a spear's charge reads as a
// draw, the item-use flag); only a swell does, which the driver answers by backing off.
// A spear wielder's raised charge marks no release: holding the swing for it would hold it for the whole fight, so it
// never holds the swing; its blows are taken on the shield raised between swings (THE SWING TARGET's throw window).
function swingBlocked(threats, now, shielded) {
  return threats.some((t) => (shielded || t.why === 'swell') && !(t.entity && combatUtils.wieldsSpear(t.entity))
    && (!!t.inFlight || now - t.since >= deadlineOf(t) - SWING_EXPOSURE_MS - SHIELD_MARGIN_MS));
}

// ── THE GUARD FACES THE BLOWS, NOT ONLY THE FOCUS ───────────────────────────────────────────────────
// The shield blocks every blow whose source stands within 90° of the facing (BlocksAttacks: one reduction, angle 90),
// a 180° front half. While the guard is up the body faces the GUARD_COVER_RAD window that covers the most of what can
// hit it now: every due draw and arrow in the air, and every melee mob within MELEE_HIT_B (the shield raised for a shot
// takes its blow too, while it is up), a melee mob within MELEE_CLOSE_B weighing double (its blow is the next one). It faces the middle of the covered mobs' own arc, so the
// margin to the cone's edge is the same on both sides. The window is held 30° inside the cone on each side for the lag between
// the client's view of a mob and the server's. The swing turns back to the focus on its own tick (onPhysicsTick).
const MELEE_HIT_B = 2.5;     // a melee mob this near can land its blow in the next moment
const MELEE_CLOSE_B = 2.0;
// 120, not 160: arrows from shooters held 73-80° off the facing landed on a moving body (4 of 6 in one fight, the arrow
// striking 90-111° off), so a shooter is only counted covered within 60° of the facing.
const GUARD_COVER_RAD = (120 * Math.PI) / 180;
const NEAR_SHOT_B = 6;
const NEAR_SHOT_W = 4;
const FLIGHT_W = 3;           // an arrow already in the air is the next blow: it outweighs a draw still being held
const QUIET_SHOOTER_W = 0.4;
function bearingTo(me, pos) { return Math.atan2(-(pos.x - me.x), -(pos.z - me.z)); }
const SWELL_W = 20;
function guardBearing(bot, threats, now, board) {
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  const melee = ((board && board.active) || []).filter((h) => h.entity && h.entity.position && h.distance <= MELEE_HIT_B
    && h.name !== 'creeper' && combatUtils.combatTactic(h.name, h.entity) === 'BRAWLER' && !threats.some((t) => t.id === h.id))
    .map((h) => ({ id: h.id, why: 'melee', entity: h.entity, distance: h.distance }));
  const set = threats.filter((t) => t.entity && t.entity.position && hot(t, now)).concat(melee);
  if (!set.length) return null;
  // EVERY SHOOTER, NOT ONLY THE ONE DRAWING (THE FIELD AHEAD): archers take turns, and a guard turned only to the draw
  // in hand meets the next one's arrow still facing the last. With the field ahead walking the body to where every
  // shooter stands within the shield's half, the guard faces them all: each quiet shooter weighs QUIET_SHOOTER_W, so a
  // draw or a blow still decides where the guard faces when they cannot all be held.
  const quiet = combatUtils.fieldAheadOn(board && board.active)
    ? ((board && board.active) || []).filter((h) => h.entity && h.entity.position && combatUtils.shieldStops(h.entity)
      && combatUtils.combatTactic(h.name, h.entity) === 'KITER' && !set.some((t) => t.id === h.id))
      .map((h) => ({ id: h.id, why: 'quiet_shooter', entity: h.entity }))
    : [];
  const TWO_PI = 2 * Math.PI;
  const pts = set.concat(quiet).map((t) => ({
    a: ((bearingTo(me, t.entity.position) % TWO_PI) + TWO_PI) % TWO_PI,
    // A lit creeper outweighs every blow beside it: its blast behind the guard is the whole health bar, a zombie's blow a tenth.
    // A DUE ARCHER WITHIN NEAR_SHOT_B OUTWEIGHS AN ARROW IN THE AIR: its arrow flies two ticks, so a guard that waits to see
    // it in flight turns too late (arena: five arrows in a row from 3.4 b landed on a guard turned 172° to them 57 ms
    // before, held until then on an archer 12 b off).
    w: t.why === 'swell' ? SWELL_W : t.why === 'notched_arrow' && me.distanceTo(t.entity.position) <= NEAR_SHOT_B ? NEAR_SHOT_W : t.inFlight ? FLIGHT_W : t.why === 'quiet_shooter' ? QUIET_SHOOTER_W : t.why === 'melee' && t.distance <= MELEE_CLOSE_B ? 2 : 1,
  }));
  // Every window starts on some threat's bearing; the best one covers the most weight, then the narrowest arc.
  let best = null;
  for (const s0 of pts) {
    let w = 0, arc = 0;
    for (const p of pts) {
      const off = (p.a - s0.a + TWO_PI) % TWO_PI;
      if (off <= GUARD_COVER_RAD) { w += p.w; if (off > arc) arc = off; }
    }
    if (!best || w > best.w || (w === best.w && arc < best.arc)) best = { w, arc, from: s0.a };
  }
  if (best.w === pts.reduce((m, p) => m + p.w, 0)) stats.guardArcTicks++; else stats.guardSplitTicks++;
  return best.from + best.arc / 2;
}

// senseThreats(board, now) → [{ id, why, since, entity }] for every active mob notching a shot a shield stops, or
// swelling, stamped with when ITS OWN current threat began. Decodes nothing (Law 16 — commander is sole announcer); turns
// a per-tick fact into a DURATION, which a stateless sweep can't hold.
// `drawStarts` dates every active mob's notch or swell, focus or not, so a draw begun while another mob held the
// focus keeps its true start when the focus moves onto it. Per-MOB and pruned the moment the fact stops (Invariant B).
const drawStarts = new Map();
// Mobs seen active with no draw on them. A notch or swell on a mob never seen quiet began before this seat could see
// it (a skeleton drawing as the fight opens), so its start is unknown and it is dated at its deadline: the shield
// goes up at once rather than on a fresh draw's timing (Law 13).
const seenQuiet = new Set();
// When each active mob's last notch cleared: the arrow is released, not landed. A focus that moves onto an archer whose
// arrow is still in the air is guarded for that flight, as a guard already up is held for it (applyShield's holdMs).
const releasedAt = new Map();
// EVERY SHOT ON THE FIELD IS GUARDED, the focus's or not: the body FIGHTS its focus, but its shield answers every draw a
// shield stops, so a skeleton notching behind the zombie being fought is blocked while the zombie is killed. A witch's
// raised hand is a drink, never a draw (combat_utils.shieldStops).
function senseThreats(board, now) {
  const swellingIds = board.swelling || [];
  const notchingIds = board.notching || [];
  const drawOf = (h) => (swellingIds.includes(h.id) ? 'swell'
    : notchingIds.includes(h.id) && combatUtils.shieldStops(h.entity) ? 'notched_arrow' : null);
  const live = new Set();
  for (const h of board.active || []) {
    live.add(h.id);
    const draw = drawOf(h);
    if (!draw) {
      const ended = drawStarts.get(h.id);
      if (ended && ended.why === 'notched_arrow') releasedAt.set(h.id, now);
      seenQuiet.add(h.id); drawStarts.delete(h.id); continue;
    }
    const prior = drawStarts.get(h.id);
    // A trident drowned's hand stays active through its throws: each throw (commander THE THROWN TRIDENT) is the release
    // and the next draw begins at it, so the swing opens after a throw and the guard is up again for the next.
    if (prior && prior.why === draw && draw === 'notched_arrow' && h.threwAt != null && h.threwAt > prior.since) {
      drawStarts.set(h.id, { why: draw, since: h.threwAt, drawMs: prior.drawMs });
      releasedAt.set(h.id, h.threwAt);
      crewLog.event(TAG, 'release', { subject: `${h.name}#${h.id}`, by: 'throw', drew: `${h.threwAt - prior.since}ms` });
      continue;
    }
    if (prior && prior.why === draw) continue;
    // A trident drowned can throw the moment its hand rises (its throw timer runs on through a lost sightline), so a
    // raised trident is dated at its deadline like a draw begun unseen: guarded at once, the arm held until it throws.
    const unseenStart = !seenQuiet.has(h.id) || (draw === 'notched_arrow' && combatUtils.raisesThroughStrikes(h.entity));
    const drawMs = draw === 'swell' ? SWELL_TO_BLAST_MS : drawMsOf(h);
    drawStarts.set(h.id, { why: draw, since: unseenStart ? now - drawMs : now, drawMs });
  }
  for (const id of drawStarts.keys()) if (!live.has(id)) drawStarts.delete(id);
  for (const id of seenQuiet) if (!live.has(id)) seenQuiet.delete(id);
  for (const id of releasedAt.keys()) if (!live.has(id)) releasedAt.delete(id);

  const out = [];
  for (const h of board.active || []) {
    // SWELL OUTRANKS NOTCH when a mob carries both — its deadline ends the fight, not costs 6 hp.
    const draw = drawStarts.get(h.id);
    if (draw) {
      // A draw that began at a throw keeps the thrown trident guarded through its flight.
      const thrown = releasedAt.has(h.id) && releasedAt.get(h.id) >= draw.since && now - releasedAt.get(h.id) < SHIELD_HOLD_MS + arrowFlightMs(h.distance);
      out.push({ id: h.id, why: draw.why, since: draw.since, drawMs: draw.drawMs, entity: h.entity, distance: h.distance, inFlight: thrown || undefined });
      continue;
    }
    if (releasedAt.has(h.id) && now - releasedAt.get(h.id) < SHIELD_HOLD_MS + arrowFlightMs(h.distance)) {
      out.push({ id: h.id, why: 'notched_arrow', since: now - drawMsOf(h), drawMs: drawMsOf(h), entity: h.entity, distance: h.distance, inFlight: true });
    }
  }
  return out;
}

// The hold after a notch clears: the arrow was released, not landed, so the shield stays up for its flight over
// the gap it was drawn across (archer_calculator.arrowFlightMs), plus the settle.
let holdMs = SHIELD_HOLD_MS;
// What the tick that lowers the guard saw: its threats, and the commander's active and notching lists, so a guard
// dropped with a draw still on the field says which list lost it.
let guardCensus = null;
// shieldHitAt(bot, now) → when the raised shield last took a blow, or null: its durability dropping while it is up (the
// server's own charge for a blocked blow: 1 + the blow's damage, for any blow of 3 or more; a lighter one costs nothing
// and is not read), or the server's block signal when it arrives.
let wornAt = null;          // ms the off-hand shield last lost durability while raised
let wearSeen = null;        // its durabilityUsed at the last tick, null with no shield in the off-hand
function shieldHitAt(bot, now) {
  const slot = bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
  const used = slot && slot.name === 'shield' ? slot.durabilityUsed : null;
  if (used != null && wearSeen != null && used > wearSeen && shieldUp) {
    wornAt = now;
    const src = blockSource(bot, now);
    crewLog.event(TAG, 'shield_hit', { wear: used - wearSeen, used, max: slot.maxDurability || null,
      blow: src.blow, by: src.by, by_tactic: src.tactic, by_d: src.d, engaged: src.engaged });
  }
  wearSeen = used;
  const latch = require('@api/battle_stations').lastShieldBlockAt();
  return latch != null && (wornAt == null || latch > wornAt) ? latch : wornAt;
}
// ── THE GUARD LEDGER ── one `guard_read` event for every arrow the body meets with a shield in its off-hand, blocked
// (the shield's durability rose) or landed (the server's damage_event names an arrow), with what can decide a block:
// the server's own hold of the shield and its age, the angle from the head to the shooter and to the arrow's last seen
// place, how far the head turned in the last 100 / 250 / 500 ms, the last look the gunner wrote, and the body's speed.
const LEDGER_RING_MS = 600;
let yawRing = [];          // [{ at, yaw }] for the last LEDGER_RING_MS
let lastLook = null;       // { at, deg } of the last look aimBearing wrote
let raiseSentAt = null;    // ms the last raise packet left; the server's block delay counts from it, whatever the flag shows
let lowerSentAt = null;    // ms the last lower packet left
let arrowSeen = new Map(); // arrow or trident id → { kind, x, y, z, at, launch } at its last sighting within 16 b
let lastSwell = null;      // { id, at } of the last creeper the commander read swelling, for a blast's attribution
let landedArrow = null;    // { at, arrowId, shooterId } from the damage_event, read on the next tick
function noteGuardLedgerTick(bot, now) {
  const me = bot.entity && bot.entity.position;
  if (!me) return;
  yawRing.push({ at: now, yaw: bot.entity.yaw, x: me.x, z: me.z });
  while (yawRing.length && now - yawRing[0].at > LEDGER_RING_MS) yawRing.shift();
  for (const e of Object.values(bot.entities || {})) {
    if (!e || (e.name !== 'arrow' && e.name !== 'trident') || !e.position || e.position.distanceTo(me) > 16) continue;
    const prev = arrowSeen.get(e.id);
    arrowSeen.set(e.id, { kind: e.name, x: e.position.x, y: e.position.y, z: e.position.z, at: now,
      launch: prev ? prev.launch : e.velocity ? { x: e.position.x, y: e.position.y, z: e.position.z,
        vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z } : null });
  }
  for (const [id, a] of arrowSeen) if (now - a.at > 2000) arrowSeen.delete(id);
  const swelling = crewBoard.readCommander().swelling || [];
  if (swelling.length) lastSwell = { id: swelling[0], at: now };
}

// ── WHAT A BLOCK STOPPED ── read off what was in the air and around the body on the tick the shield took it, so every
// block on the record names its blow and its attacker, and whether the body was fighting that attacker:
//   blast    a creeper read swelling within BLAST_SEEN_MS, whatever else is in the air (the wear is the blast's);
//   trident  a trident seen within BLOCK_SEEN_MS, thrown by the nearest drowned holding one;
//   arrow    an arrow seen within BLOCK_SEEN_MS, shot by the nearest other KITER;
//   melee    none of these: the nearest engaged mob.
const BLOCK_SEEN_MS = 150;
const BLAST_SEEN_MS = 500;
// blockSource(bot, now) → { blow, by, byId, tactic, d, engaged, near } — `near` is the projectile's { a, d }, or null.
function blockSource(bot, now) {
  const me = bot.entity.position;
  const board = crewBoard.readCommander();
  const active = board.active || [];
  let near = null;
  for (const a of arrowSeen.values()) {
    const d = Math.hypot(a.x - me.x, a.z - me.z);
    if (now - a.at <= BLOCK_SEEN_MS && (!near || d < near.d)) near = { a, d };
  }
  let blow, mob;
  if (lastSwell && now - lastSwell.at <= BLAST_SEEN_MS) {
    blow = 'blast';
    mob = active.find((h) => h.id === lastSwell.id) || { name: 'creeper', id: lastSwell.id, distance: null };
  } else if (near && near.a.kind === 'trident') {
    blow = 'trident';
    mob = active.find((h) => combatUtils.throwsTrident(h.entity));
  } else if (near) {
    blow = 'arrow';
    mob = active.find((h) => combatUtils.combatTactic(h.name, h.entity) === 'KITER' && !combatUtils.throwsTrident(h.entity));
  } else {
    blow = 'melee';
    mob = active[0];
  }
  mob = mob || null;
  return {
    blow, near,
    by: mob ? `${mob.name}#${mob.id}` : null, byId: mob ? mob.id : null,
    tactic: mob && mob.entity ? combatUtils.combatTactic(mob.name, mob.entity) : null,
    d: mob && Number.isFinite(mob.distance) ? Math.round(mob.distance * 10) / 10 : null,
    engaged: !!(mob && board.focus && board.focus.id === mob.id),
  };
}
function angleDeg(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return Math.round(d * 180 / Math.PI);
}
function turnedDeg(now, ms) {
  if (!yawRing.length) return null;
  const cur = yawRing[yawRing.length - 1].yaw;
  let most = 0;
  for (const r of yawRing) if (now - r.at <= ms) most = Math.max(most, angleDeg(cur, r.yaw));
  return most;
}
function offDeg(bot, pos) {
  const me = bot.entity.position;
  const dx = pos.x - me.x, dz = pos.z - me.z;
  return Math.hypot(dx, dz) < 1e-3 ? null : angleDeg(Math.atan2(-dx, -dz), bot.entity.yaw);
}
// arrowStrike(launch, bot) — flies the arrow from its launch (place and velocity in blocks per tick, as the spawn
// carries it) the way the server does, one tick at a time: step, then drag 0.99 and gravity 0.05, until the step
// crosses the body's box (0.6 wide, 1.8 tall, at its feet now). The server judges a shield by the flat bearing from
// the body's feet to that touch point: inside 90° of the head's facing is blocked. Returns the face the arrow
// touched and that bearing, or null when the flight misses the box.
const ARROW_DRAG = 0.99;
const ARROW_GRAVITY = 0.05;
function arrowStrike(launch, bot) {
  if (!launch || !bot.entity) return null;
  const f = bot.entity.position;
  const lo = [f.x - 0.3, f.y, f.z - 0.3], hi = [f.x + 0.3, f.y + 1.8, f.z + 0.3];
  let p = [launch.x, launch.y, launch.z], v = [launch.vx, launch.vy, launch.vz];
  for (let tick = 0; tick < 80; tick++) {
    let tIn = 0, tOut = 1, face = null;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(v[k]) < 1e-9) { if (p[k] < lo[k] || p[k] > hi[k]) { tIn = 2; break; } continue; }
      let t1 = (lo[k] - p[k]) / v[k], t2 = (hi[k] - p[k]) / v[k];
      const near = Math.min(t1, t2), far = Math.max(t1, t2);
      if (near > tIn) { tIn = near; face = k === 1 ? (v[1] < 0 ? 'top' : 'bottom') : 'side'; }
      tOut = Math.min(tOut, far);
    }
    if (tIn <= tOut && tIn <= 1) {
      const at = [p[0] + v[0] * tIn, p[1] + v[1] * tIn, p[2] + v[2] * tIn];
      return { face: face || 'inside', deg: offDeg(bot, { x: at[0], z: at[2] }), up: Math.round((at[1] - f.y) * 100) / 100, tick };
    }
    p = [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    v = [v[0] * ARROW_DRAG, v[1] * ARROW_DRAG - ARROW_GRAVITY, v[2] * ARROW_DRAG];
  }
  return null;
}
function guardRead(bot, outcome, arrow, shooterId, now) {
  if (!bot.entity) return;
  const g = require('@api/battle_stations').serverGuard(bot);
  const shooter = shooterId != null && bot.entities ? bot.entities[shooterId] : null;
  const first = yawRing[0], last = yawRing[yawRing.length - 1];
  const speed = first && last && last.at > first.at ? Math.hypot(last.x - first.x, last.z - first.z) / ((last.at - first.at) / 1000) : null;
  crewLog.event(TAG, 'guard_read', {
    outcome,
    server: g.state, up_ms: g.state === 'offhand' && g.since != null ? now - g.since : null,
    commanded: shieldUp, cmd_ms: shieldUp && shieldUpAt ? now - shieldUpAt : null,
    raise_ms: raiseSentAt != null ? now - raiseSentAt : null, lower_ms: lowerSentAt != null ? now - lowerSentAt : null,
    off_shooter: shooter && shooter.position ? offDeg(bot, shooter.position) : null,
    off_arrow: arrow ? offDeg(bot, arrow) : null,
    launch_v: arrow && arrow.launch ? Math.round(Math.hypot(arrow.launch.vx, arrow.launch.vy, arrow.launch.vz) * 100) / 100 : null,
    ...(() => { const s = arrow ? arrowStrike(arrow.launch, bot) : null;
      return { strike_face: s ? s.face : null, strike_deg: s ? s.deg : null, strike_up: s ? s.up : null }; })(),
    arrow_d: arrow ? Math.round(Math.hypot(arrow.x - bot.entity.position.x, arrow.z - bot.entity.position.z) * 100) / 100 : null,
    turned_100: turnedDeg(now, 100), turned_250: turnedDeg(now, 250), turned_500: turnedDeg(now, 500),
    look_ms: lastLook ? now - lastLook.at : null, look_deg: lastLook ? lastLook.deg : null,
    speed: speed != null ? Math.round(speed * 100) / 100 : null,
    dy: shooter && shooter.position ? Math.round((shooter.position.y - bot.entity.position.y) * 10) / 10 : null,
    shooter: shooter ? `${shooter.name}#${shooter.id}` : null,
  });
}
// armGuardLedger(bot) — hears the server name an arrow as the direct source of a blow on this body.
function armGuardLedger(bot) {
  if (!bot || !bot._client || bot._aurenGuardLedger) return;
  bot._aurenGuardLedger = true;
  // A shove the server sends the body (knockback from a blow, an arrow or a blast) is recorded as it lands, in blocks
  // per tick: the body takes the knockback a player takes, and the record shows how far each blow moved it.
  bot._client.on('entity_velocity', (p) => {
    if (!bot.entity || p.entityId !== bot.entity.id || !p.velocity) return;
    const flat = Math.hypot(p.velocity.x, p.velocity.z);
    if (flat < 0.05) return;
    crewLog.event(TAG, 'shoved', { flat: Math.round(flat * 1000) / 1000, up: Math.round(p.velocity.y * 1000) / 1000,
      held: Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 1000) / 1000 });
  });
  bot._client.on('damage_event', (p) => {
    if (!bot.entity || p.entityId !== bot.entity.id) return;
    const directId = p.sourceDirectId ? p.sourceDirectId - 1 : null;
    const direct = directId != null && bot.entities ? bot.entities[directId] : null;
    if ((direct && (direct.name === 'arrow' || direct.name === 'trident')) || arrowSeen.has(directId)) {
      landedArrow = { at: Date.now(), arrowId: directId, shooterId: p.sourceCauseId ? p.sourceCauseId - 1 : null };
    }
  });
}
function readGuardLedger(bot, now, blockedAt) {
  if (!combatUtils.holdsShield(bot)) { landedArrow = null; return; }
  if (landedArrow) {
    const seen = arrowSeen.get(landedArrow.arrowId) || null;
    guardRead(bot, seen && seen.kind === 'trident' ? 'landed_trident' : 'landed', seen, landedArrow.shooterId, now);
    landedArrow = null;
  }
  if (blockedAt === now) {
    // What the block stopped and who sent it (WHAT A BLOCK STOPPED): 'blocked' for an arrow, else blocked_<blow>.
    const src = blockSource(bot, now);
    guardRead(bot, src.blow === 'arrow' ? 'blocked' : `blocked_${src.blow}`, src.near ? src.near.a : null, src.byId, now);
  }
}

let wasShielded = false;

// applyShield(bot, order, now, gap) — the only place the shield is raised or lowered. Lower is latched, raise
// is not: threat clearing means the arrow was RELEASED not landed. activateItem(true) = offhand.
// `gap` is the threat's distance this tick, or null. `holdDown`: a knockback swing is pending, so a lowered
// shield is not raised again until it is thrown.
function applyShield(bot, order, now, gap, holdDown) {
  if (order.guard && holdDown && !shieldUp) return;
  if (order.guard) {
    shieldClearAt = null;
    holdMs = order.why === 'notched_arrow' && Number.isFinite(gap) ? SHIELD_HOLD_MS + arrowFlightMs(gap) : SHIELD_HOLD_MS;
    threatId = order.against;
    threatWhy = order.why;
    if (!shieldUp) {
      // A refused raise leaves the latch DOWN, so the next tick tries again (Law 25).
      if (!guardExternalSync(TAG, 'activateItem to raise the shield', () => bot.activateItem(true)).ok) return;
      raiseSentAt = Date.now();
      shieldUp = true;
      if (lowerUnswung) { stats.lowersUnswung++; lowerUnswung = false; }
      // The guard resuming after a swing keeps the raise's original time and says nothing (lowerForSwing).
      if (resumingGuard) { resumingGuard = false; stats.guardTicks++; return; }
      shieldUpAt = now;
      // `waited` is how long the raise lagged behind the threat's start.
      crewLog.event(TAG, 'shield', {
        subject: order.against !== null ? `${order.againstName}#${order.against}` : null,
        state: 'up', why: order.why, waited: `${now - order.since}ms`,
      });
    }
    stats.guardTicks++;
    return;
  }
  if (!shieldUp) {
    // A guard that ended while lowered for a swing closes here, so every logged raise has its lower.
    if (resumingGuard) crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'swing' });
    threatId = null; threatWhy = null; resumingGuard = false;
    return;
  }
  if (shieldClearAt === null) { shieldClearAt = now; threatWhy = 'settling'; }
  if (now - shieldClearAt < holdMs) { stats.guardTicks++; stats.settleTicks++; return; }
  guardExternalSync(TAG, 'deactivateItem to lower the shield', () => bot.deactivateItem()); lowerSentAt = Date.now();
  loweredAt = now; lowerUnswung = false;
  // `held` is the cost side: ms the arm could not swing while the guard was up.
  crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, ...(guardCensus || {}) });
  shieldUp = false;
  shieldUpAt = null;
  shieldClearAt = null;
  threatId = null;
  threatWhy = null;
}

// aim(bot, target) → true when a facing was written this tick.
// Bearing is continuous, facing is one of eight (`quantizeYawSticky`). The write is CONDITIONAL so the facing holds
// until the bearing leaves its hysteresis. `bot.look` sends nothing itself: mineflayer's physics tick sends at most one
// movement packet a tick, and a rotation only when it changed, so a repeated yaw costs the server nothing.
function aim(bot, target) {
  const me = bot.entity.position;
  const dx = target.position.x - me.x;
  const dz = target.position.z - me.z;
  if (Math.hypot(dx, dz) < 1e-3) return false;   // standing in the same column: no bearing to take
  const bearing = Math.atan2(-dx, -dz);          // the fleet's one facing convention (motion_primitives)
  const want = quantizeYawSticky(bearing, heldYaw, YAW_HYSTERESIS_RAD);
  if (heldYaw !== null && want === heldYaw) return false;
  // PITCH HELD LEVEL, decided not omitted: nothing reads it (server resolves the hit by entity id).
  // heldYaw is only advanced on a facing that was actually written (Law 25).
  if (!guardExternalSync(TAG, `look to yaw ${want.toFixed(3)}`, () => bot.look(want, 0, true)).ok) return false;
  lastLook = { at: Date.now(), deg: heldYaw !== null ? angleDeg(want, heldYaw) : null };
  heldYaw = want;
  return true;
}

// fire(bot, target, distance) → true when a packet left. Adds the reach test before `swingNow`'s own
// check and the charge gate. The swing packet is still sent in one place in this fleet (Law 16).
// cooldownInHand(bot) → the swing cooldown of the item IN HAND, not the best in pack. Name-keyed cache: an unchanged
// hand costs one string compare.
function cooldownInHand(bot) {
  const heldName = bot.heldItem && bot.heldItem.name;
  if (heldName !== cachedWeaponName) {
    cachedWeaponName = heldName;
    const choice = combatUtils.pickBestWeapon(bot);
    cachedCooldownMs = (choice && choice.profile && choice.profile.cooldownMs) || 625;
  }
  return cachedCooldownMs;
}

// swingReady(bot, distance) → true when fire() would send a swing this tick: the focus in reach and the arm charged.
// readyIn(bot) → ms until the weapon in hand is fully charged, 0 when it is (published for the driver's kite).
function readyIn(bot) {
  const since = combatUtils.msSinceLastSwing();
  return since === Infinity ? 0 : Math.max(0, Math.round(cooldownInHand(bot) - since));
}

// ── THE SWING TARGET ──────────────────────────────────────────────────────────────────────────────────────────
// swingTarget(bot, board) → { mob, inReach, gap } or null: the closest active mob within BOT_STRIKE_REACH of the
// eyes (combatUtils.swingDistance, `gap`), read on the swing tick itself, whatever the chase target is. A swelling
// creeper is passed over: its answer is the blast wall and the shield, and a swing would lower the swell guard (a
// homestead blast landed 120 ms after one).
//
// ── A CREEPER IS JUDGED WHERE IT WILL BE (prediction_engine) ──
// Its fuse lights 3.0 b out, centre to centre, and the reach first touches it about 3.4 b out; the server reports a walking
// creeper only every few ticks, so the stale position lets it cross that whole window unseen. Its reach is judged at the
// predicted positions of both bodies on the tick the server handles the swing (`predicted`), so the first blow lands
// before the fuse and knocks it back out. The reach is BOT_STRIKE_REACH either way.
// A CREEPER IN REACH IS STRUCK FIRST, whatever stands nearer: a zombie's blow costs a few hearts, a creeper that reaches
// its fuse distance costs the fight. The pick is made here, on the swing tick, so it follows the creeper in and out of
// reach as it walks and is thrown back.
// THE SAVED SWING: a creeper walking in that will reach the swing's reach within one recharge keeps the charged arm for
// itself. A swing at the zombie beside it would leave the arm recharging while the creeper crosses the window and lights
// (pass 4, full mix: the one fuse lit came 0.4 s after a swing at a zombie). A creeper thrown back by the last blow
// is waited for as well: it turns and walks straight back in (pass 5: a swing at a skeleton while the creeper was
// still flying back). Only from CREEPER_SAVE_B past the reach, and never one standing still, so one hovering out there
// never stops the arm.
const CREEPER_SAVE_B = 1.5;
const CREEPER_SAVE_STILL_MS = 600;
let savingFor = null;   // the creeper id the arm is being kept for, for the one event per wait
let saidWitchOnly = null;   // the mobs in reach the arm last passed over for the witch (THE WITCH ALONE), for one row per change
// savedForCreeper(bot, candidates) → the creeper candidate the arm is kept for, or null.
function savedForCreeper(bot, candidates) {
  const recharge = cooldownInHand(bot);
  return candidates.find(({ h, gap, predicted }) => {
    if (!predicted || gap == null || gap <= BOT_STRIKE_REACH || gap > BOT_STRIKE_REACH + CREEPER_SAVE_B) return false;
    const c = predictionEngine.closing(bot, h.entity);
    if (c != null && c <= 0) return predictionEngine.stillMs(h.entity) < CREEPER_SAVE_STILL_MS;   // thrown back, returning
    return c != null && ((gap - BOT_STRIKE_REACH) / c) * 1000 < recharge;
  }) || null;
}
const PREDICTED_REACH = new Set(['creeper']);
const SWIPE_CLEAR_B = 1.5;
const CRIT_FALL_VY = -0.2;
function swingTarget(bot, board, near = null) {
  const swelling = board.swelling || [];
  const candidates = (board.active || [])
    .filter((h) => !swelling.includes(h.id))
    .map((h) => {
      const predicted = PREDICTED_REACH.has(h.name);
      const gap = !h.entity ? null : predicted ? predictionEngine.swingGap(bot, h.entity) : combatUtils.swingDistance(bot, h.entity);
      return { h, gap, predicted };
    });
  const inReach = candidates.filter(({ gap }) => gap != null && gap <= BOT_STRIKE_REACH);
  // A HEALER IS FINISHED (combat_utils.healsItself): the chase target that heals itself is struck whenever it stands in
  // reach, before a quiet creeper's knockback and before a swing saved for one. A swing spent on the creeper is one she
  // drinks back (arena: four creeper swings and two saves with the witch at 1.8-2.9 b, two blows on her in five seconds).
  // A creeper that swells is answered by the shield (A LIT FUSE OUTRANKS HER, in the tick), not by this arm.
  const healer = near && combatUtils.healsItself(near.name) ? inReach.find((x) => x.h.id === near.id) : null;
  if (healer) { savingFor = null; return { mob: healer.h, inReach: inReach.length, gap: healer.gap, predicted: healer.predicted }; }
  // THE WITCH ALONE (combat_utils.witchOnly): a terminator chasing a witch strikes nothing else, so no swing and no
  // knockback press toward another mob turns it from her, SAVE A CREEPER IN REACH, struck first as always (below): passed
  // over, it lit beside the body twice in the arena, and the guard held through its fuse costs more than one swing.
  if (combatUtils.witchOnly(near) && !inReach.some((x) => x.predicted)) {
    savingFor = null;
    // THE SWIPE: with her still SWIPE_CLEAR_B past the arm, a melee mob in reach is struck once with the knockback swing
    // and thrown out of the way; the arm is charged again by the time the body reaches her.
    const witchGap = (candidates.find((x) => x.h.id === near.id) || {}).gap;
    const inWay = witchGap == null || witchGap > BOT_STRIKE_REACH + SWIPE_CLEAR_B
      ? inReach.find((x) => combatUtils.combatTactic(x.h.name, x.h.entity) === 'BRAWLER') : null;
    if (inWay) { saidWitchOnly = null; return { mob: inWay.h, inReach: inReach.length, gap: inWay.gap, predicted: false }; }
    // One row on each change of what the arm passes over, so the record says which mobs in reach went unstruck and why.
    const passed = inReach.map((x) => `${x.h.name}#${x.h.id}`).join(',') || null;
    if (passed !== saidWitchOnly) {
      saidWitchOnly = passed;
      if (passed) crewLog.event(TAG, 'witch_only', { subject: `${near.name}#${near.id}`, passed });
    }
    return null;
  }
  saidWitchOnly = null;
  const creeper = inReach.find((x) => x.predicted);
  const saved = !creeper && inReach.length ? savedForCreeper(bot, candidates) : null;
  if (saved) {
    stats.savedTicks++;
    if (savingFor !== saved.h.id) {
      savingFor = saved.h.id;
      crewLog.event(TAG, 'save', { subject: crewLog.subject(saved.h.entity), gap: Math.round(saved.gap * 100) / 100,
        passed: crewLog.subject(inReach[0].h.entity) });
    }
    return null;
  }
  savingFor = null;
  const pick = creeper || inReach[0];
  return pick ? { mob: pick.h, inReach: inReach.length, gap: pick.gap, predicted: pick.predicted } : null;
}

// ── PICK, CHARGE, SWING ───────────────────────────────────────────────────────────────────────────────────────
// Every swing is one cycle: the weapon is picked, the arm charges on it, the swing is thrown. armed(bot) is the pick
// read on the tick: the hand holds the best weapon in the pocket (combatUtils.pickBestWeapon), or there is none and the
// fist is the weapon. A hand that does not hold the pick is equipped (verifyWeapon, 'pre-charge'), and the equip restarts
// the charge (combatUtils.noteEquip, the server's own rule), so no swing leaves on a hand the pick did not choose: not
// an empty hand after a dig, nor a weapon that broke on the last swing.
function armed(bot) {
  const pick = combatUtils.pickBestWeapon(bot);
  return !pick.item || require('@utils/hand').holds(bot, pick.item);
}

function swingReady(bot, distance) {
  return distance <= BOT_STRIKE_REACH && armed(bot) && combatUtils.chargeNow(cooldownInHand(bot)) >= 1;
}

// strikeAt(bot, strike, near) → true when the swing left: squared to the swing target and thrown. A swing at a mob other
// than the chase target (`near`) is stated with the chase it passed over, so the ledger shows the arm deciding.
function strikeAt(bot, strike, near) {
  const mob = strike.mob;
  aimBearing(bot, bearingTo(bot.entity.position, mob.entity.position));
  if (!fire(bot, mob.entity, strike.gap, strike.predicted)) return false;
  lastStruckId = mob.entity.id;
  if (!near || mob.id !== near.id) {
    stats.swingsOffChase++;
    crewLog.event(TAG, 'pick', { subject: crewLog.subject(mob.entity), chase: near ? crewLog.subject(near.entity) : null,
      d: Math.round(mob.distance * 100) / 100, in_reach: strike.inReach });
  }
  return true;
}

// lowerForSwing(bot) — drops the guard for one swing. Counted, not logged: it happens on every swing of a
// shielded fight, and the raise that follows is the same guard resuming, so neither is a shield event of its own.
// Every lowering is stamped (`loweredAt`, published) and a lowering the raise follows with no swing thrown between is
// counted: the server restarts the 5-tick block delay on each raise, and a lower and raise inside one server tick never
// change the flag the client reads.
function lowerForSwing(bot) {
  guardExternalSync(TAG, 'deactivateItem to swing behind the shield', () => bot.deactivateItem()); lowerSentAt = Date.now();
  loweredAt = Date.now(); lowerUnswung = true;
  stats.swingLowers++;
  shieldUp = false;
  resumingGuard = true;
}

// ── THE VOLLEY REST ── against a group of shooters (two or more mobs whose shots a shield stops) the guard is never up
// longer than VOLLEY_UP_MAX_MS, swings between included, and once lowered it stays down VOLLEY_REST_MS before it may
// rise again. Behind a shield held through every draw the arm never swings (NO SWING INTO AN ARROW): the archers take
// turns and the body stands still under them. Down, the arm swings freely; a shield never covered the head, so some
// arrows land either way. A swell is never rested: its guard outranks the volley.
const VOLLEY_UP_MAX_MS = 2000;
const VOLLEY_REST_MS = 1000;
const VOLLEY_SHOOTERS = 3;
const CRAWL_UP_MS = 2000;
const CHARGE_REST_MS = 600;
const CHARGE_AFTER_BLOCK_MS = 150;
function volley(board) {
  // THREE, NOT TWO: every draw is timed on its own now (shieldOrder), so against two archers the guard is down between
  // their arrows by itself and the arm swings there; the rest only let arrows in (arena: about 50 of 200 hp of arrows a
  // round landed in a rest, five in a row on one body). Three or more keep some draw always due, and the rest stands.
  return (board.active || []).filter((h) => h.entity && combatUtils.shieldStops(h.entity)).length >= VOLLEY_SHOOTERS;
}
// restShield(bot, now) — lowers the guard at once for the volley rest, with no settle, and starts the rest.
function restShield(bot, now) {
  guardExternalSync(TAG, 'deactivateItem for the volley rest', () => bot.deactivateItem()); lowerSentAt = Date.now();
  crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'volley_rest' });
  loweredAt = now; lowerUnswung = false;
  shieldUp = false; shieldUpAt = null; shieldClearAt = null; threatId = null; threatWhy = null; resumingGuard = false;
  restUntil = now + VOLLEY_REST_MS;
  stats.volleyRests++;
}

// aimBearing(bot, bearing) → true when a facing was written: the exact bearing, for the guard and the swing tick,
// where an eighth-of-a-turn quantum would leave a blow landing beside the shield. Written only past AIM_DEADBAND_RAD.
const AIM_DEADBAND_RAD = (4 * Math.PI) / 180;
function aimBearing(bot, bearing) {
  if (heldYaw !== null) {
    let off = bearing - heldYaw;
    while (off > Math.PI) off -= 2 * Math.PI;
    while (off < -Math.PI) off += 2 * Math.PI;
    if (Math.abs(off) < AIM_DEADBAND_RAD) return false;
  }
  if (!guardExternalSync(TAG, `look to yaw ${bearing.toFixed(3)}`, () => bot.look(bearing, 0, true)).ok) return false;
  lastLook = { at: Date.now(), deg: heldYaw !== null ? angleDeg(bearing, heldYaw) : null };
  heldYaw = bearing;
  return true;
}

// `predicted`: `distance` was judged at predicted positions, and swingNow's reach gate reads it in place of the seen one.
function fire(bot, target, distance, predicted = false) {
  if (distance > BOT_STRIKE_REACH) return false;
  if (!armed(bot)) { verifyWeapon(bot, 'pre-charge'); return false; }
  stats.inReach++;
  const heldName = bot.heldItem && bot.heldItem.name;
  if (combatUtils.chargeNow(cooldownInHand(bot)) < 1) return false;
  stats.charged++;
  const fired = combatUtils.swingNow(bot, target, TAG, predicted ? distance : undefined);
  if (fired) {
    stats.swings++;
    stats.lastSwingAt = Date.now();
    lowerUnswung = false;
    if (!bot.heldItem) stats.barehandedSwings++;
  }

  // ── THE FIRST LANDED BLOW ON A MOB, STATED ONCE ─────────────────────────────────────────────────
  // `retireTarget` must tell "the bot killed it" from "it died near the bot" (Law 25); recorded once per
  // mob, bounded by mobs fought, not swings thrown.
  if (fired) {
    const before = _connected.get(target.id) || 0;
    _connected.set(target.id, before + 1);
    if (!before) crewLog.event(TAG, 'connect', { subject: `${target.name || 'unknown'}#${target.id}`,
                                                 weapon: heldName || 'fist',
                                                 d: Math.round(distance * 100) / 100 });
  }
  return fired;
}

// ---------------------------------------------------------------------------
// SECTION 4b: The hand
// ---------------------------------------------------------------------------

// verifyWeapon(bot, why) — is the best weapon in the hand; if not, start getting it. The one weapon selection in a
// fight, made before every charge (PICK, CHARGE, SWING; Invariant B). Delegates to `equipBestWeapon`, which owns best-vs-held (Law 16). Unawaited;
// `equipPending` stops a later tick firing a second swap into this one's round trip.
function verifyWeapon(bot, why) {
  if (equipPending) return;
  stats.equipChecks++;
  const before = bot.heldItem && bot.heldItem.name;
  equipPending = true;
  Promise.resolve(combatUtils.equipBestWeapon(bot))
    .then((choice) => {
      if (!choice || !choice.item) {
        // Empty pack = the world's answer, not a fault to retry: fight on with fists (Law 13).
        stats.equipFails++;
        return;
      }
      if (choice.item.name !== before) {
        // Held name changed under the name-keyed cooldown cache; clear now so the next swing times on
        // the new weapon's clock.
        cachedWeaponName = null;
        crewLog.event(TAG, 'rearm', { from: before || 'empty_hand', to: choice.item.name, why });
      }
    })
    .catch((e) => {
      // Boundary translator (Law 16's one legal catch): a lost equip swap is environmental, named aloud.
      watcher.warn(TAG, `weapon check failed (${e && e.message}) — swinging with whatever is in the hand.`);
    })
    .then(() => { equipPending = false; });
}

// ---------------------------------------------------------------------------
// SECTION 3: Tick
// ---------------------------------------------------------------------------

// ── THE BLAST WALL: ONE BLOCK AT THE CREEPER'S FEET ─────────────────────────────────────────────────────────
// A creeper's blast starts at its feet, and the server prices each body's share of it by the rays from that point to
// the body's box that reach it, before the blast breaks a single block. One block set on the ground in the cell beside
// the creeper, on its line to the body, stands across every one of those rays: the blast costs the body nothing, and
// the shield nothing. A swelling creeper stops walking, so it does not step round the block.
// It is the first answer to a swell within blast reach whenever the body carries a block, has a cell the server will
// take (no entity in it) and is not flanked (flankedBy): a flanked body keeps the shield up. A shielded body lowers the
// shield only for the place and raises it behind the set block: a slope or a misplaced cell leaves rays the block
// does not cover. Without a block or a cell the shield guard stands alone.
const WALL_STEPS = [0.95, 1.25, 1.55];   // b from the creeper's centre along its line to the body
const WALL_LEVEL_DY = 0.6;               // a creeper further off the body's floor than this is guarded, not walled
const WALL_REACH = 4.5;                  // the place reach from the body's eye
// A creeper still sliding from a blow, or the body still carried by its last step, is where its velocity carries it
// this many ticks on: a cell either slides into refuses the block (two homestead walls refused so).
const WALL_SLIDE_TICKS = 6;
// A refused wall is set again, in another cell, from where the body stands now, this many times per creeper.
const WALL_TRIES = 3;
const CREEPER_HALF = 0.3, CREEPER_TALL = 1.7;
// A FLANKED BODY KEEPS ITS SHIELD. The wall costs the shield for the place, about a second; with another attacker on the
// body that second is an open side: an archer drawing (notching, or a KITER) within WALL_FLANK_SHOT_B, or any other
// attacker within WALL_FLANK_NEAR_B. Then the shield takes the blast instead (it stops an explosion it faces).
const WALL_FLANK_SHOT_B = 16;
const WALL_FLANK_NEAR_B = 4;
// flankedBy(board, creeperId) → the first other attacker that makes a lowered shield an open side, or null.
function flankedBy(board, creeperId) {
  return (board.active || []).find((h) => h.id !== creeperId && Number.isFinite(h.distance)
    && (h.distance <= WALL_FLANK_NEAR_B || ((h.notching || h.tactic === 'KITER') && h.distance <= WALL_FLANK_SHOT_B))) || null;
}
// THE SERVER REFUSES A BLOCK IN A CELL ANY ENTITY'S BOX OVERLAPS (a mob, a player; not a dropped item, an orb or an
// arrow). entityInCell(bot, cell) → the first such entity, its box where it stands and where it slides
// (WALL_SLIDE_TICKS), or null: the wall is never tried where the server would refuse it.
const WALL_NO_BLOCKERS = new Set(['object', 'orb', 'projectile', 'global']);
function entityInCell(bot, cell) {
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || WALL_NO_BLOCKERS.has(e.type)) continue;
    const half = (e.width || 0.6) / 2, tall = e.height || 1.8, v = e.velocity;
    if (boxHitsCell(e.position, half, tall, cell)) return e;
    if (v && boxHitsCell(e.position.offset(v.x * WALL_SLIDE_TICKS, 0, v.z * WALL_SLIDE_TICKS), half, tall, cell)) return e;
  }
  return null;
}
let wall = null;   // { creeperId, at: {x,y,z}, settled, ok, why, since, tries, refused } — one per swelling creeper

function boxHitsCell(p, half, tall, cell) {
  return p.x + half > cell.x && p.x - half < cell.x + 1 && p.z + half > cell.z && p.z - half < cell.z + 1
    && p.y + tall > cell.y && p.y < cell.y + 1;
}

// wallCell(bot, creeper) → { cell, standing } for the block between the creeper and the body, or null. `standing` is
// a solid block already in that cell: the wall is up without a place.
// wallWhy — why the last wallCell found no cell, for the record: not_level, too_close, or no_cell with the count of each
// way the three steps were refused.
let wallWhy = null;
function wallCell(bot, creeper, refused) {
  const c = creeper.entity && creeper.entity.position, me = bot.entity && bot.entity.position;
  if (!c || !me) { wallWhy = 'no_position'; return null; }
  if (Math.abs(me.y - c.y) > WALL_LEVEL_DY) { wallWhy = `not_level dy=${Math.round((c.y - me.y) * 10) / 10}`; return null; }
  const dx = me.x - c.x, dz = me.z - c.z, len = Math.hypot(dx, dz);
  if (len < 1.2) { wallWhy = `too_close d=${Math.round(len * 10) / 10}`; return null; }
  const no = { refused: 0, overlap: 0, entity: 0, unloaded: 0, not_replaceable: 0, out_of_reach: 0, no_anchor: 0 };
  const eye = me.offset(0, 1.62, 0);
  const botHalf = (bot.entity.width || 0.6) / 2, botTall = bot.entity.height || 1.8;
  const v = creeper.entity.velocity, mv = bot.entity.velocity;
  const slid = v ? c.offset(v.x * WALL_SLIDE_TICKS, 0, v.z * WALL_SLIDE_TICKS) : c;
  const meSlid = mv ? me.offset(mv.x * WALL_SLIDE_TICKS, 0, mv.z * WALL_SLIDE_TICKS) : me;
  for (const step of WALL_STEPS) {
    const cell = new Vec3(Math.floor(c.x + dx / len * step), Math.floor(c.y + 0.01), Math.floor(c.z + dz / len * step));
    if (refused && refused.has(`${cell.x},${cell.y},${cell.z}`)) { no.refused++; continue; }
    if (boxHitsCell(c, CREEPER_HALF, CREEPER_TALL, cell) || boxHitsCell(slid, CREEPER_HALF, CREEPER_TALL, cell)
      || boxHitsCell(me, botHalf, botTall, cell) || boxHitsCell(meSlid, botHalf, botTall, cell)) { no.overlap++; continue; }
    const block = bot.blockAt(cell);
    if (!block) { no.unloaded++; continue; }
    if (block.boundingBox === 'block') return { cell, standing: true };
    if (entityInCell(bot, cell)) { no.entity++; continue; }
    // Only a cell a placed block takes over (air, grass, snow): a flower or a torch refuses the block.
    if (!isReplaceable(block)) { no.not_replaceable++; continue; }
    if (eye.distanceTo(cell.offset(0.5, 0.5, 0.5)) > WALL_REACH) { no.out_of_reach++; continue; }
    if (!coverAnchor(bot, cell)) { no.no_anchor++; continue; }
    return { cell, standing: false };
  }
  wallWhy = `no_cell ${Object.entries(no).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(',')}`;
  return null;
}
// One `wall state=none` row per swelling creeper and reason: a creeper in blast reach the wall did not answer, and why.
let wallNoneSaid = null;   // "<creeper id>|<why>" last written
function noteNoWall(creeper, why) {
  const key = `${creeper.id}|${why}`;
  if (wallNoneSaid === key) return;
  wallNoneSaid = key;
  crewLog.event(TAG, 'wall', { subject: `creeper#${creeper.id}`, state: 'none', why, d: Number.isFinite(creeper.distance) ? creeper.distance.toFixed(2) : null });
}

// lineCrossesCell(a, b, cell) → the flat segment a→b passes through the cell's column (slab test).
function lineCrossesCell(a, b, cell) {
  let t0 = 0, t1 = 1;
  for (const [p, d, lo] of [[a.x, b.x - a.x, cell.x], [a.z, b.z - a.z, cell.z]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > lo + 1) return false; continue; }
    let ta = (lo - p) / d, tb = (lo + 1 - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// wallBetween(bot, creeper, at) → the creeper's line to the body still crosses the cell `at`, the body on its level.
function wallBetween(bot, creeper, at) {
  const c = creeper && creeper.entity && creeper.entity.position, me = bot.entity && bot.entity.position;
  if (!c || !me || Math.abs(me.y - c.y) > WALL_LEVEL_DY) return false;
  return lineCrossesCell(c, me, at);
}

// wallHolds(bot, board, creeperId) → a wall set for this creeper still stands, solid, between it and the body.
function wallHolds(bot, board, creeperId) {
  if (!wall || wall.creeperId !== creeperId || !wall.ok) return false;
  const b = bot.blockAt(new Vec3(wall.at.x, wall.at.y, wall.at.z));
  const creeper = (board.active || []).find((h) => h.id === creeperId);
  return !!b && b.boundingBox === 'block' && wallBetween(bot, creeper, wall.at);
}

// wallState() → the wall as the driver reads it: the body stands still behind it while it is placing or holds.
function wallState(bot, board) {
  if (!wall) return null;
  const state = !wall.settled ? 'placing' : wallHolds(bot, board, wall.creeperId) ? 'set' : wall.ok ? 'moved' : 'failed';
  return { creeperId: wall.creeperId, state };
}

// serveWall(bot, board, now) → true while a wall's place is in flight: the hand and the head are the place's, so this
// tick neither guards, aims nor swings.
function serveWall(bot, board, now) {
  // A SHIELD IN HAND IS THE WHOLE ANSWER TO A SWELL: the guard goes up on the swell's first tick.
  // The wall's place holds the tick and the hand while it is in flight, and a fuse that ended inside it took the whole
  // health bar with the guard still down (arena: two bodies, 20 hp each). The wall is for a body with no shield.
  if (combatUtils.holdsShield(bot)) { wall = null; return false; }
  const reach = require('@api/commander').CREEPER_BLAST_REACH;
  const swelling = board.swelling || [];
  const creeper = (board.active || []).find((h) => swelling.includes(h.id) && h.distance <= reach) || null;
  if (wall && wall.settled && !swelling.includes(wall.creeperId)) wall = null;
  if (wall && !wall.settled) return true;
  // A wall the body no longer stands behind is set again, from where the body stands now.
  if (wall && wall.ok && creeper && wall.creeperId === creeper.id && !wallHolds(bot, board, creeper.id)) wall = null;
  // A refused wall is set again in another cell while tries remain.
  const again = wall && creeper && wall.creeperId === creeper.id && wall.settled && !wall.ok && wall.tries < WALL_TRIES;
  if (!creeper || (wall && wall.creeperId === creeper.id && !again)) return false;
  const refused = again ? wall.refused : new Set();
  const tries = again ? wall.tries : 0;
  const spot = wallCell(bot, creeper, refused);
  if (!spot) { noteNoWall(creeper, wallWhy); return false; }
  // A wall that needs a place is not set while the body is flanked: the shield stays up and takes the blast.
  const flank = !spot.standing && flankedBy(board, creeper.id);
  if (flank) { noteNoWall(creeper, `flanked by=${flank.name || 'mob'}#${flank.id} d=${flank.distance.toFixed(1)}`); stats.wallsFlanked++; return false; }
  const at = { x: spot.cell.x, y: spot.cell.y, z: spot.cell.z };
  if (spot.standing) {
    wall = { creeperId: creeper.id, at, settled: true, ok: true, why: 'standing', since: now, tries, refused };
    crewLog.event(TAG, 'wall', { subject: `creeper#${creeper.id}`, state: 'standing', at: `${at.x},${at.y},${at.z}` });
    stats.wallsStanding++;
    return false;
  }
  const items = bot.inventory.items();
  const item = BRIDGE_PREFS.map((name) => items.find((i) => i.name === name && i.count > 0)).find(Boolean) || null;
  if (!item) { noteNoWall(creeper, 'no_block'); return false; }
  const anchor = coverAnchor(bot, spot.cell);
  refused.add(`${at.x},${at.y},${at.z}`);
  const job = { creeperId: creeper.id, at, settled: false, ok: false, why: null, since: now, tries: tries + 1, refused };
  wall = job;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem to set the blast wall', () => bot.deactivateItem()); lowerSentAt = Date.now();
    crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'wall' });
    loweredAt = now; lowerUnswung = false;
    shieldUp = false; shieldUpAt = null; shieldClearAt = null; threatId = null; threatWhy = null; resumingGuard = false;
  }
  kbSince = null;
  stats.wallsTried++;
  crewLog.event(TAG, 'wall', { subject: `creeper#${creeper.id}`, state: 'placing', at: `${at.x},${at.y},${at.z}`, with: item.name, d: creeper.distance.toFixed(2), try: tries + 1 });
  performPlace(bot, spot.cell, anchor.block, anchor.face, item.name, TAG).then(
    (r) => { job.settled = true; job.ok = !!(r && r.ok); job.why = r && r.ok ? 'walled' : (r && r.reason) || 'place_failed'; },
    (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; })
    .then(() => {
      if (job.ok) stats.wallsSet++; else stats.wallsFailed++;
      crewLog.event(TAG, 'wall', { subject: `creeper#${job.creeperId}`, state: job.ok ? 'set' : 'failed', why: job.why, took: `${Date.now() - job.since}ms` });
      heldYaw = null;
    });
  return true;
}

// ── THE MILK ──────────────────────────────────────────────────────────────────────────────────────────────
// A witch's poison runs on after she dies: workers that killed her first were drained from 5-9 hp to 1 by it and finished
// by the mobs that came with her. A body poisoned when a witch dies drinks a carried milk bucket at once (eat_executor
// drinkMilk), which clears every effect. The drink holds the hand and the guard for its 1.6 s; the arm takes its weapon
// back on its next pick (PICK, CHARGE, SWING). MILK_WINDOW_MS after her death a potion she threw can still land, so the
// window waits for the poison as long.
const MILK_WINDOW_MS = 3000;
const MILK_CREEPER_B = 8;
const WEAK_MILK_MIN_HP = 8;   // three weakened crits (3 hp each)
let witchDiedAt = null;   // when a witch died in this fight, until the drink answers it
let drinking = false;     // the bucket is at the body's mouth
let saidNoMilk = false;   // weakened with no bucket: said once
// Only the witch this body fought: the neighbouring fight's witch dying in view spent the bucket with this one's still alive.
let foughtWitch = null;   // the id of the last witch this body's focus was on
function noteDeath(entity) {
  if (engaged && entity && combatUtils.healsItself(entity.name) && entity.id === foughtWitch) witchDiedAt = Date.now();
}
// THE CRIT, CONFIRMED: the server's own critical-hit animation on the mob last struck, one row each.
let lastStruckId = null;
function noteCrit(entity) {
  if (!engaged || !entity || entity.id !== lastStruckId) return;
  stats.critsLanded++;
  crewLog.event(TAG, 'crit_landed', { subject: `${entity.name || 'unknown'}#${entity.id}` });
}
function serveMilk(bot, now) {
  if (drinking) return true;
  // No drink is begun with a creeper within MILK_CREEPER_B, lit or not: the bucket holds the hand for 1.6 s and the guard
  // with it, a fuse is 1.5 s, and one lit a moment after the drink began took all 20 hp unguarded (arena). The poison's
  // window is held open while the creeper holds the drink.
  const cmd = crewBoard.readCommander();
  if ((cmd.swelling || []).length || (cmd.active || []).some((h) => h.name === 'creeper' && h.distance <= MILK_CREEPER_B)) {
    if (witchDiedAt !== null) witchDiedAt = now;
    return false;
  }
  // WEAKNESS IS DRUNK OFF AT ONCE, with her still alive: her weakness potion takes 4 from every blow, an iron sword's 6
  // to 2, and she then outlasts the body (arena: 8 blows landed, 7 of them crits, and she lived to kill it).
  const focus = crewBoard.readCommander().focus;
  // Not with her nearly dead: the one bucket drunk for weakness 2 s before she died left her poison to run its 45 s
  // (17 hp, the body at 0.4 among five mobs). At WEAK_MILK_MIN_HP or less the weakened arm finishes her and the bucket waits.
  const witchHp = focus && focus.entity ? (Number.isFinite(focus.entity.health) ? focus.entity.health
    : focus.entity.metadata && Number.isFinite(focus.entity.metadata[9]) ? focus.entity.metadata[9] : null) : null;
  const weakened = !!focus && combatUtils.healsItself(focus.name) && combatUtils.activeEffects(bot).some((e) => e.name === 'weakness')
    && !(witchHp !== null && witchHp <= WEAK_MILK_MIN_HP);
  if (!weakened) {
    saidNoMilk = false;
    if (witchDiedAt === null) return false;
    if (now - witchDiedAt > MILK_WINDOW_MS) { witchDiedAt = null; return false; }
    if (!combatUtils.activeEffects(bot).some((e) => e.name === 'poison')) return false;
  }
  if (!bot.inventory.items().some((i) => i.name === 'milk_bucket')) {
    if (!weakened || !saidNoMilk) crewLog.event(TAG, 'milk', { state: 'none', why: weakened ? 'weakness' : 'poison' });
    if (weakened) saidNoMilk = true; else witchDiedAt = null;
    return false;
  }
  if (!weakened) witchDiedAt = null;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem to drink milk', () => bot.deactivateItem()); lowerSentAt = now;
    crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'milk' });
    shieldUp = false; shieldUpAt = null; shieldClearAt = null; resumingGuard = false;
  }
  drinking = true;
  kbSince = null;
  crewLog.event(TAG, 'milk', { state: 'drinking', why: weakened ? 'weakness' : 'poison', hp: Math.round(bot.health * 10) / 10 });
  require('@action/eat_executor').drinkMilk(bot)
    .then((r) => crewLog.event(TAG, 'milk', { state: r.drank ? 'drunk' : 'refused', reason: r.reason,
      poisoned: combatUtils.activeEffects(bot).some((e) => e.name === 'poison'), hp: Math.round(bot.health * 10) / 10 }))
    .finally(() => { drinking = false; cachedWeaponName = null; });
  return true;
}

function onPhysicsTick(bot) {
  // THE RETURN comes before everything, engaged or not: a ghast fires from up to 64 blocks at a body that
  // has no fight open, and its fireball in strike reach is punched back along the line to the ghast, which
  // a returned fireball kills outright (fireball_return). The strike takes this tick's facing and swing.
  const returned = fireballReturn.serve(bot);
  if (returned) {
    crewLog.event(TAG, 'fireball_return', { fireball: returned.fireballId, ghast: returned.ghastId, at: `${returned.distance.toFixed(2)}b` });
    if (engaged) writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, crewBoard.readCommander()) });
    return;
  }
  if (!engaged) return;
  // Survival owns facing during the return to air, so the interrupted fight emits no further swing.
  if (require('@locomotion/underwater_swimming').survivalHasControl(bot)) return;
  stats.ticks++;

  const board = crewBoard.readCommander();
  const now = Date.now();
  noteGuardLedgerTick(bot, now);

  // THE MILK comes first: while the bucket is at the body's mouth the tick is the drink's.
  if (serveMilk(bot, now)) {
    writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: false, shieldWhy: null, shieldAgainst: null, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  // THE BLAST WALL comes first: while its place is in flight the tick is the place's.
  if (serveWall(bot, board, now)) {
    stats.wallTicks++;
    writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  // Shield decides before facing: with no focus its threat is what the body faces. A body running for its life
  // (self_preservation) holds no guard: the guard would stop its sprint. A creeper behind a standing wall
  // keeps its swell guard (THE BLAST WALL): the shield goes up behind the block once it is set, for the rays a slope
  // or a misplaced cell leaves open; its swell still holds the arm.
  const shielded = combatUtils.holdsShield(bot);
  // Running is the driver pressing a flee heading; a cornered body, with no heading to run, keeps its guard.
  const drv = crewBoard.readDriver();
  const fleeing = crewBoard.readSurvival().fleeing === true && drv.mode === 'flee' && !!drv.keys;
  const threats = senseThreats(board, now);
  // A shield that leaves the off-hand mid-fight is said once: a block costs it durability, and a broken one is gone.
  if (wasShielded && !shielded) crewLog.event(TAG, 'shield_lost', { up: shieldUp, held: shieldUpAt ? `${now - shieldUpAt}ms` : null });
  wasShielded = shielded;
  guardCensus = { threats: threats.map((t) => t.why).join('+') || 'none', active: (board.active || []).length, notching: (board.notching || []).length, shielded };
  let order = shieldOrder({ threats, now });
  const near = focusTarget();
  if (near && combatUtils.healsItself(near.name)) foughtWitch = near.id;
  // A RAISED SHIELD STAYS UP THROUGH AN OPEN DRAW: lowered and raised again for the same draw, its five-tick raise
  // starts over just as the arrow is due, and a release and a raise landing in one server tick restart it unseen.
  // Only through a draw whose blow comes due within STAY_UP_GAP_MS: against two archers some draw is always open, and a
  // guard held through all of them never came down but for the volley rest, which let arrows in (arena: 80 of 165 hp).
  if (!order.guard && shieldUp && threats.some((t) => raiseAtOf(t) - (now - t.since) < STAY_UP_GAP_MS)) order = { ...order, guard: true };
  // A blow the raised shield took is read off its wear (shieldHitAt) for the guard ledger and the shield_hit row.
  shieldHitAt(bot, now);
  readGuardLedger(bot, now, wornAt);
  const strikeNow = swingTarget(bot, board, near);
  // NO SHIELD, NO GUARD: an empty off-hand raised blocks nothing and holds the arm; the body's answer is its feet
  // (driver backs off a swell) and its swing.
  if (order.guard && !shielded) order = { ...order, guard: false };
  // NO GUARD ON THE RUN: a raised shield walks at a fifth of speed, and a running body faces its run, so a guard held
  // then covers nothing behind it and only lets the mobs catch it. Standing its ground, the guard raised for an archer's
  // draw also takes a melee mob's blow while it is up (guardBearing covers both).
  if (order.guard && fleeing) order = { ...order, guard: false };
  // NO GUARD ON THE WAY TO THE WITCH: a raised shield walks at a fifth of speed, and a body crawling behind it toward a
  // witch out of reach took three harming potions (9, 9, 8) for the arrows (3 each) it stopped, one blow landed on her in
  // 9 s. Until she is in the arm's reach only a swell raises the guard; in reach the guard works between the swings.
  if (order.guard && order.why !== 'swell' && combatUtils.witchOnly(near) && near.entity && near.entity.position && bot.entity
    && near.entity.position.distanceTo(bot.entity.position) > BOT_STRIKE_REACH && !threats.some((t) => t.why === 'swell')) {
    order = { ...order, guard: false };
    stats.witchDashTicks++;
  }
  const threatEntity = order.against != null ? (board.active || []).find((h) => h.id === order.against) : null;
  const gap = threatEntity && threatEntity.entity && threatEntity.entity.position && bot.entity
    ? threatEntity.entity.position.distanceTo(bot.entity.position) : null;
  // The mob the charged arm would strike this tick (THE SWING TARGET): the closest in reach, never the chase target as such.
  const strike = strikeNow;
  // A FRIEND IN THE SWEEP: swingNow withholds the swing, and the friend is published for the driver, which backs
  // the body off to draw the mob away (driver RECENTER).
  const sweepFriend = strike ? combatUtils.sweepFriend(bot, strike.mob.entity) : null;
  if (sweepFriend) stats.sweepWithheldTicks++;
  // A MELEE MOB GETS A KNOCKBACK SWING, an archer a plain one: with the arm charged and a melee mob the swing target,
  // the shield comes down and stays down until the driver reports sprint (THE KNOCKBACK SWING, driver), at most
  // KNOCKBACK_WAIT_TICKS, so the blow throws the mob back out of its own reach.
  // A creeper is struck the tick it comes into reach: the wait for a sprint would spend the window before its fuse.
  const meleeStrike = !!strike && !strike.predicted && combatUtils.combatTactic(strike.mob.name, strike.mob.entity) === 'BRAWLER';
  // THE VOLLEY REST (above): a guard against a group of shooters held VOLLEY_UP_MAX_MS comes down for VOLLEY_REST_MS.
  const resting = now < restUntil;
  // THE REST IS TAKEN ONLY WHERE IT BUYS SOMETHING: a melee blow the draws are holding, or feet that have somewhere to
  // go (a raised shield walks at a fifth of speed). A body holding its band with only archers to strike swings on their
  // cadence through the guard, and a rest there only let arrows in (arena: 80 of 165 hp of arrows landed in a rest).
  const restBuys = meleeStrike || drv.mode !== 'hold';
  // THE CHARGE: a guard up CRAWL_UP_MS without a break against one or two archers comes down the moment it blocks an
  // arrow, for CHARGE_REST_MS, and the feet and the arm have that long before the next arrow is due. An archer at close
  // range looses every second, so some draw is always due, the guard never comes down by itself, the arm is held and the
  // body crawls at a fifth of speed after an archer that backs away (arena: 39 s so, 48 arrows blocked, the shield broke,
  // and the archer killed the body).
  if (order.guard && order.why === 'notched_arrow' && !volley(board)) {
    if (resting) order = { ...order, guard: false };
    else if (shieldUp && shieldUpAt != null && now - shieldUpAt >= CRAWL_UP_MS && restBuys
      && wornAt != null && now - wornAt <= CHARGE_AFTER_BLOCK_MS) {
      restShield(bot, now);
      restUntil = now + CHARGE_REST_MS;
      stats.charges++;
      order = { ...order, guard: false };
    }
  }
  if (order.guard && order.why === 'notched_arrow' && volley(board) && (restBuys || resting)) {
    if (resting) order = { ...order, guard: false };
    else if ((shieldUp || resumingGuard) && shieldUpAt != null && now - shieldUpAt >= VOLLEY_UP_MAX_MS) {
      if (shieldUp) restShield(bot, now);
      else {
        // Lowered for a swing this moment: the guard is closed where it stands and the rest begins.
        crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'volley_rest' });
        resumingGuard = false; shieldUpAt = null; restUntil = now + VOLLEY_REST_MS; stats.volleyRests++;
      }
      order = { ...order, guard: false };
    }
  }
  // A SHOOTER IN REACH IS STRUCK ON THE CADENCE, as a spear wielder is: the guard comes down for each charged swing and
  // goes up again, whatever else is drawing, so an archer at the arm's length dies in seconds instead of shooting the
  // raised shield while the others' draws hold the arm.
  const shooterStrike = !!strike && combatUtils.shieldStops(strike.mob.entity);
  // A resting guard is no guard: the arm swings as a body with no shield would.
  // A creeper's strike is never held for an arrow: the arrow costs a few hearts, the fuse costs the fight.
  const creeperStrike = !!strike && strike.predicted;
  // A WITCH IN REACH IS STRUCK ON THE CADENCE too (combat_utils.healsItself): no shield stops her potions, her poison runs
  // while the arm waits, and she drinks back what was struck. An archer's draws held the guard up for 20 s with a witch at
  // 2.6 b, unstruck, while poison took the body from 18 hp to 4.
  // A LIT FUSE OUTRANKS HER: with a creeper swelling and a shield in hand the guard stays up toward it, so no blow on the
  // witch lowers it; the arm swings at her again once the fuse is gone.
  const fuseGuard = shielded && threats.some((t) => t.why === 'swell');
  const healerStrike = !!strike && combatUtils.healsItself(strike.mob.name) && !fuseGuard;
  // THE STRUCK ARCHER'S OWN DRAW STILL HOLDS THE ARM: the cadence passes over the other archers' draws, never the one in
  // reach. Its arrow leaves at arm's length while the guard is down for the swing or still rising after it (arena: 50 of
  // 200 hp of arrows landed so), and a skeleton draws one second in two, so two swings fit between its shots.
  const ownDraw = shooterStrike && !combatUtils.raisesThroughStrikes(strike.mob.entity)
    && swingBlocked(threats.filter((t) => t.id === strike.mob.id), now, shielded && now >= restUntil);
  // A LIT FUSE HOLDS EVERY BLOW, the cadences included: a guard lowered for a swing at an archer rose again 211 ms
  // before the blast and stopped none of it (arena: 20 hp in one blow).
  // EVERY DUE ARROW HOLDS THE ARM BUT AT THE WITCH: a swing at one archer or a creeper lowered the guard into the other
  // archer's arrow (raised 48-159 ms before it landed, short of the 250 ms a raise takes; 109 of 404 hp a round fell so
  // after the witch died). A draw is due one moment in four, so the cadence keeps three swings in four.
  const intoArrow = fuseGuard || ownDraw || (!healerStrike && swingBlocked(threats, now, shielded && now >= restUntil));
  if (strike && intoArrow && swingReady(bot, strike.gap)) stats.swingsIntoArrow++;
  // No knockback swing while running: its press is toward the mob.
  const kbReady = meleeStrike && !sweepFriend && !fleeing && swingReady(bot, strike.gap);
  if (kbSince === null) {
    if (kbReady && !intoArrow && stats.ticks >= kbRetryTick) kbSince = stats.ticks;
  } else if (!kbReady || intoArrow) {
    kbSince = null;
    stats.knockbackAborted++;
    kbRetryTick = stats.ticks + KNOCKBACK_RETRY_TICKS;
  }
  applyShield(bot, order, now, gap, kbSince !== null);

  // A RUNNING BODY FACES ITS RUN (driver THE RUN): sprint carries only the forward key, and a body that faces the mob
  // while it runs backpedals at a walk the mob keeps up with. No swing while it runs: a blow drops the sprint.
  if (fleeing && drv.heading) {
    stats.fleeTicks++;
    if (aimBearing(bot, Math.atan2(-drv.heading.x, -drv.heading.z))) stats.aimed++;
    writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  // The body always faces the mob it is engaged with (the commander's focus); a threat takes the yaw only when
  // there is no focus. A shield raised for another mob's notch is held toward the focus: a fight turned away from
  // its own mob is a fight with no swings.
  const guardFace = order.against !== null
    ? (board.active || []).find((h) => h.id === order.against) || null
    : null;
  const face = near || guardFace;
  // Measured against the nearest body, not the focus — a count against focus would read zero through a
  // fight spent turned away from a nearby zombie (Law 25).
  if (face && board.closest && face.id !== board.closest.id) stats.facedThreatOverClosest++;

  if (!face) {
    stats.noTarget++;
    // Facing LEFT WHERE IT IS: a neutral snap is an unasked write. `targetId` cleared so the next mob
    // reads as a change, not a hold.
    targetId = null;
    writeBoard({ heldYaw, targetId: null, lastSwingAt: null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  if (face.entity.id !== targetId) {
    targetId = face.entity.id;
    // Reports where the gunner decided to face — not a copy of commander's `focus` (what the crew picked
    // to kill). why: focus = the engaged mob, guard = no focus and a live threat took the facing.
    crewLog.event(TAG, 'face', {
      subject: crewLog.subject(face.entity),
      why: near && near.id === face.entity.id ? 'focus' : 'guard',
    });
  }

  // The guard faces the blows; any other tick faces the engaged mob.
  const guardYaw = shieldUp && kbSince === null ? guardBearing(bot, threats, now, board) : null;
  if (guardYaw !== null ? aimBearing(bot, guardYaw) : aim(bot, face.entity)) {
    stats.aimed++;
    stats.switches++;
    if (lastSwitchTick !== null) {
      const gap = stats.ticks - lastSwitchTick;
      if (stats.minSwitchGapTicks === null || gap < stats.minSwitchGapTicks) stats.minSwitchGapTicks = gap;
      if (gap < STUTTER_GAP_TICKS) stats.fastSwitches++;
    }
    lastSwitchTick = stats.ticks;
  } else {
    stats.heldSteady++;
  }

  // Aim then fire, same tick. The weapon is picked before the charge (PICK, CHARGE, SWING): a weapon that broke on the
  // last swing is replaced by the next pick.
  // Arm held only while the guard is actually up. STILL UNVERIFIED (Law 23): whether a swing sent while
  // `activateItem` is held actually lands.
  if (kbSince !== null) {
    // THE KNOCKBACK SWING: lowered for it (a blocking body cannot attack, nor sprint), thrown once sprint is held.
    if (shieldUp) lowerForSwing(bot);
    const sprinting = crewBoard.readDriver().sprinting === true;
    if (sprinting || stats.ticks - kbSince >= KNOCKBACK_WAIT_TICKS) {
      // Square to the swing target on the swing tick: the knockback is thrown along the facing.
      if (strikeAt(bot, strike, near)) {
        if (sprinting) stats.knockbackSwings++; else stats.knockbackUnsprinted++;
      }
      kbSince = null;
    } else {
      stats.knockbackWaitTicks++;
    }
  } else {
    // A GUARD WAITS FOR ITS DRAW TO CLEAR before the arm swings (notch, swell), with two exceptions that come down for each
    // charged swing and go up again: a trident drowned's or a spear wielder's hand never drops (a drowned's after each
    // throw), and a shooter in the arm's reach is struck on the cadence (`shooterStrike`).
    // The pick comes before the charge: a mob in reach with the wrong hand is equipped now, and the charge runs from it.
    if (strike && !armed(bot)) verifyWeapon(bot, 'pre-charge');
    const charged = !!strike && !intoArrow && swingReady(bot, strike.gap);
    const throwWindow = shooterStrike
      || (threatWhy === 'notched_arrow' && !!threatEntity && combatUtils.raisesThroughStrikes(threatEntity.entity));
    // A raised guard comes down for a charged swing at a creeper or a witch in reach, as for a shooter, and goes up again after it.
    if (shieldUp && (throwWindow || creeperStrike || healerStrike) && charged) lowerForSwing(bot);
    // THE CRIT (driver THE PRESS): a plain blow, at a witch or an archer, waits out the rise of a jump and leaves once the body falls.
    const vy = bot.entity && bot.entity.velocity ? bot.entity.velocity.y : 0;
    const plainStrike = healerStrike || shooterStrike;
    // Falling is read one tick late on purpose: the server learns of a move after this tick, so the blow leaves only
    // once a falling move has already been sent (vy past CRIT_FALL_VY), else the server sees the apex and no crit.
    const rising = plainStrike && !!bot.entity && !bot.entity.onGround && vy > CRIT_FALL_VY;
    if (shieldUp) stats.swingsHeld++;
    else if (charged && rising) stats.critWaitTicks++;
    else if (charged && strikeAt(bot, strike, near) && plainStrike && !bot.entity.onGround) {
      stats.critSwings++;
      crewLog.event(TAG, 'crit', { subject: `${strike.mob.name}#${strike.mob.id}`, vy: Math.round(vy * 100) / 100 });
    }
  }

  // After the swing decision, never before it — the fight outranks the errand.
  const terrainStatus = serveTerrain(bot, near, shieldUp);

  writeBoard({
    heldYaw,
    targetId,
    lastSwingAt: stats.lastSwingAt || null,
    swings: stats.swings,
    shield: shieldUp,
    shieldWhy: threatWhy,
    shieldAgainst: threatId,
    terrainStatus,
    sweepFriend,
    // The melee mob a knockback swing is held for, shield down, until the driver's sprint (THE KNOCKBACK SWING).
    knockback: kbSince !== null && strike ? strike.mob.id : null,
    loweredAt,
    readyInMs: readyIn(bot),
    wall: wallState(bot, board),
  });
}

// ---------------------------------------------------------------------------
// SECTION 3b: The terrain errand — the driver's ask, served by the yaw's owner
// ---------------------------------------------------------------------------
// Digging and placing need a facing, and the driver may never write yaw (Invariant D) — this seat serves
// the errand because it already holds the heading. The want is read fresh every tick; this seat holds
// only a job already IN FLIGHT, dropped when the want stops appearing (Invariant B). `performDig`/
// `pillarStep` are async and unawaited, so the job is STARTED here and read on a later tick off `_job.settled`.
function serveTerrain(bot, near, shieldUp) {
  const want = crewBoard.readDriver().terrainRequest;

  // Reported ONCE from the job's own recorded outcome (Law 23/25) — this seat says what it DID. Read before the
  // withdrawal test: a job that finished is reported done or failed even when the want has since moved on (a route's
  // next cell is asked the tick its block lands), never counted as dropped.
  if (_job && _job.settled) {
    const out = { kind: _job.kind, at: _job.at, state: _job.ok ? 'done' : 'failed', why: _job.why };
    if (_job.ok) stats.terrainDone++; else stats.terrainFailed++;
    crewLog.event(TAG, 'terrain', { state: out.state, kind: out.kind, why: out.why });
    // The errand's own look moved the head off the held facing, so the next tick aims afresh (Law 23); whatever
    // the errand left in the hand is the next charge's pick to correct.
    heldYaw = null;
    _job = null;
    return out;
  }

  // Withdrawal is silence: detected by comparing the live want against the job in flight.
  // A block the world already shows (a bridge or pillar set, a dig opened) is done even though its call has not settled:
  // the asker withdraws the tick the block appears, which is often before the place resolves.
  if (_job && (!want || want.kind !== _job.kind || !sameCell(want.at, _job.at))) {
    const b = _job.at && _job.kind !== 'open' ? bot.blockAt(new Vec3(_job.at.x, _job.at.y, _job.at.z)) : null;
    const solid = !!b && b.boundingBox === 'block';
    if (b && (_job.kind === 'dig' ? !solid : solid)) {
      stats.terrainDone++;
      crewLog.event(TAG, 'terrain', { state: 'done', kind: _job.kind, why: 'landed_before_settle' });
      heldYaw = null;
      _job = null;
    } else {
      stats.terrainDropped++;
      crewLog.event(TAG, 'terrain', { state: 'dropped', kind: _job.kind, why: want ? 'want_changed' : 'want_withdrawn' });
      dropJob(bot);
    }
  }
  if (!want) return null;
  if (_job) return { kind: _job.kind, at: _job.at, state: 'working', why: 'in_flight' };

  // Refused at the same reach the swing gate enforces. A raised shield refuses too — it owns the facing.
  if (shieldUp) return { kind: want.kind, at: want.at, state: 'refused', why: 'shield_up' };
  if (near && near.distance <= BOT_STRIKE_REACH) {
    stats.terrainRefused++;
    return { kind: want.kind, at: want.at, state: 'refused', why: 'target_in_reach' };
  }

  const at = new Vec3(want.at.x, want.at.y, want.at.z);
  const job = { kind: want.kind, at: { x: at.x, y: at.y, z: at.z }, settled: false, ok: false, why: null };
  _job = job;
  stats.terrainAccepted++;
  crewLog.event(TAG, 'terrain', { state: 'accepted', kind: job.kind, at: `${job.at.x},${job.at.y},${job.at.z}` });

  // `.then` turns a third-party rejection into a settled FAILURE with a reason (Law 16).
  if (want.kind === 'dig') {
    const block = bot.blockAt(at);
    // Nothing to break is a finished errand, not an error (Law 25).
    if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      job.settled = true; job.ok = true; job.why = 'already_clear';
    } else {
      // A loose leaf is cut as walking cuts it, with the sword kept in hand (leaf_authority.cut); anything else is dug.
      const leafAuthority = require('@utils/movement/leaf_authority');
      (leafAuthority.isPhantom(bot, block) ? leafAuthority.cut(bot, block, TAG) : performDig(bot, at, block, TAG)).then(
        // performDig answers a bare boolean (true only when the cell re-senses passable), never { success }.
        (r) => { job.settled = true; job.ok = r === true; job.why = r === true ? 'dug' : 'dig_failed'; },
        (e) => { job.settled = true; job.ok = false; job.why = `dig_threw:${e && e.message}`; });
    }
  } else if (want.kind === 'bridge') {
    // A floor block on a route's bridge edge: against the first solid neighbour, from the scaffold blocks carried, through the one
    // place route (Law 16).
    const items = bot.inventory.items();
    const item = BRIDGE_PREFS.map((name) => items.find((i) => i.name === name && i.count > 0)).find(Boolean) || null;
    const anchor = coverAnchor(bot, at);
    if (!item) { job.settled = true; job.ok = false; job.why = 'no_block'; }
    else if (!anchor) { job.settled = true; job.ok = false; job.why = 'no_anchor'; }
    else {
      performPlace(bot, at, anchor.block, anchor.face, item.name, TAG).then(
        (r) => { job.settled = true; job.ok = !!(r && r.ok); job.why = r && r.ok ? 'bridged' : (r && r.reason) || 'place_failed'; },
        (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; });
    }
  } else if (want.kind === 'open') {
    // A shut door on the route's door edge (driver edgeWant): clicked open, as the navigator's door reflex clicks it, from
    // this seat because the click turns the head.
    // SETTLED ONLY ONCE THE DOOR READS OPEN: the click resolves before the server's block update, and a door still read
    // shut after the job ended would be asked again, and the second click would shut it.
    const block = bot.blockAt(at);
    if (!isDoorBlock(block)) { job.settled = true; job.ok = false; job.why = 'no_door'; }
    else {
      const { isDoorOpen } = require('@locomotion/survival_instincts');
      (async () => {
        const click = await guardExternal(TAG, `activateBlock door at (${at.x},${at.y},${at.z})`, () => bot.activateBlock(block));
        if (!click.ok) return `open_failed:${click.reason}`;
        for (let t = 0; t < DOOR_OPEN_TICKS; t++) {
          if (isDoorOpen(bot.blockAt(at))) return null;
          const tick = await guardExternal(TAG, 'wait a tick for the door', () => bot.waitForTicks(1));
          if (!tick.ok) return `tick_wait_failed:${tick.reason}`;
        }
        return isDoorOpen(bot.blockAt(at)) ? null : 'door_did_not_open';
      })().then((why) => { job.settled = true; job.ok = why === null; job.why = why || 'opened'; });
    }
  } else {
    // Placement is a PILLAR UNDERFOOT and only that — `pillarStep` owns the whole verb (Law 16).
    pillarStep(bot).then(
      (r) => { job.settled = true; job.ok = !!(r && r.success); job.why = (r && r.reason) || (r && r.success ? 'pillared' : 'place_failed'); },
      (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; });
  }
  return { kind: job.kind, at: job.at, state: 'working', why: 'started' };
}

// Ticks a clicked door is given to read open before the errand fails (a second).
const DOOR_OPEN_TICKS = 20;

function sameCell(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

// coverAnchor(bot, at) → { block, face } for the first solid neighbour of `at` (below first, then the sides, then
// above), with the face that points from it into `at`; null when nothing solid touches the cell.
const ANCHOR_DIRS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
function coverAnchor(bot, at) {
  for (const [dx, dy, dz] of ANCHOR_DIRS) {
    const block = bot.blockAt(at.offset(dx, dy, dz));
    if (block && isBlockSolid(block)) return { block, face: new Vec3(-dx, -dy, -dz) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SECTION 4: Public API
// ---------------------------------------------------------------------------

function start(bot) {
  if (attached) return;
  stats = _blankStats();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  bot.on('entityDead', noteDeath);   // THE MILK
  bot.on('entityCriticalEffect', noteCrit);
  armGuardLedger(bot);
  attached = true;
}

// stop RUNS THE FIGHT'S TEARDOWN, not just the listener drop — a bare unlisten would leave the guard
// raised (Law 8). Calls disengage(bot) to share its body (Law 16).
function stop(bot) {
  if (!attached || !tickHandler) return;
  disengage(bot);
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  (bot || global.bot).removeListener('entityDead', noteDeath);
  (bot || global.bot).removeListener('entityCriticalEffect', noteCrit);
  tickHandler = null;
  attached = false;
}

// engage/disengage — the ONLY switch, separate from start/stop so the handler stays attached across a
// session (Law 8). Both ends clear facing+target (Invariant B).
function engage() {
  engaged = true;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  // A terrain job cannot outlive the wave that asked for it (Law 8).
  dropJob(global.bot);
  cachedWeaponName = null;
  wornAt = null;
  // Shield latch dies at both boundaries like the facing (Invariant B); `shieldUp` NOT forced false here.
  drawStarts.clear(); seenQuiet.clear(); releasedAt.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  resumingGuard = false;
  kbSince = null;
  kbRetryTick = 0;
  wall = null;
  restUntil = 0;
  stats = _blankStats();
}

function disengage(bot) {
  engaged = false;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  dropJob(bot || global.bot);
  // SHIELD COMES DOWN WITH THE FIGHT (Law 8): a guard left up outside an engagement slows the body.
  drawStarts.clear(); seenQuiet.clear(); releasedAt.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  if (resumingGuard && !shieldUp) {
    crewLog.event(TAG, 'shield', { state: 'down', held: `${Date.now() - shieldUpAt}ms`, by: 'disengage' });
    shieldUpAt = null;
  }
  resumingGuard = false;
  kbSince = null;
  kbRetryTick = 0;
  wall = null;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem on disengage', () => (bot || global.bot).deactivateItem());
    // by=disengage, not the timer's lower — the lens needs which hand closed the shield.
    crewLog.event(TAG, 'shield', { state: 'down', held: `${Date.now() - shieldUpAt}ms`, by: 'disengage' });
    shieldUp = false;
    shieldUpAt = null;
  }
  // `equipPending` NOT cleared: its own `.then` releases it (Law 8).
}

// report() — the gunner's own line, written by whoever owns the engagement boundary. Keeps only what the
// event stream can't carry: ticks that emitted nothing. BAND stays a ratio, never a raw switch count:
// `fastSwitches` vs `switches` discriminates judder from correct tracking of a circling mob (Law 25).
function report() {
  if (!stats || !stats.ticks) return;
  const s = stats;
  if (stats.terrainAccepted || stats.terrainRefused) {
    watcher.summary(TAG,
      `🔫 terrain errands: ${stats.terrainAccepted} accepted, ${stats.terrainRefused} refused (yaw spoken for), ` +
      `${stats.terrainDone} done, ${stats.terrainFailed} failed, ${stats.terrainDropped} dropped mid-flight. ` +
      `'done' is this seat's CLAIM about the world; the driver re-senses the cell before it walks (Law 23).`);
  }
  watcher.summary(TAG,
    `Gunner: ${s.ticks} tick(s) engaged — ${s.switches} yaw write(s), held steady on ${s.heldSteady}, ` +
    `${s.noTarget} with nothing hostile loaded. ` +
    `Band: ${s.fastSwitches} switch(es) inside ${STUTTER_GAP_TICKS} ticks of the last` +
    `${s.minSwitchGapTicks === null ? '' : `, closest pair ${s.minSwitchGapTicks} tick(s) apart`}. ` +
    `Arm: ${s.charged} charged tick(s) of ${s.inReach} spent inside reach, ` +
    `${s.equipChecks} hand check(s)${s.equipFails ? `, ${s.equipFails} found no weapon in the pack` : ''}. ` +
    // Shield cost in ticks the arm could not swing. `settleTicks` is the part spent AFTER the danger.
    `Shield: up for ${s.guardTicks} tick(s) of ${s.ticks}` +
    `${s.settleTicks ? ` (${s.settleTicks} settling after the threat cleared)` : ''}` +
    // Price of the guard: how much of the arm's charged time it ate, counted directly.
    `${s.swingsHeld ? `, arm held on ${s.swingsHeld} tick(s)` : ''}` +
    `${s.swingLowers ? `, lowered for ${s.swingLowers} swing(s)` : ''}` +
    `${s.knockbackSwings || s.knockbackUnsprinted ? `, knockback swings ${s.knockbackSwings} sprinted / ` +
      `${s.knockbackUnsprinted} thrown without sprint after ${KNOCKBACK_WAIT_TICKS} tick(s), ${s.knockbackWaitTicks} tick(s) waited, ${s.knockbackAborted} called off` : ''}` +
    `${s.swingsOffChase ? `, ${s.swingsOffChase} swing(s) at a mob other than the chase target` : ''}` +
    `${s.lowersUnswung ? `, ${s.lowersUnswung} lowering(s) raised again with no swing` : ''}` +
    `${s.facedThreatOverClosest ? `, facing off the nearest mob for ${s.facedThreatOverClosest} tick(s)` : ''}` +
    `${s.guardArcTicks || s.guardSplitTicks ? `, guard squared to the blows on ${s.guardArcTicks} tick(s) (split ${s.guardSplitTicks})` : ''}` +
    `${s.swingsIntoArrow ? `, ${s.swingsIntoArrow} charged tick(s) held behind the shield for a draw or an arrow` : ''}` +
    `${s.volleyRests ? `, the guard rested ${s.volleyRests} time(s) against a group of shooters` : ''}` +
    `${s.sweepWithheldTicks ? `, swing withheld for a friend in the sweep on ${s.sweepWithheldTicks} tick(s)` : ''}` +
    `${s.wallsTried || s.wallsStanding || s.wallsFlanked ? `. Blast wall: ${s.wallsSet} set of ${s.wallsTried} tried (${s.wallsFailed} failed), ${s.wallsStanding} already standing, ${s.wallsFlanked} held back for a flank (shield kept up), ${s.wallTicks} tick(s) placing` : ''}${s.fleeTicks ? `. Faced its run on ${s.fleeTicks} tick(s)` : ''}.`);
  // A fist-fight is a SUPPLY failure upstream of combat, invisible in every other number here (Law 25).
  if (s.barehandedSwings > 0) {
    watcher.warn(TAG,
      `${s.barehandedSwings} of ${s.swings} swing(s) were thrown with an empty hand. The weapon check ran ` +
      `${s.equipChecks} time(s) and found nothing to equip — this is an empty pack, not a broken equip.`);
  }
  if (s.fastSwitches > 0) {
    watcher.warn(TAG,
      `The facing switched ${s.fastSwitches} time(s) within ${STUTTER_GAP_TICKS} ticks of the previous switch. ` +
      `That is the judder the ${Math.round(YAW_HYSTERESIS_RAD * 180 / Math.PI)}° band is sized to remove — either the band is ` +
      `too narrow for this fight's geometry or two writers are on the yaw.`);
  }
}

// Inspection surface (Law 6). Snapshot, never the live variables — a caller could zero a counter the
// gunner is still accumulating into.
function state() {
  return {
    attached, engaged, targetId,
    heldYaw,
    heldDeg: heldYaw === null ? null : Math.round((heldYaw * 180 / Math.PI) * 10) / 10,
    stats: stats ? { ...stats } : null,
  };
}

module.exports = {
  start, stop, engage, disengage, report, state, STUTTER_GAP_TICKS,
  // Read by battle_stations at every retirement — see `connectedTo`.
  connectedTo,
  // Bench export, same terms as driver.bandOrder — the timer's value is WHEN it fires.
  shieldOrder, SHIELD_ACTIVE_MS, SHIELD_MARGIN_MS, SHIELD_HOLD_MS,
  // Read by self_preservation: a creeper further off the body's floor than this is not walled.
  WALL_LEVEL_DY,
};
