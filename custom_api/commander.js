// module: commander — the tank crew's COMMANDER, the fleet's ONLY monster scanner; every monster fact
// any seat acts on comes off the board this file writes (Law 16, Law 1). start/stop attach/detach a
// physicsTick handler; one synchronous sweep per tick, never awaits; holds the `crew_board` pen for the
// process. Aggro: a hostile in its aggro cylinder is confirmed by raycast, held with no decay; struck/swelling
// also admits everything in strike reach; a provoked-only species (PROVOKED_ONLY_NAMES) waits for its blow.

'use strict';

const crewBoard = require('@api/crew_board');
const crewLog = require('@api/crew_log');
const mobClaims = require('@api/mob_claims');
const combatBoard = require('@api/combat_board');
const threatScanner = require('@perception/threat_scanner');
const { swellDir, noteLit, UP } = require('@api/combat_counters/fuse_meter');
const predictionEngine = require('@api/combat_counters/prediction_engine');
const { bowDrawState } = require('@utils/calculators/archer_calculator');
const { hasEntityLineOfSight, lastSightlineBlock } = require('@utils/movement/terrain_predicates');
const { withinAggroRange, engageRangeFor, AGGRO_VERTICAL_RANGE, PREDATOR_GUARD, JOB_TYPE, FARM_PENS } = require('@thinking/architect_config');
const hq = require('@kernel/corporate_headquarters');
const watcher = require('@kernel/watcher');

const TAG = 'commander';

// Claims this module's crew_board pen at require time, so a second claimant throws immediately (Law 13).
const writeBoard = crewBoard.claimPen('commander');

// ── SECTION 1: Constants ──

// ── THE REACTIVE DOOR, BESIDE THE SIGHT DOOR ────────────────────────────────────────────────────────
// A blow or a swelling creeper also admits everything inside strike reach, sightline or not: what is touching
// the body is in the fight.
const STRIKE_REACH = 2.9;  // how close a mob must be to join a fight once the reactive door is open

// A creeper explosion (power 3) hurts every body within twice its power, so a swelling creeper this close is this
// body's to answer whoever claims it: a claim gives its holder the kill, not this body's health.
const CREEPER_BLAST_REACH = 6;

const REACTIVE_WINDOW_MS = 3000;  // ms the reactive door stays open after the last hit; re-arms per hit

// ── THE SIGHT DOOR TAKES EVERY HOSTILE THAT ATTACKS ON SIGHT ────────────────────────────────────────
// A hostile inside its aggro cylinder with a clear line is engaged before it lands a blow: the closest mob is
// always the one being fought, and a melee mob met under the shield is struck before it gets its hit in.
// A wall between the body and a mob still does the reasoning for free, since the line it blocks is the cast.
// Only mobs that are neutral until provoked wait for a blow (`striker`): fighting one is what makes it hostile.
// The enderman is not one of them: a body's passing glance provokes it, so it is taken by sight like any hostile.
const PROVOKED_ONLY_NAMES = new Set(['zombified_piglin', 'piglin']);

const AGGRO_RECHECK_MS = 500;  // re-cast interval for a hostile failing the line test, bounds cast budget

// ── SECTION 2: State ──
let attached = false;
let tickHandler = null;

let confirmed = new Set();  // raycast-confirmed aggro ids, pruned to ids seen this sweep (Law 8)
// ── THE MOB'S OWN SWING — when each hostile last swung its arm (the server's animate packet, sent as a melee mob
// attacks). A zombie attacks again only after its 20-tick cooldown, so the moment after its swing is the one a body can
// lower its shield to strike back in. Pruned with the sweep like `confirmed`.
let swungAt = new Map();    // id → ms of its last arm swing
let swingHandler = null;
// ── THE THROWN TRIDENT — when each trident drowned last threw. Its hand stays active through every throw, so the
// spawned trident entity is the release: it is credited to the trident drowned nearest its spawn point, within
// THROW_CREDIT_B. Pruned with the sweep like `swungAt`.
const THROW_CREDIT_B = 3;
let threwAt = new Map();    // id → ms of its last throw
let throwHandler = null;
// ── THE MOB'S CLOSING SPEED — how fast each hostile's distance to the body is shrinking, b/s, smoothed over sweeps.
// A strike thrown now leaves the shield down until it is raised and has blocked for 5 ticks; a melee mob closing
// fast reaches the body inside that time. Pruned with the sweep like `swungAt`.
const CLOSING_SMOOTH = 0.5;   // weight of the newest sample
const CLOSING_CAP = 8;        // b/s; a knockback or a teleport jump is not a walk
let closingOf = new Map();    // id → { d, at, rate }
let pursuitOf = new Map();    // id → { x, z, at, rate }
let helping = false;          // this squad body's focus is a squadmate's blob (THE HELP DOOR)
let castAt = new Map();     // last cast time per unconfirmed id, pruned the same way

// ── THE UNREACHABLE MARK ─────────────────────────────────────────────────────────────────────────────
// A mob the driver found no route to and took cover from (battle_stations retires it 'unreachable'). Held by time,
// not by the mob's movement: a mob pacing a cliff edge would otherwise clear its mark every few steps and be walked
// toward again. Pruned with the sweep like `confirmed`.
const UNREACHABLE_MS = 60000;
let unreachable = new Map();   // id → { at: when it was marked, until: when the mark lapses }
// marked(id, now) → the mark holding this mob, or null. freshBlow(id, struck) → a blow from it landed after its mark:
// the striker door admits a marked mob only for that, never again for the blow the cover already answered.
function marked(id, now) { const m = unreachable.get(id); return m && m.until > now ? m : null; }
function freshBlow(id, struck, now) { const m = marked(id, now); return !m || (!!struck && struck.at > m.at); }

const HOME_REREAD_MS = 5000;   // the pens' guard centres are re-read at most this often

// ── THE FLEE MARK ─────────────────────────────────────────────────────────────────────────────────────
// A mob the body just ran from (battle_stations, 'fled') is not taken again by sight while it stands beyond
// its clear reach (self_preservation.clearReach), whatever the body's survival board reads that sweep: a far mob is not a fight. Once
// it comes within that reach it is admitted, and the body runs again before its blow. A blow it lands admits it at
// once (the striker door). Pruned with the sweep. It is admitted FLEE_READMIT_MARGIN_B inside the reach the body ran to,
// so a body standing at its clear line is not taken back into the fight by the mob's next step.
const FLEE_READMIT_MARGIN_B = 4;
let fledFrom = new Set();

// ── EVENTS — kept only if a reader acts differently on it. aggro = opening fact (`via` names the door);
// lost = closes the lifecycle (Law 8); closest = nearest ACTIVE mob changed (what the world did, not
// battle_stations' `Target N`); swell/notch = on/off, since both are durations.
let stats = null;
function _blankStats() {
  return {
    sweeps: 0,   // ticks this process ran, the denominator for the counts below
    casts: 0,    // raycasts paid, including failed ones that produced no event
    // seenOutOfRange = envelope question (refused on distance); inRangeUnseen = terrain question (blocked).
    seenOutOfRange: 0,
    inRangeUnseen: 0,
    // drawUnread = decode FAILED (no metadata/registry/key); drawQuiet = decode succeeded, field unsent.
    drawUnread: 0,
    drawQuiet: 0,
    notchTicks: 0,   // sweeps that saw at least one aggroed hostile drawing a bow
  };
}

// ── ANNOUNCED STATE — one entry per fact currently true, so a sweep tells "still true" from "just
// became true" (Invariant B). Threat holders are maps id → name, latched on the on-edge.
let announced = _blankAnnounced();
function _blankAnnounced() {
  // `bearing`: id → last announced compass bucket, so only a change posts. Pruned with the sweep (Law 8).
  return { active: new Map(), closest: null, focus: null, swelling: new Map(), notching: new Map(), bearing: new Map() };
}

// ── SECTION 3: The sweep ──

// aggroVerdict → { aggroed, blockedBy, cast }. Gates cheapest-first: contact radius, species cylinder,
// then raycast (Law 16 — `withinAggroRange`, same cylinder predicate as architect_config).
const SIGHT_CAST_RANGE = 32;  // confirming-raycast horizon, independent of the aggro cylinder

// aggroVerdict → { aggroed, seen, inRange, blockedBy, cast }. `seen`/`inRange` are independent, always
// produced when a cast runs; engagement is their conjunction (Law 6). `seen` is null, never false, on a
// throttled sweep (Law 25); `reaction` is the sweep-level trigger, computed once and passed in.
// The mobs this body's gate has confirmed and handed its guard (THE TANDEM, combat_board).
const handed = new Set();

function aggroVerdict(bot, entity, name, distance, self, now, reaction) {
  if (confirmed.has(entity.id)) return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'held' };

  // ── THE ATTRIBUTED STRIKER — admitted at any distance ─────────────────────────────────────────
  // The measured source of a blow already landed — the case a radius-scoped reaction cannot answer.
  if (reaction.struckById != null && entity.id === reaction.struckById && freshBlow(entity.id, reaction.struck, now)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'striker' };
  }

  // ── THE BACKUP DOOR — a peer's attacker, admitted in this body's aggro range and in sight ──────────
  // The mob a peer ran from that the foreman's help desk assigned this body (self_preservation.calls, help_line).
  // Farther off, or out of sight, it is walked to by regular navigation (terminator_executor), not fought: the fight's
  // driver walks a close fight, facing the mob, and its clock counts only the fight.
  if (reaction.backup.has(entity.id)) {
    if (!withinAggroRange(self, entity.position, name)) {
      return { aggroed: false, seen: null, inRange: false, blockedBy: null, cast: false, via: null };
    }
    if (!hasEntityLineOfSight(bot, entity, SIGHT_CAST_RANGE)) {
      return { aggroed: false, seen: false, inRange: true, blockedBy: lastSightlineBlock(), cast: true, via: null };
    }
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: true, via: 'backup' };
  }

  // ── THE WARD DOOR — a mob a worker this guard walks with has declined (combat_board) ──
  if (reaction.ward.has(entity.id)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'ward' };
  }

  // ── THE CONTACT DOOR — a mob that has reached a declining worker (combat_board) ──
  if (reaction.contact.has(entity.id)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'contact' };
  }

  // ── THE RADAR DOOR — a mob a squadmate has in its fight, out of this body's own sight (combat_board) ──
  if (reaction.radar.has(entity.id) && distance <= combatBoard.RADAR_REACH_B) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'radar' };
  }

  // ── THE HELP DOOR — with the archers down, a squadmate's blob, past its claim ──
  if (reaction.help.has(entity.id)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'help' };
  }

  // ── THE AIMED DOOR — in a squad, an archer drawing on this body is this body's threat, whoever claims it ──
  if (reaction.aimed.has(entity.id)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'aimed' };
  }

  const withinReach = distance <= STRIKE_REACH;

  // ── THE REACTIVE DOOR ─────────────────────────────────────────────────────────────────────────
  // Struck or swelling arms it; anything within strike reach is then admitted as a threat.
  if (reaction.armed && withinReach) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'reaction' };
  }

  // ── THE SIGHT DOOR — every hostile but the provoked-only (see PROVOKED_ONLY_NAMES) ─────────────
  // A provoked-only species falls through to a decline regardless of distance or visibility. An enderman the server
  // flags angry (combat_utils.endermanAngry) is taken in its aggro cylinder with no sightline asked: it teleports to the
  // body for a blow (arena: 10.5 on Hard landed first while the door waited for it).
  if (name === 'enderman' && withinAggroRange(self, entity.position, name)
    && require('@utils/combat_utils').endermanAngry(bot, entity)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: null, inRange: true, blockedBy: null, cast: false, via: 'angered' };
  }
  // A terminator (designation T) takes the pack by sight (combat_utils TERMINATOR_TAKES).
  if (PROVOKED_ONLY_NAMES.has(name)
    && !(combatBoard.isTerminator() && require('@utils/combat_utils').terminatorTakes(name))) {
    // Fields match a cast's shape minus the cast: `seen: null` since nothing was measured (Law 25).
    return { aggroed: false, seen: null, inRange: withinReach, blockedBy: null, cast: false, via: null };
  }

  const inRange = withinAggroRange(self, entity.position, name);
  // THE FLEE MARK holds a fled mob out of the sight door while it stays beyond its clear reach, and admits it once it is
  // back inside by FLEE_READMIT_MARGIN_B, past the aggro cylinder and seen or not, so the body prices it again and runs before a shooter's
  // throw: a drowned threw from 15 b, at the cylinder's edge, at a body standing clear of it.
  if (fledFrom.has(entity.id)) {
    const reach = require('@api/self_preservation').clearReach({ name, entity }, bot);
    if (distance > reach) return { aggroed: false, seen: null, inRange, blockedBy: null, cast: false, via: null };
    if (distance <= reach - FLEE_READMIT_MARGIN_B) {
      confirmed.add(entity.id);
      return { aggroed: true, seen: null, inRange, blockedBy: null, cast: false, via: 'fled' };
    }
  }
  // A mob no route reached is not taken again by sight while its mark holds (markUnreachable); a blow it lands after
  // the mark still admits it through the striker door above, and the driver takes cover again.
  if (marked(entity.id, now)) {
    return { aggroed: false, seen: null, inRange, blockedBy: null, cast: false, via: null };
  }
  if (now - (castAt.get(entity.id) || 0) < AGGRO_RECHECK_MS) {
    return { aggroed: false, seen: null, inRange, blockedBy: null, cast: false, via: null };
  }
  castAt.set(entity.id, now);
  const seen = hasEntityLineOfSight(bot, entity, SIGHT_CAST_RANGE);
  if (seen && inRange) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: true, via: 'sight' };
  }
  // THE THROWER'S DOOR: a seen mob with a sight reach past the cylinder (architect_config MOB_SIGHT_REACH, a drowned's
  // trident) is taken within it, at the cylinder's height budget.
  if (seen && Math.abs(entity.position.y - self.y) <= AGGRO_VERTICAL_RANGE
    && Math.hypot(entity.position.x - self.x, entity.position.z - self.z) <= engageRangeFor(name)) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange, blockedBy: null, cast: true, via: 'thrower' };
  }
  // Read immediately after the cast, only when one happened (see lastSightlineBlock's header).
  return { aggroed: false, seen, inRange, blockedBy: seen ? null : lastSightlineBlock(), cast: true, via: null };
}

// ── THE PREDATOR DOOR ───────────────────────────────────────────────────────────────────────────
// A livestock predator is not hostile to the body, so the reactive model would let it eat a pen while every
// body watched. It is admitted where it threatens the herd (PREDATOR_GUARD): near a pen, or near this body while it
// herds, and only by a body carrying a sword or an axe. One that bit this body is admitted anywhere, armed or not, as
// any striker is. Claims still hold it to one body (mob_claims).
const HERD_JOB_TYPES = new Set([JOB_TYPE.herd_animal, JOB_TYPE.shepherd_pen]);

// A BODY STILL GUARDS THE HERD ITS FIGHT INTERRUPTED. Entering a fight drops the job (battle_stations.releaseJobClaim),
// so read off the chair alone the herding door would shut on the sweep after it opened: the wolf dropped from the
// fight, the wave left with nothing to strike, and the wolf marked unreachable while it still stalked the herd. The
// herd job is held as herding for one engagement ceiling (battle_stations.ENGAGEMENT_MAX_MS) after it was last seen.
let herdSeenAt = 0;
function _herding(now) {
  const chair = hq.readBoardroomChair(process.env.BOT_ID || 'default', {});
  if (chair && chair.magnet && HERD_JOB_TYPES.has(chair.magnet.job_type)) { herdSeenAt = now; return true; }
  return herdSeenAt > 0 && now - herdSeenAt <= require('@api/battle_stations').ENGAGEMENT_MAX_MS;
}

// The places a predator is fought on sight: every pen of this crew (FARM_PENS), where the herd is. Re-read on the
// home's clock; a pen not yet sited is not one.
let guardCenters = [];
let guardReadAt = 0;
function _guardCenters(now) {
  if (now - guardReadAt < HOME_REREAD_MS) return guardCenters;
  guardReadAt = now;
  guardCenters = FARM_PENS.map(pen => hq.readBuildingChair(pen, 'set_buildspot')).map(s => s && s.transpose_origin).filter(Boolean);
  return guardCenters;
}

function _predatorGuarded(pos, distance, centers, herding, armed) {
  if (!armed || distance > PREDATOR_GUARD.engage_blocks) return false;
  if (centers.some(c => Math.hypot(pos.x - c.x, pos.z - c.z) <= PREDATOR_GUARD.pen_blocks)) return true;
  return herding && distance <= PREDATOR_GUARD.herd_blocks;
}

function predatorVerdict(entity, distance) {
  confirmed.add(entity.id);
  return { aggroed: true, seen: true, inRange: distance <= STRIKE_REACH, blockedBy: null, cast: false, via: 'predator' };
}

// announce — the diff between what is true and what has been said. Runs after the sort (`closest`
// needs `active` ordered); a distance rides on `aggro` only, taken when the fight opened (Law 25).
function announce(active, swelling, notching, focus, focusWhy) {
  const seen = new Set();
  for (const h of active) {
    seen.add(h.id);
    if (announced.active.has(h.id)) continue;
    announced.active.set(h.id, h.name);
    crewLog.event(TAG, 'aggro', {
      subject: `${h.name}#${h.id}`,
      d: h.distance.toFixed(1),
      via: h.via,       // which door this mob came through: striker/reaction/sight/held (Law 6)
      dir: h.bearing,   // side the mob is on, carried on the opening row too (see bearingOf)
    });
  }
  for (const [id, name] of announced.active) {
    if (seen.has(id)) continue;
    announced.active.delete(id);
    // Cause of departure is not this seat's to say (Law 25); the lens joins the strike stream.
    crewLog.event(TAG, 'lost', { subject: `${name}#${id}` });
  }

  const closest = active.length ? active[0] : null;
  const closestKey = closest ? closest.id : null;
  if (closestKey !== announced.closest) {
    announced.closest = closestKey;
    if (closest) crewLog.event(TAG, 'closest', { subject: `${closest.name}#${closest.id}`, d: closest.distance.toFixed(1) });
  }

  // The chase target, announced on change: the driver drives to it and the gunner faces it; the swing is the gunner's pick.
  const focusKey = focus ? focus.id : null;
  if (focusKey !== announced.focus) {
    announced.focus = focusKey;
    if (focus) {
      crewLog.event(TAG, 'focus', {
        subject: `${focus.name}#${focus.id}`, d: focus.distance.toFixed(1), why: focusWhy,
        ...require('@utils/combat_utils').tacticRead(focus.name, focus.entity),
      });
    }
  }

  // ── THE PICTURE — every engaged mob once every PICTURE_MS: where it stands, how far, how it is classed and what it
  // holds, and which is the focus. Written to the combat ledger alone (no prose line), so a fight's geometry is rebuilt
  // from the record, not reconstructed from bearings.
  const tPic = Date.now();
  if (active.length && tPic - lastPicture >= PICTURE_MS) {
    lastPicture = tPic;
    const { tacticRead } = require('@utils/combat_utils');
    const r1 = (n) => Math.round(n * 10) / 10;
    require('@api/combat_record').record('picture', {
      focus: focus ? `${focus.name}#${focus.id}` : null, focus_why: focusWhy || null,
      flank: flank ? { shooter: flank.shooterId, melee: flank.meleeId, deg: flank.deg } : null,
      mobs: active.map((h) => {
        const t = tacticRead(h.name, h.entity);
        return { m: `${h.name}#${h.id}`, x: r1(h.position.x), y: r1(h.position.y), z: r1(h.position.z), d: r1(h.distance), tactic: t.tactic, hand: t.hand };
      }),
    });
  }

  // ── BEARING EDGE — cardinal direction per entity, announced on change only (signals orbiting/circling).
  const seenBearing = new Set();
  for (const h of active) {
    seenBearing.add(h.id);
    if (announced.bearing.get(h.id) === h.bearing) continue;
    announced.bearing.set(h.id, h.bearing);
    crewLog.event(TAG, 'bearing', { subject: `${h.name}#${h.id}`, dir: h.bearing, d: h.distance.toFixed(1) });
  }
  for (const id of announced.bearing.keys()) if (!seenBearing.has(id)) announced.bearing.delete(id);

  // Threat edges are on/off, not "happening" lines: every question about them is a duration (two ends).
  announceEdges('swell', swelling, active, announced.swelling);
  announceEdges('notch', notching, active, announced.notching);
}

function announceEdges(verb, ids, active, held) {
  for (const id of ids) {
    if (held.has(id)) continue;
    const h = active.find((a) => a.id === id);
    // A threat id absent from `active` cannot happen (Law 13).
    if (!h) throw new Error(`[commander] CODING VIOLATION: ${verb} on entity ${id}, which is not in this sweep's active list.`);
    held.set(id, h.name);
    crewLog.event(TAG, verb, { subject: `${h.name}#${id}`, state: 'on' });
  }
  for (const [id, name] of Array.from(held)) {
    if (ids.includes(id)) continue;
    held.delete(id);
    // Name from the latch, not `active`: on the death sweep the body is already out of the entity table.
    crewLog.event(TAG, verb, { subject: `${name}#${id}`, state: 'off' });
  }
}

// ── FOCUS — THE CHASE TARGET: the mob the driver walks the body to ──────────────────
// The nearest engaged mob is the one that can hit next, so it is the best mob to walk to. Nothing the mob is doing moves
// the pick: a notch or a swell is the shield's business (gunner), not a reason to walk to something further away.
// `why` says whether the pick changed this sweep. A squad body's pick comes first: the mob striking it, then its own
// mobs, then a squadmate's blob it is helping with.
// A WITCH ABOVE EVERYTHING (healerFirst): an engaged witch is the pick ahead of every other rule, a squad's, a spear
// wielder's and the brawlers'; the body walks past the rest to her (driver THE WITCH CHASE) and terminates her first.
// BRAWLERS FIRST in a mixed fight (brawlerFirst), for every body, the T-1A included: an archer the shield faces is no
// danger, so a brawler at hand is killed before a shooter is walked to. Only the witch is put ahead of the brawlers; the
// T-1A's engine (driver, THE FIELD AHEAD) walks to her round them.
// The chase is held FOCUS_HOLD_MS once picked while its mob is still active, whatever picks it (closest, squad, flank,
// ward): the driver walks to one mob for a full second until it is told again, so two mobs at one distance do not flip
// it every sweep; a held mob that heals itself is held until it dies (A HEALER IS FINISHED). What the arm strikes is not this: the gunner strikes the closest mob in reach on the charged tick
// (gunner, THE SWING TARGET), so a body walking to one mob still strikes every other that reaches it.
const FOCUS_HOLD_MS = 1000;
let focusSince = 0;             // when the chase target last changed
function chooseFocus(active, flankNow, squadPick, now) {
  if (!active.length) { focusId = null; return { focus: null, why: null }; }
  const held = focusId === null ? null : active.find((h) => h.id === focusId);
  const healer = healerFirst(active);
  const spear = healer ? null : spearFirst(active);
  const brawler = spear || healer ? null : brawlerFirst(active);
  let pick = healer || (squadPick ? squadPick.mob : spear || brawler || active[0]);
  const { healsItself } = require('@utils/combat_utils');
  // A witch takes the chase at once: the hold keeps no other mob over her.
  if (held && pick && pick.id !== held.id && now - focusSince < FOCUS_HOLD_MS && !(healsItself(pick.name) && !healsItself(held.name))) pick = held;
  // A HEALER IS FINISHED (combat_utils.healsItself): a held witch keeps the chase past FOCUS_HOLD_MS while it is still in the
  // fight, and a nearer witch does not take it: the one already struck is killed before she drinks it back.
  if (held && pick && pick.id !== held.id && healsItself(held.name)) pick = held;
  const why = pick.id === focusId ? 'held'
    : healer && pick.id === healer.id ? 'healer_first'
    : squadPick && pick.id === squadPick.mob.id ? squadPick.why
    : spear && pick.id === spear.id ? 'spear_first'
    : brawler && pick.id === brawler.id ? (flankNow && flankNow.meleeId === pick.id ? 'flank' : 'brawler_first')
    : focusId === null ? 'closest' : 'switched_to_closest';
  if (pick.id !== focusId) focusSince = now;
  focusId = pick.id;
  return { focus: pick, why };
}

// spearFirst(active) → the nearest spear wielder within SPEAR_FIRST_B, else null. Its blow is two of a zombie's and reaches past
// the hit-and-back's band, so among brawlers it is killed first, its blows taken on the shield meanwhile.
const SPEAR_FIRST_B = 8;
function spearFirst(active) {
  const { wieldsSpear } = require('@utils/combat_utils');
  return active.find((h) => h.distance <= SPEAR_FIRST_B && wieldsSpear(h.entity)) || null;
}

// healerFirst(active) → the nearest engaged mob that heals itself (combat_utils.healsItself: a witch), else null, at any
// distance. A WITCH IS KILLED FIRST, ahead of everything: its potions pass armour and shield, its poison runs on through
// the rest of the fight, and it drinks back what the body took off it. Brawlers walk to the body and strike it while it
// does; a witch left standing beside a brawler fight threw from 6-8 b for the whole of it (harming 6 and 4, poison,
// slowness) and the body died with the brawlers barely touched.
function healerFirst(active) {
  const { healsItself } = require('@utils/combat_utils');
  return active.find((h) => healsItself(h.name)) || null;
}

// brawlerFirst(active) → the nearest BRAWLER while a KITER is also engaged, within BRAWLER_FIRST_MARGIN_B of the nearest
// KITER, else null: the mixed fight's pick.
const BRAWLER_FIRST_MARGIN_B = 3;
function brawlerFirst(active) {
  const { combatTactic } = require('@utils/combat_utils');
  const kiter = active.find((h) => combatTactic(h.name, h.entity) === 'KITER');
  if (!kiter) return null;
  const brawler = active.find((h) => combatTactic(h.name, h.entity) === 'BRAWLER');
  return brawler && brawler.distance <= kiter.distance + BRAWLER_FIRST_MARGIN_B ? brawler : null;
}

// ── THE FLANK — the brawler is fought with the shooter lined up behind it ──────────────────────────────
// The shield blocks only what it faces, so a shooter off to the side while the body fights a brawler in front lands
// every arrow or trident. While a brawler is the focus (a squad's pick, or brawlers first in a mixed fight), and when the closest shooter
// (KITER) and the closest brawler (BRAWLER) stand at least FLANK_ENTER_DEG apart around the body, the driver walks
// round the brawler to the cell on its far side from the shooter (driver: THE FLANK). From there the shooter stands
// behind the brawler, both in front, where the shield already faces, and the arm strikes the brawler throughout. A
// shield blocks only from the half in front of the facing, so the flank opens short of 90°, with a margin for the body
// turning as it fights. It closes at FLANK_EXIT_DEG, below the opening angle, so a pair near the threshold does not
// flip every sweep. No brawler, no flank: shooters alone are walked straight at.
const FLANK_ENTER_DEG = 80;
const FLANK_EXIT_DEG = 40;
const FLANK_CREEPER_B = 7.5;   // the driver's GATHER_HOLD_RANGE_B: the blob's own reach
let flank = null;   // { shooterId, meleeId, deg } while open, else null
// THE PICTURE's cadence (see the sweep).
const PICTURE_MS = 1000;
let lastPicture = 0;

function flankOf(active, self) {
  const { combatTactic, strikesRepeatedly, wieldsSpear } = require('@utils/combat_utils');
  // A spear wielder is a KITER that strikes in reach: it is closed on and killed first, never lined up behind a brawler.
  const shooter = active.find((h) => combatTactic(h.name, h.entity) === 'KITER' && !wieldsSpear(h.entity));
  // Only a brawler that strikes again and again anchors a line-up: a creeper is never walked round (night 4: about 6 s of
  // flank points round creeper #2460 while a skeleton shot).
  const melee = active.find((h) => combatTactic(h.name, h.entity) === 'BRAWLER' && strikesRepeatedly(h.name));
  // Nor is one walked round with a creeper beside it: the flank's sprint runs the body inside the fuse distance (three of
  // three full-mix detonations with a shield). Within FLANK_CREEPER_B of a creeper the driver's blob back-off keeps
  // creeper and brawler in front, and the shield takes the shooter's arrows.
  const creeperNear = active.some((h) => h.name === 'creeper' && h.distance <= FLANK_CREEPER_B);
  let next = null;
  if (shooter && melee && !creeperNear) {
    const a = Math.atan2(shooter.position.z - self.z, shooter.position.x - self.x);
    const b = Math.atan2(melee.position.z - self.z, melee.position.x - self.x);
    let deg = Math.abs(a - b) * 180 / Math.PI;
    if (deg > 180) deg = 360 - deg;
    const holding = flank && flank.shooterId === shooter.id;
    const opens = deg >= FLANK_ENTER_DEG;
    const holds = holding && deg > FLANK_EXIT_DEG;
    if (opens || holds) next = { shooterId: shooter.id, meleeId: melee.id, deg: Math.round(deg) };
    if (next && !holding) {
      crewLog.event(TAG, 'flank', { subject: `${shooter.name}#${shooter.id}`, state: 'open', melee: `${melee.name}#${melee.id}`, deg: next.deg });
    } else if (!next && holding) {
      crewLog.event(TAG, 'flank', { subject: `${shooter.name}#${shooter.id}`, state: 'closed', deg: Math.round(deg), melee_d: melee.distance.toFixed(1) });
    }
  }
  if (!next && flank && creeperNear) crewLog.event(TAG, 'flank', { subject: `#${flank.shooterId}`, state: 'closed', why: 'creeper_near' });
  else if (!next && flank && !(shooter && flank.shooterId === shooter.id)) crewLog.event(TAG, 'flank', { subject: `#${flank.shooterId}`, state: 'closed', why: 'pair_gone' });
  flank = next;
  return flank;
}

// ── THE REGEN — EVERY BODY HEALS INSIDE ITS FIGHT ───────────────────────────────────────────────────────
// A fight ends when its last mob is gone, and then the body asks whether it needs to heal: poisoned or withered, or below
// full health. If it does, the fight is not over: it stays open (battle_stations holds the wave, holdForRegen), so the body
// does not go back to its task. It stands where the fight left it and eats what it carries; a mob that confirms its aggro
// meanwhile is fought as any fight is. It goes back to its task only once it is healed. A body that cannot heal skips the
// regen: no food in the pocket and hunger below REGEN_FOOD_MIN, where natural regeneration stops ('no_food').
// It ends healed (full health, no poison or wither); 'no_food' as above; or at REGEN_MAX_MS ('ceiling', a fault said aloud).
// A worker that ran home heals at home (self_preservation, idle_park); a terminator never runs.
const REGEN_EFFECTS = new Set(['poison', 'wither']);
const HP_FULL = 20;
const REGEN_FOOD_MIN = 18;
const REGEN_MAX_MS = 300000;
let regen = null;   // { since, why, hpFrom } while the body heals in its fight
// harmfulEffect(bot) → 'poison' | 'wither' while the body carries one, else null. Named off the live registry (Law 23).
function harmfulEffect(bot) {
  const hit = require('@utils/combat_utils').activeEffects(bot).find((e) => REGEN_EFFECTS.has(e.name));
  return hit ? hit.name : null;
}
function regenNeed(bot) {
  const effect = harmfulEffect(bot);
  if (effect) return effect;
  return typeof bot.health === 'number' && bot.health < HP_FULL ? 'hp' : null;
}
// starved(bot) → hunger below REGEN_FOOD_MIN and nothing edible in the pocket: health cannot come back.
function starved(bot) {
  const { group_to_item } = require('@utils/fragment_utils');
  return bot.food < REGEN_FOOD_MIN && !bot.inventory.items().some((i) => group_to_item.food.includes(i.name));
}
// holdForRegen(bot) → the regen this fight is held open for, or null: a body whose fight just ran out of mobs and that
// needs to heal, and can, starts one here. Called by battle_stations when a wave's last mob is gone.
function holdForRegen(bot) {
  if (regen) return regen;
  if (!bot.entity) return null;
  const why = regenNeed(bot);
  if (!why) return null;
  if (starved(bot)) {
    require('@api/combat_record').record('regen', { state: 'skipped', why: 'no_food', need: why, hp: Math.round(bot.health * 10) / 10, food: bot.food });
    return null;
  }
  regen = { since: Date.now(), why, hpFrom: bot.health };
  require('@api/combat_record').record('regen', { state: 'open', why, hp: Math.round(bot.health * 10) / 10, food: bot.food });
  return regen;
}
// regenOpen() → a regen holds the fight open now.
const regenOpen = () => regen !== null;
// regenTick(bot, now) — closes the regen once it has ended (see THE REGEN above). Run on every sweep.
function regenTick(bot, now) {
  if (!regen) return;
  const why = regenNeed(bot);
  const end = !why ? 'healed'
    : starved(bot) ? 'no_food'
    : now - regen.since >= REGEN_MAX_MS ? 'ceiling' : null;
  if (end) {
    const row = { state: 'closed', why: end, ms: now - regen.since, hp_from: Math.round(regen.hpFrom * 10) / 10, hp: Math.round(bot.health * 10) / 10, food: bot.food, effect: harmfulEffect(bot) };
    require('@api/combat_record').record('regen', row);
    if (end !== 'healed') watcher.warn(TAG, `Regen ended ${end} after ${Math.round(row.ms / 1000)}s at hp ${row.hp} food ${row.food}: the body goes back to its work unhealed.`);
    regen = null;
    return;
  }
  regen.why = why;
}

// ── POST-MORTEM FROM THIS SEAT — tracks who had notched or swelled before death, pricing the
// third-party witness client. Cause of death off metadata is a SUSPICION — field `suspect`, never
// `killer` (Law 25). `lastThreat` is a rolling latch since the death-tick entity table is tearing down
// (Invariant B); focusId is cleared in start()/stop() since entity ids recycle.
let focusId = null;

let lastThreat = new Map();     // id → { name, why, at } — the last tick this mob was drawing or swelling
let peakActive = 0;             // most hostiles active at once since the last death, for "how many"
let deathHandler = null;

// A death is a perception event: subscribes to the bot's own 'death' emit (Law 1).
function onDeath() {
  regen = null;   // a dead body heals nothing: THE REGEN ends with it
  const now = Date.now();
  const SUSPECT_WINDOW_MS = 1000;  // a bow draw is ~1000 ms; anything off the string longer is no candidate
  let suspect = null;
  for (const [id, t] of lastThreat) {
    if (now - t.at > SUSPECT_WINDOW_MS) continue;
    if (!suspect || t.at > suspect.at) suspect = { id, ...t };
  }
  crewLog.event(TAG, 'postmortem', {
    subject: suspect ? `${suspect.name}#${suspect.id}` : null,
    why: suspect ? suspect.why : 'nothing_drawing',
    engaged: peakActive,
    threatening: lastThreat.size,
  });
  lastThreat = new Map();
  peakActive = 0;
}

// ── Compass bucket per entity, world-axis not bot-facing (yaw changes independent of the mob); eight
// buckets not degrees (Law 16). +X = EAST, +Z = SOUTH, so atan2(dx, -dz) puts 0 at north, clockwise.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingOf(self, pos) {
  const dx = pos.x - self.x;
  const dz = pos.z - self.z;
  if (dx === 0 && dz === 0) return null;  // exactly on the bot has no direction; never fabricate one (Law 13)
  const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

// closingRate(id, d, now) → b/s the mob's distance shrank by since the last sweep, smoothed; 0 on first sight.
// pursuitRate(id, pos, self, now) → the b/s the mob itself walked toward the body, smoothed: it does not count the body's
// own running, so it reads a chase the distance alone hides from a body outrunning it.
function pursuitRate(id, pos, self, now) {
  const last = pursuitOf.get(id);
  if (!last || now <= last.at) { pursuitOf.set(id, { x: pos.x, z: pos.z, at: now, rate: last ? last.rate : 0 }); return last ? last.rate : 0; }
  const gap = Math.hypot(self.x - last.x, self.z - last.z) || 1;
  const walked = ((pos.x - last.x) * (self.x - last.x) + (pos.z - last.z) * (self.z - last.z)) / gap;
  const sample = walked / ((now - last.at) / 1000);
  const rate = last.rate + CLOSING_SMOOTH * (sample - last.rate);
  pursuitOf.set(id, { x: pos.x, z: pos.z, at: now, rate });
  return rate;
}

function closingRate(id, d, now) {
  const last = closingOf.get(id);
  if (!last || now <= last.at) { closingOf.set(id, { d, at: now, rate: last ? last.rate : 0 }); return last ? last.rate : 0; }
  const sample = Math.max(-CLOSING_CAP, Math.min(CLOSING_CAP, (last.d - d) / ((now - last.at) / 1000)));
  const rate = last.rate + CLOSING_SMOOTH * (sample - last.rate);
  closingOf.set(id, { d, at: now, rate });
  return rate;
}

// helpingBlobs(scanned, now) → Map mob id → the squadmate's position, for the blobs a free squad body joins: no archer
// stands in radar reach, this body is not healing, and it holds no claim of its own.
function helpingBlobs(scanned, now) {
  const out = new Map();
  if (!combatBoard.inSquad() || crewBoard.readSurvival().recovering === true) return out;
  if (combatBoard.claim() && !helping) return out;
  const { combatTactic } = require('@utils/combat_utils');
  if (scanned.some((s) => s.distance <= combatBoard.RADAR_REACH_B && combatTactic(s.name, s.e) === 'KITER')) return out;
  for (const c of combatBoard.liveClaims(now)) {
    if (!combatBoard.isSquadmate(c.botId)) continue;
    for (const id of c.blob || []) out.set(id, c.pos);
  }
  return out;
}

function sweep(bot) {
  const self = bot.entity && bot.entity.position;
  if (!self) return;
  const now = Date.now();

  const hostiles = [];
  const active = [];
  const swelling = [];
  const notching = [];
  const seenIds = new Set();
  let tracked = 0;

  // Lazy-required to avoid a require cycle with battle_stations, which reads this seat's board. Read before
  // the decode: a predator that bit this body is admitted wherever it stands.
  const struck = require('@api/battle_stations').struckWithin(REACTIVE_WINDOW_MS);
  const herding = _herding(now);
  const guarded = _guardCenters(now);
  const armed = ['sword', 'axe'].includes(require('@utils/combat_utils').pickBestWeapon(bot).rung);

  // ── PHASE 1: DECODE EVERY HOSTILE BEFORE JUDGING ANY OF THEM ──────────────────────────────────
  // The reactive trigger is a fact about the whole sweep, so every mob is decoded before any verdict.
  const scanned = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    if (e.isValid === false) continue;
    const predator = !threatScanner.isHostile(e) && threatScanner.isPredator(e, bot);
    if (!predator && !threatScanner.isHostile(e)) continue;
    const distance = self.distanceTo(e.position);
    const bit = !!(struck && struck.byId === e.id);
    if (predator && !bit && !_predatorGuarded(e.position, distance, guarded, herding, armed)) continue;

    seenIds.add(e.id);
    tracked++;
    const name = threatScanner.hostileName(e);

    // Read for every hostile, unfiltered by species: fuse_meter owns the decode (Law 16).
    const isSwelling = swellDir(bot, e) === UP;
    if (isSwelling) noteLit(e.id);

    // Notch likewise species-free: bit 0 of `living_entity_flags` is "using an item". Only 'drawing' is
    // positive evidence; both empty answers fall through to "not notching". A drowned's raised trident is a draw too: it
    // stays raised through every throw, so each throw is dated by its spawned trident (THE THROWN TRIDENT) as a release.
    const draw = bowDrawState(bot, e);
    const isNotching = draw === 'drawing';
    if (draw === 'unreadable') stats.drawUnread++;
    else if (draw === 'quiet') stats.drawQuiet++;

    scanned.push({ e, name, distance, isSwelling, isNotching, predator });
    // A doomed mob in sight renews its place on the combat road for its terminator (combat_board THE TERMINATOR).
    if (combatBoard.doomed(e.id)) combatBoard.sawDoomed(e.id, { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 }, now);
  }

  // ── THE TANDEM (combat_board) ─────────────────────────────────────────────────────────────────
  // A guard heals or runs off duty at once, so its worker fights for itself from that moment.
  const survival = crewBoard.readSurvival();
  if (survival.fleeing === true || survival.recovering === true) combatBoard.endDuty();
  else if (combatBoard.benchRole() === 'guard') combatBoard.standDuty(now);
  const magnet = require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  const declining = combatBoard.benchRole() === 'worker' ? combatBoard.guardOnDuty(now)
    : require('@thinking/job_gates').tandemWork(magnet) && combatBoard.tandemSeatOpen(now);
  if (!declining) handed.clear();
  const wardNow = combatBoard.wards(now);

  // ── THE TRIGGER, computed once ────────────────────────────────────────────────────────────────
  const anySwelling = scanned.some((s) => s.isSwelling);  // arms the door for every mob in reach
  const reaction = {
    armed: !!struck || anySwelling,
    struckById: struck && struck.byId != null ? struck.byId : null,  // null, not undefined: a real "no source" answer (Law 13)
    struck: struck || null,   // the blow itself, so a marked mob is admitted only for a blow after its mark
    // A peer's call for backup names the mobs this body answers (self_preservation).
    backup: require('@api/self_preservation').calls(bot),
    fleeing: crewBoard.readSurvival().fleeing === true,
    // A squad's shared sight, and with its archers down the blobs its members hold (combat_board).
    radar: combatBoard.radar(now),
    help: helpingBlobs(scanned, now),
    // The mobs this guard's ward has confirmed and handed it, within radar reach of the guard; a mob no route reached stays out.
    ward: new Set(scanned.filter((s) => wardNow.has(s.e.id) && s.distance <= combatBoard.RADAR_REACH_B && !marked(s.e.id, now)).map((s) => s.e.id)),
    // A worker's own fight: the mobs that have reached it, whoever claims them.
    contact: new Set(declining || combatBoard.workedRecently(now) ? scanned.filter((s) => !s.predator && !PROVOKED_ONLY_NAMES.has(s.name) && s.distance <= combatBoard.CONTACT_B).map((s) => s.e.id) : []),
    // Squad bodies only: an IrisBot healing took eight arrows from a skeleton another body held.
    aimed: new Set(combatBoard.inSquad() ? scanned.filter((s) => s.isNotching && !combatBoard.aimsElsewhere(s.e, self)).map((s) => s.e.id) : []),
    // Healing or outmatched: a mob it fled from is held out by THE FLEE MARK.
    wary: crewBoard.readSurvival().recovering === true || crewBoard.readSurvival().outmatched === true,
  };

  // ── ONE BODY FIGHTS A MOB (mob_claims) ─────────────────────────────────────────────────────────
  // A mob a peer's claim holds is not admitted: this body neither engages, faces nor strikes it.
  const peerHeld = mobClaims.owners();

  for (const { e, name, distance, isSwelling, isNotching, predator } of scanned) {
    // A mob biting this body is this body's to fight, whoever claims it: a peer's claim does not stop its teeth.
    // So is a swelling creeper inside its blast reach (CREEPER_BLAST_REACH): the fuse does not ask whose it is.
    // And so is a mob a peer's call for backup names: the claim is the caller's, and the caller is running.
    // And so is an archer drawing on it, and a squadmate's blob it has come to help with. And a mob it is running from:
    // a peer claiming the mob does not stop it chasing, and a body that stopped there was bitten to death.
    const runningFrom = reaction.fleeing && confirmed.has(e.id);
    const ownThreat = (struck && struck.byId === e.id) || (isSwelling && distance <= CREEPER_BLAST_REACH)
      || reaction.backup.has(e.id) || reaction.aimed.has(e.id) || reaction.help.has(e.id) || reaction.ward.has(e.id) || reaction.contact.has(e.id) || runningFrom;
    const claimedBy = ownThreat ? null : (peerHeld.get(e.id) || null);
    if (claimedBy) confirmed.delete(e.id);
    // A marked predator that has not bitten this body is passed over like a marked archer (THE UNREACHABLE MARK).
    const markedPredator = predator && !freshBlow(e.id, struck && struck.byId === e.id ? struck : null, now);
    // ── A WORKER CONFIRMS AS ANY BODY DOES AND HANDS THE FIGHT OVER ──
    // The gate runs as normal. A mob it confirms goes to the guard, not into this body's fight, but one that has reached it or
    // struck it, a fuse in its blast reach, and a fight already open.
    const struckByIt = !!(struck && struck.byId === e.id);
    const handsOver = declining && !confirmed.has(e.id) && !struckByIt && !reaction.contact.has(e.id) && !(isSwelling && distance <= CREEPER_BLAST_REACH);
    // A guard holds to its ward: past the leash a mob stays out of its fight unless it bit the guard.
    const leashed = !struckByIt && combatBoard.beyondLeash(e.position, now);
    if (leashed) confirmed.delete(e.id);
    let verdict = claimedBy || markedPredator || (handsOver && predator) || leashed
      ? { aggroed: false, seen: null, inRange: distance <= STRIKE_REACH, blockedBy: null, cast: false, via: null }
      : predator ? predatorVerdict(e, distance) : aggroVerdict(bot, e, name, distance, self, now, reaction);
    if (handsOver && verdict.aggroed) {
      handed.add(e.id);
      confirmed.delete(e.id);
      verdict = { ...verdict, aggroed: false, via: null };
    }
    if (verdict.cast) stats.casts++;
    // Both answers carried: seen-but-out-of-range is envelope, in-range-but-unseen is terrain (Law 6).
    if (verdict.cast) {
      if (verdict.seen && !verdict.inRange) stats.seenOutOfRange++;
      else if (!verdict.seen && verdict.inRange) stats.inRangeUnseen++;
    }

    // Aggroed mobs only: a non-aggroed hostile drawing far away must not reach announceEdges' Law 13
    // throw; gated here since consumers already intersect with `active`.
    if (verdict.aggroed && isSwelling) swelling.push(e.id);
    // In a squad, an archer aiming at another body raises no shield here: a raised shield walks at a fifth of speed, and
    // a follower crawled the whole way to a skeleton that was shooting the leader.
    if (verdict.aggroed && isNotching && !(combatBoard.inSquad() && combatBoard.aimsElsewhere(e, self))) notching.push(e.id);

    // Shape matches threat_scanner.scanThreats' fields plus `swelling`, unchanged so consumers need no edit (Law 16).
    const descriptor = {
      id: e.id,
      name,
      distance,
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      aggroed: verdict.aggroed,
      // true/false when a sight cast was paid, null when none was (throttled, marked, or provoked-only).
      seen: verdict.seen,
      via: verdict.via,
      claimedBy,  // the peer whose claim holds this mob, or null (mob_claims)
      blockedBy: verdict.blockedBy,
      swelling: isSwelling,
      // Taken past any peer's claim or yield: a swelling creeper inside CREEPER_BLAST_REACH, or a peer's attacker
      // this body answers (THE BACKUP DOOR), or an archer drawing on it (THE AIMED DOOR), or a blob it helps with (THE HELP DOOR).
      pastClaim: (isSwelling && distance <= CREEPER_BLAST_REACH) || reaction.backup.has(e.id) || reaction.aimed.has(e.id) || reaction.help.has(e.id) || reaction.ward.has(e.id) || reaction.contact.has(e.id) || runningFrom,
      walkTo: reaction.radar.has(e.id) || reaction.help.has(e.id) || reaction.ward.has(e.id),  // the gunner guards the walk only once it is close
      pursuit: pursuitRate(e.id, e.position, self, now),  // b/s the mob itself walks toward the body (self_preservation's run)
      notching: isNotching,
      // Side of the bot this mob is on — see `bearingOf`.
      bearing: bearingOf(self, e.position),
      swungAt: swungAt.get(e.id) || null,   // ms of this mob's last arm swing, or null (THE MOB'S OWN SWING)
      threwAt: threwAt.get(e.id) || null,   // ms of this mob's last trident throw, or null (THE THROWN TRIDENT)
      closing: closingRate(e.id, distance, now),  // b/s toward the body, negative when backing off (THE MOB'S CLOSING SPEED)
      entity: e,
    };

    hostiles.push(descriptor);
    if (verdict.aggroed) active.push(descriptor);
  }

  // Pruned to this sweep: a departed id never returns, so holding its confirmation is a pure leak (Law 8).
  if (confirmed.size) for (const id of confirmed) if (!seenIds.has(id)) confirmed.delete(id);
  if (castAt.size) for (const id of castAt.keys()) if (!seenIds.has(id)) castAt.delete(id);
  if (swungAt.size) for (const id of swungAt.keys()) if (!seenIds.has(id)) swungAt.delete(id);
  if (threwAt.size) for (const id of threwAt.keys()) if (!seenIds.has(id)) threwAt.delete(id);
  if (closingOf.size) for (const id of closingOf.keys()) if (!seenIds.has(id)) closingOf.delete(id);
  if (pursuitOf.size) for (const id of pursuitOf.keys()) if (!seenIds.has(id)) pursuitOf.delete(id);
  if (fledFrom.size) for (const id of fledFrom) if (!seenIds.has(id)) fledFrom.delete(id);
  if (unreachable.size) for (const [id, m] of unreachable) if (!seenIds.has(id) || m.until <= now) unreachable.delete(id);

  // Sorted here, once, not per reader: entity iteration order is not distance order (Law 16).
  hostiles.sort((a, b) => a.distance - b.distance);
  active.sort((a, b) => a.distance - b.distance);

  // Engagement verdict: a body fights only what has aggroed on it, or a peer's attacker through a door; the closest first,
  // wherever it stands.
  let engage = null, engageReason = null;
  if (active.length) { engage = active[0]; engageReason = 'aggro'; }

  // After the sort, before the announce, so board and record never disagree (Law 6). Threat set built
  // here, not re-derived in chooseFocus (Law 16).
  const threatenedIds = new Set([...swelling, ...notching]);
  const flankNow = flankOf(active, self);
  let squadPick = null;
  if (combatBoard.inSquad()) {
    const striker = struck ? active.find((h) => h.id === struck.byId) : null;
    const own = active.filter((h) => !reaction.help.has(h.id));
    if (striker) squadPick = { mob: striker, why: 'self_defense' };
    else if (!flankNow && reaction.help.size && own.length) squadPick = { mob: own[0], why: 'closest' };
    else if (!flankNow && reaction.help.size && active.length) {
      // The blob's mob nearest its holder, so a helper comes in on the holder's side and keeps the blob bunched.
      const toHolder = (h) => {
        const p = reaction.help.get(h.id);
        return p ? Math.hypot(h.position.x - p.x, h.position.z - p.z) : Infinity;
      };
      squadPick = { mob: active.slice().sort((a, b) => toHolder(a) - toHolder(b))[0], why: 'help' };
    }
  }
  // ── A GUARD PREFERS WHAT ITS WARD NAMES ──
  // It fights and switches as any body does; with nothing in its reach and nothing striking it, the mob its worker named comes first.
  if (!squadPick && !flankNow && reaction.ward.size && active.length && active[0].distance > STRIKE_REACH && !(struck && active.some((h) => h.id === struck.byId))) {
    const named = active.find((h) => reaction.ward.has(h.id));
    if (named) squadPick = { mob: named, why: 'ward' };
  }
  const { focus, why: focusWhy } = chooseFocus(active, flankNow, squadPick, now);

  // ── THE COMBAT ROAD (combat_board) ─────────────────────────────────────────────────────────────────
  // A melee focus's claim holds its whole blob. A helper's claim is not published: the holder's stands.
  helping = !!focus && reaction.help.has(focus.id);
  combatBoard.setHelping(helping);
  if (combatBoard.inSquad()) {
    const { combatTactic } = require('@utils/combat_utils');
    const melee = active.filter((h) => combatTactic(h.name, h.entity) === 'BRAWLER' && !reaction.help.has(h.id));
    if (focus && !helping) mobClaims.setBlob(melee.some((h) => h.id === focus.id) ? combatBoard.blobOf(focus, melee) : [focus.id]);
    combatBoard.setSeen(active.filter((h) => !reaction.help.has(h.id)).map((h) => h.id));
  }
  if (handed.size) for (const id of handed) if (!seenIds.has(id)) handed.delete(id);
  combatBoard.setWorking(declining, [...handed]);
  combatBoard.tick(bot, now);

  // Post-mortem latches stamped here — the one place both facts are in hand.
  for (const h of active) {
    if (!threatenedIds.has(h.id)) continue;
    lastThreat.set(h.id, { name: h.name, why: swelling.includes(h.id) ? 'swell' : 'notch', at: now });
  }
  if (active.length > peakActive) peakActive = active.length;

  stats.sweeps++;
  if (notching.length) stats.notchTicks++;
  announce(active, swelling, notching, focus, focusWhy);

  writeBoard({
    sweptAt: now,
    hostiles,
    active,
    tracked,
    closest: active.length ? active[0] : null,  // nearest active mob, the field the gunner faces (Law 25)
    focus,  // the one the crew is killing; closest is the one the world put nearest — they often disagree
    nearest: hostiles.length ? hostiles[0] : null,
    engage,
    engageReason,
    swelling,
    notching,
    flank: flankNow,
  });
  regenTick(bot, now);
}

// ── SECTION 4: Lifecycle ──

// Attached for the process (Law 8): sweeps whether or not a fight is open, so it never starves the gunner.
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  // Cleared with the rest: a fresh process re-announces every still-true fact (Law 8, not on `report`).
  announced = _blankAnnounced();
  confirmed = new Set();
  castAt = new Map();
  unreachable = new Map();
  guardCenters = [];
  guardReadAt = 0;
  lastThreat = new Map();
  peakActive = 0;
  focusId = null;
  flank = null;
  regen = null;
  tickHandler = () => sweep(bot);
  bot.on('physicsTick', tickHandler);
  deathHandler = () => onDeath();
  bot.on('death', deathHandler);
  swungAt = new Map();
  closingOf = new Map();
  pursuitOf = new Map();
  helping = false;
  combatBoard.reset();
  fledFrom = new Set();
  swingHandler = (e) => { if (e && e !== bot.entity && e.id != null) swungAt.set(e.id, Date.now()); };
  bot.on('entitySwingArm', swingHandler);
  threwAt = new Map();
  throwHandler = (t) => {
    if (!t || t.name !== 'trident' || !t.position) return;
    const { throwsTrident } = require('@utils/combat_utils');
    let by = null, best = THROW_CREDIT_B;
    for (const e of Object.values(bot.entities || {})) {
      if (!throwsTrident(e) || !e.position) continue;
      const d = e.position.distanceTo(t.position);
      if (d <= best) { best = d; by = e; }
    }
    if (by) threwAt.set(by.id, Date.now());
    crewLog.event(TAG, 'throw', { subject: by ? `drowned#${by.id}` : null, trident: t.id, credited: !!by, d: by ? best.toFixed(1) : null });
  };
  bot.on('entitySpawn', throwHandler);
  // The position updates the gunner's swing and the driver's creeper footwork predict from, kept for the process.
  predictionEngine.start(bot);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  (bot || global.bot).removeListener('physicsTick', tickHandler);  // EventEmitter bookkeeping, cannot fail (Law 13)
  // Both listeners off: a raised lifecycle terminates with its owner (Law 8).
  if (deathHandler) (bot || global.bot).removeListener('death', deathHandler);
  deathHandler = null;
  if (swingHandler) (bot || global.bot).removeListener('entitySwingArm', swingHandler);
  swingHandler = null;
  if (throwHandler) (bot || global.bot).removeListener('entitySpawn', throwHandler);
  throwHandler = null;
  predictionEngine.stop(bot || global.bot);
  tickHandler = null;
  focusId = null;
  flank = null;
  regen = null;
  attached = false;
  lastThreat = new Map();
  peakActive = 0;
  announced = _blankAnnounced();
  confirmed = new Set();
  castAt = new Map();
  unreachable = new Map();
  crewBoard.reset();
}

// report() — written by whoever owns the engagement boundary. Decisions are events (see `announce`);
// this is the residue of ticks that produced no event.
function report() {
  if (!stats || !stats.sweeps) return;
  const s = stats;
  // Both always printed: seen-but-out-of-range is the envelope population, in-range-unseen is terrain.
  watcher.summary(TAG, `Commander: ${s.sweeps} sweep(s), ${s.casts} raycast(s) paid — ` +
    `${s.seenOutOfRange} mob(s) SEEN but outside the aggro cylinder (envelope question), ` +
    `${s.inRangeUnseen} inside it but with no sightline (terrain question).`);
  // Said out loud, not inferred from a shield that never rises: a moved index reads as calm (Law 25).
  if (s.drawUnread > 0) {
    watcher.warn(TAG,
      `${s.drawUnread} pass(es) could not DECODE living_entity_flags on a hostile — no metadata array, no ` +
      `registry entry, or no such key. That is the notched-arrow signal the shield runs on, and a failed ` +
      `decode is NOT a skeleton that was not drawing. Beside ${s.notchTicks} notched sweep(s), suspect the ` +
      `metadata index rather than the fight.`);
  }
  // Reset here and nowhere else — this seat has no engage/disengage boundary.
  stats = _blankStats();
}

// release(id) — an engagement that stalled on this mob gives it up: the confirmation goes, so only the sight
// door (its cylinder and its sightline) or a blow it lands can admit it again. A held confirmation skips both,
// and a mob the body cannot reach would otherwise be engaged again at once, wave after wave.
function release(id) {
  confirmed.delete(id);
}

// markUnreachable(id) — the engagement retired this mob as unreachable: released, and refused by the sight door for
// UNREACHABLE_MS (see THE UNREACHABLE MARK).
function markUnreachable(id) {
  confirmed.delete(id);
  const now = Date.now();
  unreachable.set(id, { at: now, until: now + UNREACHABLE_MS });
}

// markFled(id) — the body ran from this mob and is clear of it (THE FLEE MARK).
function markFled(id) {
  confirmed.delete(id);
  fledFrom.add(id);
}

function state() {
  return { attached, confirmed: confirmed.size, board: crewBoard.readCommander(), stats: stats ? { ...stats } : null };
}

module.exports = { start, stop, report, state, release, markUnreachable, markFled, holdForRegen, regenOpen, UNREACHABLE_MS, STRIKE_REACH, REACTIVE_WINDOW_MS, AGGRO_RECHECK_MS, CREEPER_BLAST_REACH };
