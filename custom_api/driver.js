// module: driver — the crew's lower body. Owns WSAD/sprint everywhere a fight is open; reads the
// commander's board and the gunner's yaw; writes no yaw, sends no attack, derives no monster data.
// contract: start(bot)/stop(bot) attach/detach a physicsTick handler, one synchronous decision per tick
// (never awaits). engage()/disengage() bracket a wave. Only seat that may write forward/back/left/right/
// sprint/jump.
//
// One universal tactic (Law 16): close on the closest aggroed monster and hold the 2.9-1.9 band, except
// a swelling creeper, which a body without a shield backs off from. A melee mob, a creeper before it swells included, is
// met with the hit-and-back and the knockback swing, never behind the shield: the shield is for what is shot and for a
// blast (gunner). Retreat direction is a scored search over candidate
// steps (SECTION 4b), not a vector sum. Sprint is for three things only: the knockback swing, closing on a mob that shoots
// (a KITER), and running for its life. A melee mob or a creeper is walking to the body anyway, so it is walked to.
//
// The approach rides the navigator's pathfinder (SECTION 4c): the same search and guards, with digging dear and placing cheap.
// What differs from regular navigation is the two-stage search and the facing rule: the gunner faces the mob and these keys move the
// body under that facing. An aggroed mob is closed on and dispatched; only self_preservation runs from one.

'use strict';

const Vec3 = require('vec3');
const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { headingKeys } = require('@utils/movement/motion_primitives');
// The band below is derived from this reach; not copied locally (Law 16).
const { BOT_STRIKE_REACH, BOT_WIDTH } = require('@utils/combat_utils');
const { classifyFloor, eyePos, eyeLineHit } = require('@utils/movement/terrain_predicates');
const { computeAStar, isDoorBlock, EDGE_TYPES, keyOf, COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET, besideLava } = require('@utils/pathfinding_utils');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
// MOB_AGGRO_RANGE lists the skeleton family: the mobs that shoot from where they stand.
const { MOB_AGGRO_RANGE, CREEPER_FOOTWORK } = require('@thinking/architect_config');
const predictionEngine = require('@api/combat_counters/prediction_engine');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

const writeBoard = crewBoard.claimPen('driver');

const TAG = 'driver';

// ── SECTION 1: The numbers ─────────────────────────────────────────────────

// In the band the bot is within its own 3.0 b reach (BOT_STRIKE_REACH) and outside the mob's ~1.43 b,
// so every cooldown lands a hit.
const BAND_INNER = 1.9;
const BAND_OUTER = 2.9;
// The inner edge against a melee mob: outside a zombie's reach (about 2b centre to centre), inside the arm's.
const MELEE_BAND_INNER = 2.3;
// ── THE HIT-AND-BACK: EVERY MELEE MOB ──────────────────────────────────────────────────────────────────
// The shield is never raised to a melee blow (gunner), so every melee blow that lands is paid in full, and a slow weapon (a wooden axe, 1.25 s)
// recharges slower than a zombie attacks (1 s), so standing in reach trades blows. While the weapon is more than
// KITE_LEAD_MS from charged, a melee mob is held at KITE_INNER..KITE_OUTER, outside its own reach; inside the lead
// the ordinary band returns, the body closes at sprint and the knockback swing throws the mob back out.
const KITE_INNER = 3.3;
const KITE_OUTER = 3.8;
const KITE_LEAD_MS = 250;
// ── THE LINE: SEVERAL BRAWLERS, KITED INTO A COLUMN ───────────────────────────────────────────────────
// Two or more melee mobs within LINE_RANGE_B are fought backing away from them all (the retreat
// step and THE GATHER), so they follow from the front in a line and the nearest arrives first. The body never closes
// on the lead: with the arm charged it holds LINE_INNER..LINE_OUTER, where the lead walks into the arm's reach (3.0 b
// from the eyes, about 3.3 b centre to centre) while still outside its own (2.0 b at most). It strikes the lead only
// while every other brawler stands at least LINE_SAFE_B off after closing for LINE_LOOK_MS; while one is nearer, or the
// weapon is recharging, it holds the kite band and the knockback swing's press toward the lead is not made.
const LINE_RANGE_B = 8;
const LINE_INNER = 3.0;
const LINE_OUTER = 3.5;
const LINE_SAFE_B = 2.9;
const LINE_LOOK_MS = 400;

// CreeperSwellGoal only unwinds past 7.0 b strictly, so 7.5 clears it with margin.
const SWELL_CLEAR = 7.5;

// ── A CREEPER BEFORE ITS FUSE ─────────────────────────────────────────────────────────────────────────
// Its fuse lights 3.0 b out, centre to centre (CreeperSwellGoal, distanceToSqr < 9), and the arm first reaches it about
// 3.4 b out, so the band against it lies between the two, measured on prediction_engine's stopGap: where both bodies
// will be once this one has coasted to a stop and the creeper has walked on CREEPER_LEAD_MS. The gunner strikes it on the
// predicted reach the moment it enters; the blow throws it back out and it walks in again. The fuse is never met here:
// a swelling creeper keeps the swell's own walk.
// ONLY A STILL CREEPER IS CLOSED ON: one whose position has not changed for CREEPER_STILL_MS. One walking in, or thrown
// back by the last blow, comes to the body by itself; a body walking at it then doubles the closing speed and halves the
// window the arm has before the fuse distance.
//   move   the band is held with the feet: backed off when the creeper will stand inside CREEPER_INNER, and, while the
//          weapon recharges, inside CREEPER_OUTER: a creeper walking in is barely thrown back by a blow and returns
//          within a recharge, so the body keeps it out of reach until the arm is charged, then lets it walk in.
//   stand  the body holds where it stands while the creeper moves.
const CREEPER_INNER = 3.15;
const CREEPER_OUTER = 3.6;
const CREEPER_LEAD_MS = 100;
const CREEPER_STILL_MS = 600;

// Vanilla ground speeds, b/s; report context only.
const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;

// Stall-jump tap: auto-step covers 0.6 b, so this only fires on a full block or fence.
const STALL_EPS = 0.02;        // per-tick travel below this is the body not moving
const STALL_TICKS = 6;         // ~300 ms of pressing a key and going nowhere
const JUMP_TICKS = 4;          // ~200 ms of jump held: long enough to leave the ground

// ── SECTION 2: State ───────────────────────────────────────────────────────

// Module-level, cleared on every engage() so a tally does not outlive its fight (Law 25).
let attached = false;
let engaged = false;
let stats = null;
let tickHandler = null;

let sprintArmed = false;
// The body's own travel between ticks, distinct from distance-to-mob.
let lastPos = null;
let stallTicks = 0;
let jumpTicks = 0;
// Consecutive stall-jumps with no travel between them — feeds the dig ask (terrainWant).
let stallJumps = 0;
// Peer-yield standoff (see bandOrder), set and cleared by battle_stations.
let standoff = null;

// ── RECENTER: A FRIEND IN THE SWEEP ──────────────────────────────────────────────────────────────
// The gunner withholds a sword swing that would sweep a player (gunner board `sweepFriend`). The feet then back
// away from the mob RECENTER_BLOCKS past where they stood, drawing it off the friend, and the band resumes when
// that distance is reached or RECENTER_MAX_MS has passed (a mob that follows keeps the gap).
const RECENTER_BLOCKS = 3;
const RECENTER_MAX_MS = 3000;
let recenter = null;   // { setpoint, at, friend } while backing off

const NO_KEYS = { forward: false, back: false, left: false, right: false };

// Trace filter: a line is emitted only when the mode differs from last tick's (Invariant B).
let saidMode = null;
let saidOn = null;      // control mob when saidMode was posted, so a mob switch counts as a change
let saidSprint = false;
let saidFire = false;
let saidEdge = false;   // an edge stop is said once when it starts, not every tick it holds
let saidLedge = false;  // a step away from a ledge is said when it starts and when it ends (THE LEDGE)
let saidKnock = 'clear';  // the knock line said on each change: clear, stepping, held (THE KNOCK LINE)
let saidBackHeld = false;   // a back-off with no open heading is said once when it starts and once when it ends
// THE DIVE: a mob in water this far below the body's feet, out of the arm's reach, with no route step to walk, is swum
// down to: the body presses toward it and strokes down (underwater_swimming.swimDown), never left to sink.
const DIVE_BELOW_B = 1.5;
let diving = false;

function _blankStats() {
  return {
    ticks: 0, engagedTicks: 0, noTarget: 0,
    sprintTicks: 0, pressedTicks: 0,
    sprintAskedLastTick: 0, sprintHeld: 0, speedPeak: 0, sprintBlockedByShield: 0, knockbackTicks: 0, edgeHolds: 0, ledgeSteps: 0, knockSteps: 0, rayVetoed: 0, flankTicks: 0, gatherTicks: 0, gathers: 0, backHeld: 0, primedTicks: 0, kiteTicks: 0, lineTicks: 0, crowdedTicks: 0, fleeTicks: 0, wallHoldTicks: 0, planTicks: 0, pressTicks: 0, circleTicks: 0, critJumps: 0, fireOutTicks: 0,
    standoffTicks: 0, standoffErrSum: 0, creeperTicks: 0,
    recenters: 0,
    // inBandTicks = fraction of the fight in striking distance; worstBreach = deepest incursion.
    errSum: 0, errTicks: 0, worstBreach: 0, inBandTicks: 0,
    speedGotSum: 0, speedTicks: 0,
    // Kept apart from band error: unreachable-from-ground is a terrain fact, not a steering fault.
    verticalGapTicks: 0, verticalGapSum: 0,
    // The ask is this seat's whole half of the protocol; the gunner serves it (Law 25).
    terrainAskTicks: 0, terrainAskDig: 0, terrainAskPlace: 0, terrainAskBridge: 0, terrainAskOpen: 0, terrainRefusedTicks: 0,
    // The route searches (SECTION 4c): found, none (proven or out of thinking time), and the slowest think.
    routeSearches: 0, routeFound: 0, routeNone: 0, routeTimedOut: 0, routeOffEdge: 0, thinkMsMax: 0,
    gaveUp: 0, stuck: 0, routeHops: 0, routeJoined: 0, diveTicks: 0,
  };
}

// ── SECTION 3: The decision — pure, no bot, no world ───────────────────────

// bandOrder({ horizontal, dy, distance, swelling, standoff }) → { mode, setpoint, error }. Pure
// function; error is signed distance outside the band (positive too close, negative too far, 0 inside).
//
// The band's edges are 3-D reach facts, but the feet only move flat (Law 10); dy projects them onto the
// floor as sqrt(edge² − dy²), collapsing to 1.9–2.9 at dy = 0. vertical_gap means the projected band is
// empty — a feet verdict, not an engagement one (the engagement itself is decided elsewhere by raycast).
function bandOrder(opts = {}) {
  // dy defaults to 0: a caller with only a flat distance reads the unprojected band (Law 13).
  const d = Number.isFinite(opts.horizontal) ? opts.horizontal : opts.distance;
  const dy = Number.isFinite(opts.dy) ? opts.dy : 0;
  if (!Number.isFinite(d)) return { mode: 'no_target', setpoint: null, error: null };

  // A standoff (swell or peer yield) outranks the band — one branch, same meaning, different setter.
  const standoff = opts.swelling ? SWELL_CLEAR : (Number.isFinite(opts.standoff) ? opts.standoff : null);
  if (standoff !== null) {
    const mode = opts.swelling ? 'swell' : 'standoff';
    const err = standoff - d;
    if (err > 0) return { mode: `${mode}_flee`, setpoint: standoff, error: err };
    // Released only by whoever set it, never by arriving.
    return { mode: `${mode}_clear`, setpoint: standoff, error: 0 };
  }

  // Checked before the edges: an empty shadow has no floor position to name.
  const rise = Math.abs(dy);
  const outerEdge = Number.isFinite(opts.outer) ? opts.outer : BAND_OUTER;
  if (rise >= outerEdge) {
    // Still closes at flat zero even with an empty shadow; BOT_WIDTH marks "beneath it".
    if (d > BOT_WIDTH) return { mode: 'approach', setpoint: 0, error: -d, dy };
    // Reported, not acted on: closing the rest needs a climb/pillar/route this seat does not own.
    return { mode: 'vertical_gap', setpoint: null, error: 0, verticalOnly: true, dy };
  }
  const outer = Math.sqrt(outerEdge * outerEdge - dy * dy);
  // Inside BAND_INNER of rise, the inner shadow opens to the bot's own column.
  const innerEdge = Number.isFinite(opts.inner) ? opts.inner : BAND_INNER;
  const inner = rise >= innerEdge ? 0 : Math.sqrt(innerEdge * innerEdge - dy * dy);

  if (d > outer) return { mode: 'approach', setpoint: outer, error: outer - d };
  if (d < inner) return { mode: 'retreat', setpoint: inner, error: inner - d };
  return { mode: 'hold', setpoint: null, error: 0 };
}

// ── SECTION 4b: THE BACK-OFF — one move for every step back, the blob's included ───────────────────────
// Every step back in a fight is this one move: the band's retreat (the hit-and-back, the line), a swell's or standoff's
// clearance, and the blob (SECTION 4d). It is a general direction, not a straight line: the middle of the widest empty
// gap between the mobs pressing the body (straight away from a lone one), so every chaser follows from one side and
// strings out behind the first. The feet take the walkable heading nearest that direction, fanned out to either side
// in 30° steps (never past the gap's edge, never past 90°), level, a tread up or a tread down, so the back-off goes
// round a trunk and over a hill instead of stopping at them. A leaf counts as solid here: walked into it would need a
// cut, which stops the arm, so the back-off goes round a canopy too. A heading open two blocks deep is taken before
// one open for a single step. With no heading open the body holds where it stands and fights from there.
const BACK_RANGE_B = 8;          // the mobs whose bearings set the direction
const BACK_FAN_RAD = [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57];
const BACK_LOOK_B = [1.0, 2.0];  // the step's cell, and the one beyond it

// backDirection(self, mobs) → the bearing (radians, atan2(z, x)) to back off along, and how far either side of it the
// fan may turn; null with no mob.
function backDirection(self, mobs) {
  if (!mobs.length) return null;
  if (mobs.length === 1) {
    const m = mobs[0];
    const a = Math.atan2(self.z - m.z, self.x - m.x);
    return { angle: Number.isFinite(a) ? a : 0, limit: Math.PI / 2 };
  }
  const spread = spreadOf(self, mobs);
  return { angle: spread.gapMid, limit: Math.min(Math.PI / 2, spread.gapRad / 2) };
}

// standsAt(bot, feet) → the rise (0, +1 or -1) of a floor the body can stand on with two open cells above it, or null.
function standsAt(bot, feet) {
  const open = (c) => { const blk = bot.blockAt(c); return !blk || blk.boundingBox !== 'block'; };
  for (const dy of [0, 1, -1]) {
    if (classifyFloor(bot, bot.blockAt(feet.offset(0, dy - 1, 0))) && open(feet.offset(0, dy, 0)) && open(feet.offset(0, dy + 1, 0))) return dy;
  }
  return null;
}

// backHeading(bot, mobs) → { x, z, climb, offDeg, blocked } — the walkable heading nearest the back-off direction — or
// { held: true, blocked } when none is open, or null with no mob.
function backHeading(bot, mobs) {
  const self = bot && bot.entity && bot.entity.position;
  if (!self) return null;
  const points = (mobs || []).map((h) => (h && h.entity && h.entity.position) || null).filter(Boolean);
  const dir = backDirection(self, points);
  if (!dir) return null;
  let blocked = 0;
  let single = null;
  let ledged = null;   // the best heading found that runs toward a ledge (THE LEDGE), taken only when no other is open
  for (const off of BACK_FAN_RAD) {
    if (Math.abs(off) > dir.limit + 1e-6) continue;
    const a = dir.angle + off;
    const h = { x: Math.cos(a), z: Math.sin(a) };
    const cell = (b) => new Vec3(Math.floor(self.x + h.x * b), Math.floor(self.y), Math.floor(self.z + h.z * b));
    const rise = standsAt(bot, cell(BACK_LOOK_B[0]));
    if (rise === null) { blocked++; continue; }
    const beyond = standsAt(bot, cell(BACK_LOOK_B[1]).offset(0, rise, 0));
    const step = { x: h.x, z: h.z, climb: rise > 0, offDeg: Math.round(off * 180 / Math.PI) };
    if (edgeAhead(bot, self, h, LEDGE_WARY_B)) { if (!ledged) ledged = { ...step, ledge: true }; continue; }
    if (beyond !== null) return { ...step, blocked };
    if (!single) single = step;
  }
  if (single) return { ...single, blocked };
  return ledged ? { ...ledged, blocked } : { held: true, blocked };
}

// ── THE LEDGE: AN ENGAGED BODY KEEPS ITS DISTANCE FROM A DROP ─────────────────────────────────────────────────
// A blow throws the body away from the mob, and a body standing at a ledge goes over it. Where knockback will land is not
// priced here (the prediction engine's question); the ledge is only watched. An edge (THE EDGE: a fall past SAFE_DROP, a
// floor over lava or fire, unloaded ground) within LEDGE_WARY_B on any of LEDGE_HEADINGS bearings is a ledge near: a back-off
// takes a heading clear of ledges first (backHeading), and a body holding its band steps away from the ledges it sees
// (ledgeStep). A step that would itself run toward an edge is never taken; the body then holds where it stands.
const LEDGE_WARY_B = 2.5;
const LEDGE_HEADINGS = 8;

// ledgeStep(bot, self) → { x, z, ledges } — the heading straight away from every ledge within LEDGE_WARY_B — or null when no
// ledge is near or the step away is not standable or runs toward an edge itself.
function ledgeStep(bot, self) {
  let ax = 0, az = 0, ledges = 0;
  for (let i = 0; i < LEDGE_HEADINGS; i++) {
    const a = (2 * Math.PI * i) / LEDGE_HEADINGS;
    const h = { x: Math.cos(a), z: Math.sin(a) };
    if (!edgeAhead(bot, self, h, LEDGE_WARY_B)) continue;
    ax -= h.x; az -= h.z; ledges++;
  }
  if (!ledges) return null;
  const len = Math.hypot(ax, az);
  if (len < 1e-6) return null;   // ledges on every side alike: no way is farther from them
  const h = { x: ax / len, z: az / len };
  const feet = new Vec3(Math.floor(self.x + h.x * BACK_LOOK_B[0]), Math.floor(self.y), Math.floor(self.z + h.z * BACK_LOOK_B[0]));
  if (standsAt(bot, feet) === null || edgeAhead(bot, self, h, LEDGE_WARY_B)) return null;
  return { x: h.x, z: h.z, ledges };
}

// ── THE KNOCK LINE: NO MOB IS LET THROW THE BODY OFF ITS GROUND ──────────────────────────────────────────────
// A mob's blow throws the body straight away from the mob, a shield raised or not (26.1 LivingEntity.hurtServer: the
// blocked flag withholds the damage, not the knockback(0.4, dx, dz)). The throw starts at 0.4 b a tick level and 0.4 up,
// and the air keeps 0.91 of it a tick: about 3 b on level ground before the slide, 0.4 / 0.09 = 4.4 b at most over a
// drop. So the line from each mob near enough to strike, through the body, is the line the body will fly, and an edge on
// it within KNOCK_THROW_B (THE EDGE: lava, fire, a fall past SAFE_DROP) is where the next blow puts it. A body whose
// line ends at an edge steps, each tick, to the nearby ground where the fewest lines do, before the blow lands: round
// the mob, never toward the edge. Measured on a lava shore against three piglins: 10 of 20 fights went into the lava
// before this (Worklog 829).
const KNOCK_THROW_B = 3.5;      // the level throw, with its slide
const KNOCK_NEAR_B = 3.5;       // a mob this near can close and strike before the next step is done
const KNOCK_CROWD_B = 2.5;      // a step that ends this near another mob walks into its blow
const KNOCK_HEADINGS = 16;
const KNOCK_STEP_B = [1.0, 1.8];
// knockLines(bot, at, mobs) → [{ mob, edge }] for each mob near enough to strike whose throw from `at` meets an edge.
function knockLines(bot, at, mobs) {
  const out = [];
  for (const h of mobs) {
    const p = h.entity && h.entity.position;
    if (!p) continue;
    const dx = at.x - p.x, dz = at.z - p.z, d = Math.hypot(dx, dz);
    if (d > KNOCK_NEAR_B || d < 1e-3) continue;
    const edge = edgeAhead(bot, at, { x: dx / d, z: dz / d }, KNOCK_THROW_B);
    if (edge) out.push({ mob: h, edge });
  }
  return out;
}
// knockStep(bot, self, mobs, lines) → { x, z, left } — the heading of the step whose standing place leaves the fewest
// knock lines at an edge, fewer than now — or { held: true } when no step improves on where the body stands.
function knockStep(bot, self, mobs, lines) {
  let best = null;
  for (let i = 0; i < KNOCK_HEADINGS; i++) {
    const a = (2 * Math.PI * i) / KNOCK_HEADINGS;
    const h = { x: Math.cos(a), z: Math.sin(a) };
    if (edgeAhead(bot, self, h, KNOCK_STEP_B[1])) continue;
    const cellAt = (b) => new Vec3(Math.floor(self.x + h.x * b), Math.floor(self.y), Math.floor(self.z + h.z * b));
    if (standsAt(bot, cellAt(KNOCK_STEP_B[0])) !== 0 || standsAt(bot, cellAt(KNOCK_STEP_B[1])) !== 0) continue;
    const at = { x: self.x + h.x * KNOCK_STEP_B[1], y: self.y, z: self.z + h.z * KNOCK_STEP_B[1] };
    const left = knockLines(bot, at, mobs).length;
    // Among equal steps, the one that ends near the fewest mobs (a step into a blow costs what the line saved), then the
    // one that keeps the most ground between the body and the edges it was thrown at.
    const crowd = mobs.filter((m) => Math.hypot(at.x - m.entity.position.x, at.z - m.entity.position.z) < KNOCK_CROWD_B).length;
    const away = lines.reduce((s, l) => s + Math.hypot(at.x - (l.edge.x + 0.5), at.z - (l.edge.z + 0.5)), 0);
    const better = !best || left < best.left || (left === best.left && (crowd < best.crowd || (crowd === best.crowd && away > best.away)));
    if (better) best = { x: h.x, z: h.z, left, crowd, away };
  }
  return best && best.left < lines.length ? best : { held: true };
}

// ── SECTION 4f: THE FIELD AHEAD — a field holding a player walked by its price (prediction_engine), engine A only ───
// The T-1A's engine, kept for human players (combat_utils.fieldAheadOn): a field is not walked by the band against one
// mob: every stride round the body
// (PLAN_HEADINGS of them, PLAN_STRIDE_B long, each on ground standsAt will stand) is priced by prediction_engine.spotCost
// against the whole field as it will stand a moment from now, beside the price of standing still, and the cheapest is
// walked. Standing still is preferred by PLAN_STAY_BONUS and the last stride's heading by PLAN_KEEP, so the feet do not
// dither between two strides of nearly one price. A swelling creeper keeps its own back-off, the blast wall its hold, the
// knockback swing its press, and a run for life outranks it all, as for any walk of the fight.
const PLAN_HEADINGS = 16;
const PLAN_STRIDE_B = 1.5;
const PLAN_STAY_BONUS = 0.3;
const PLAN_KEEP = 0.2;
const PLAN_LOG_MS = 500;
// planField(board) → true when the engine is on (a T-1A with a player in the field) and the field is mixed: two
// combatants or more, one of them fighting from range.
// A FAR FOCUS IS WALKED TO BY THE ROUTE: the price looks one stride ahead and knows no way round a drop or a wall, so a
// focus beyond PLAN_NEAR_B is closed on by the approach and its route search, and the field is priced once it is near.
// Priced from 29 b over broken ground, no stride toward the focus stood and the body stood still for 46 s.
const PLAN_NEAR_B = 12;
function planField(board) {
  const active = board.active || [];
  if (!combatUtils.fieldAheadOn(active)) return false;
  const focus = board.focus ? active.find((h) => h.id === board.focus.id) : null;
  if (!focus || !(focus.distance <= PLAN_NEAR_B)) return false;
  return active.length >= 2 && active.some((h) => h.entity && combatUtils.combatTactic(h.name, h.entity) === 'KITER');
}
// planStep(bot, board, self) → { stay } or { x, z, climb }: the cheapest stride, or none.
function planStep(bot, board, self) {
  const picture = predictionEngine.threatPicture(board.active, board.swelling || []);
  const target = board.focus || null;
  const here = predictionEngine.spotCost({ x: self.x, z: self.z }, picture, target);
  let best = { stay: true, cost: here.cost - PLAN_STAY_BONUS, terms: here.terms, arc: here.arc };
  for (let i = 0; i < PLAN_HEADINGS; i++) {
    const a = (i * 2 * Math.PI) / PLAN_HEADINGS;
    const h = { x: Math.cos(a), z: Math.sin(a) };
    const rise = standsAt(bot, new Vec3(Math.floor(self.x + h.x), Math.floor(self.y), Math.floor(self.z + h.z)));
    if (rise === null) continue;
    const c = predictionEngine.spotCost({ x: self.x + h.x * PLAN_STRIDE_B, z: self.z + h.z * PLAN_STRIDE_B }, picture, target);
    const keep = lastPlan && !lastPlan.stay && h.x * lastPlan.x + h.z * lastPlan.z > 0.92 ? PLAN_KEEP : 0;
    if (c.cost - keep < best.cost) best = { stay: false, x: h.x, z: h.z, climb: rise > 0, cost: c.cost - keep, terms: c.terms, arc: c.arc, deg: Math.round(a * 180 / Math.PI) };
  }
  lastPlan = best;
  const key = best.stay ? 'stay' : String(best.deg);
  const now = Date.now();
  if (!saidPlan || (saidPlan.key !== key && now - saidPlan.at >= PLAN_LOG_MS)) {
    saidPlan = { key, at: now };
    const r2 = (n) => Math.round(n * 100) / 100;
    crewLog.event(TAG, 'plan', { step: key, cost: r2(best.cost), here: r2(here.cost), arc: best.arc, mobs: picture.length,
      terms: Object.fromEntries(Object.entries(best.terms).filter(([, v]) => v > 0).map(([k, v]) => [k, r2(v)])) });
  }
  return best;
}

// ── THE PRESS — a terminator stays on the witch and strikes her down (combat_utils.witchOnly) ─────────────────
// Every blow throws her back and every step after her is time she drinks and throws, so within WITCH_PRESS_B on her
// level the body goes straight at her, sprinting only past the arm's reach (a sprint blow throws her further), and keeps
// walking into her to WITCH_HOLD_B: the plain blow's throw is walked back while the weapon recharges. No mob between is
// walked round. Taken at WITCH_PRESS_B and WITCH_PRESS_DY and kept to WITCH_LEAVE_B and WITCH_LEAVE_DY, so a witch on a
// slope does not flip the walk between the press and the route every step (arena: 39 flips in one 22 s chase).
// THE CRIT: a blow thrown while the body falls strikes for half as much again (vanilla: falling, off the ground, not
// sprinting, arm charged), so with her in reach the body jumps as the arm comes ready (CRIT_LEAD_MS before it) and the
// gunner throws the blow on the way down (gunner THE CRIT). An archer in reach is struck the same way.
// THE CIRCLE: a melee mob within WITCH_CIRCLE_B of the body adds a sideways step round her, to the side away from the
// nearest such mob, so the body keeps her between itself and it while it strikes. The step is walked when the ground
// one block along it stands, else the straight press; an unrouted press, so THE EDGE probes it.
const WITCH_PRESS_B = 5;
const WITCH_PRESS_DY = 2.2;
const WITCH_LEAVE_B = 6.5;
const WITCH_LEAVE_DY = 3.2;
const WITCH_SPRINT_RELEASE_B = 4.5;
const CRIT_REACH_B = 2.8;
const CRIT_DY = 1.1;
const CRIT_LEAD_MS = 400;
let pressing = null;   // the witch the press holds, for its wider leave bounds
const WITCH_HOLD_B = 1.2;
const WITCH_CIRCLE_B = 4;
// witchPress(bot, self, witch, board) → { x, z, climb, circle } toward and round her, { stay: true } where she stands
// held with no mob to circle from, or null when she is past the press (the approach's route walks to her).
function witchPress(bot, self, witch, board) {
  const wp = witch.entity && witch.entity.position;
  if (!wp) return null;
  const tx = wp.x - self.x, tz = wp.z - self.z;
  const flat = Math.hypot(tx, tz);
  const held = pressing === witch.id;
  if (flat > (held ? WITCH_LEAVE_B : WITCH_PRESS_B) || Math.abs(wp.y - self.y) > (held ? WITCH_LEAVE_DY : WITCH_PRESS_DY) || !(flat > 0.01)) return null;
  const fx = tx / flat, fz = tz / flat;
  const ahead = flat > WITCH_HOLD_B ? 1 : 0;
  let from = null;
  for (const h of board.active || []) {
    if (h.id === witch.id || !h.entity || !h.entity.position || h.distance > WITCH_CIRCLE_B) continue;
    if (combatUtils.combatTactic(h.name, h.entity) !== 'BRAWLER') continue;
    if (!from || h.distance < from.distance) from = h;
  }
  let side = 0;
  if (from) {
    const across = (from.entity.position.x - self.x) * -fz + (from.entity.position.z - self.z) * fx;
    side = across > 0 ? -1 : 1;   // + the press's left: the mob stands left, so the body steps right round her
  }
  if (!ahead && !side) return { stay: true };
  const walk = (s) => {
    let x = fx * ahead + -fz * s, z = fz * ahead + fx * s;
    const n = Math.hypot(x, z);
    if (!(n > 0.05)) return null;
    x /= n; z /= n;
    const rise = standsAt(bot, new Vec3(Math.floor(self.x + x), Math.floor(self.y), Math.floor(self.z + z)));
    return rise === null ? null : { x, z, climb: rise > 0 };
  };
  const round = side ? walk(side) : null;
  const step = round || (ahead ? walk(0) : null);
  // No ground stands on the straight step: the route walks to her (null), unless the body already stands on her.
  if (!step) return ahead ? null : { stay: true };
  return { ...step, circle: round ? `${from.name}#${from.id}` : null };
}

// ── SECTION 4e: THE RUN — a body fleeing for its life (self_preservation) ─────────────────────────────────────
// FLEE_HEADINGS headings round the body, each walked ahead in FLEE_PROBE_B steps to FLEE_LOOK_B: a step is open when
// a floor stands level, a tread up or a tread down with two open cells over it, so a trunk or a wall ends the
// heading where it stands. THE RUN GOES TO THE GOAL (the nearest peer, or home): a heading is valued first by how
// straight it points there (FLEE_GOAL_PULL, as many b of gap as the heading is long), then by the gap its last open
// step keeps from the nearest mob, plus FLEE_KEEP_B for the heading run last tick, so the run does not turn at every
// tree. A heading whose walk passes within FLEE_PASS_B of a mob is not taken while any other is open, so a mob standing
// between the body and the goal turns the run sideways round it, never through it. With the mob out of the body's
// sight the run still walks to the goal. Sprinted, facing the run (gunner), with no guard to stop the sprint.
// A pull weaker than the gap term sends the run away from home whenever the mob stands on the home side.
//
// A BODY IN WATER SWIMS THE RUN: open water has no floor for a heading to stand on, so when no heading is open and the
// body is in water it swims straight away from the mobs, pulled toward the goal, with jump held to keep it up. A
// swimming body that found no floored heading pressed nothing while a drowned closed from 11.6 b to 5.8 b below it.
//
// A HEADING THE BODY STALLS ON IS BARRED for FLEE_BAR_MS, so the run turns to the next open one: the keep bonus held a
// body pressing one heading into an obstacle the probe read open (a base's pens and walls) for 9 s while a trident
// drowned walked back from 33 b to 14 b and threw twice. A heading the edge guard stops (THE EDGE) is barred the same way:
// a run held at a 4 b drop stood 8 s at 0.7 hp while two witches walked back from 25 b to 9.6 b.
//
// A RUN THAT HAS REACHED ITS GOAL KEEPS ITS GAP: once the body stands within FLEE_ARRIVED_B of the goal, the goal stops
// pulling for the rest of the run, and every heading is valued by the gap it keeps from the mobs. Pulled at a goal cell
// it could not step into, a body at home pressed one blocked heading for 17 s at 1 hp while a witch walked in from 31 b
// to 9.5 b and threw.
const FLEE_GOAL_PULL = 8;     // b of gap a heading straight at the goal is worth: the run's length, so the goal leads
const FLEE_SWIM_GOAL_PULL = 0.5; // a swum run weighs the goal against one unit of 'away': open water has no heading to probe
const FLEE_PASS_B = 3;        // a heading whose walk comes this near a mob is taken only when no other is open
const FLEE_HEADINGS = 16;
const FLEE_PROBE_B = 0.8;
const FLEE_LOOK_B = 8;       // b ahead each heading is walked; 4 b let a forest run make 3.0 b/s of a 5.6 b/s sprint
const FLEE_KEEP_B = 0.4;
const FLEE_BAR_MS = 1500;
const FLEE_BAR_DOT = 0.95;    // a heading this close to a barred one is barred with it
const FLEE_ARRIVED_B = 3;     // within this of its goal the run has arrived, and only the gap leads
let lastFlee = null;
let fleeArrived = false;      // this run has reached its goal (reset when the run ends)
let fleeBarred = [];          // [{ x, z, until }]
// barFleeHeading() — the run stalled: the heading it was pressing is barred.
function barFleeHeading(now) {
  if (!lastFlee) return;
  fleeBarred.push({ x: lastFlee.x, z: lastFlee.z, until: now + FLEE_BAR_MS });
  lastFlee = null;
}
function fleeStep(bot, hostiles, goal) {
  const self = bot.entity.position;
  const points = (hostiles || []).map((h) => h && h.entity && h.entity.position).filter(Boolean);
  let g = null;
  if (goal) {
    const gx = goal.x - self.x, gz = goal.z - self.z, gl = Math.hypot(gx, gz);
    if (gl <= FLEE_ARRIVED_B && !fleeArrived) {
      fleeArrived = true;
      crewLog.event(TAG, 'flee_arrived', { d: Math.round(gl * 10) / 10, mobs: points.length });
    }
    if (!fleeArrived) g = { x: gx / gl, z: gz / gl };
  }
  if (!points.length && !g) return null;
  const gapAt = (x, z) => (points.length ? Math.min(...points.map((q) => Math.hypot(x - q.x, z - q.z))) : 0);
  const open = (c) => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'block'; };
  const now = Date.now();
  fleeBarred = fleeBarred.filter((b) => b.until > now);
  const gapNow = gapAt(self.x, self.z);
  let best = null;
  let bestPast = null;   // the best heading that passes a mob, taken only when no other is open
  for (let i = 0; i < FLEE_HEADINGS; i++) {
    const a = (i * 2 * Math.PI) / FLEE_HEADINGS;
    const hx = Math.cos(a), hz = Math.sin(a);
    if (fleeBarred.some((b) => hx * b.x + hz * b.z > FLEE_BAR_DOT)) continue;
    let y = Math.floor(self.y), reach = 0, climb = false, nearest = Infinity;
    for (let s = FLEE_PROBE_B; s <= FLEE_LOOK_B + 1e-6; s += FLEE_PROBE_B) {
      const fx = Math.floor(self.x + hx * s), fz = Math.floor(self.z + hz * s);
      const dy = [0, 1, -1].find((k) => classifyFloor(bot, bot.blockAt(new Vec3(fx, y + k - 1, fz)))
        && open(new Vec3(fx, y + k, fz)) && open(new Vec3(fx, y + k + 1, fz)));
      if (dy === undefined) break;
      if (dy === 1 && reach === 0) climb = true;
      y += dy;
      reach = s;
      if (points.length) nearest = Math.min(nearest, gapAt(self.x + hx * s, self.z + hz * s));
    }
    if (reach === 0) continue;
    const v = gapAt(self.x + hx * reach, self.z + hz * reach) - gapNow
      + (g ? FLEE_GOAL_PULL * (hx * g.x + hz * g.z) : 0)
      + (lastFlee && hx * lastFlee.x + hz * lastFlee.z > 0.95 ? FLEE_KEEP_B : 0);
    const passes = nearest < FLEE_PASS_B && nearest < gapNow;
    const row = { v, h: { x: hx, z: hz, climb } };
    if (passes) { if (!bestPast || v > bestPast.v) bestPast = row; } else if (!best || v > best.v) best = row;
  }
  if (!best) best = bestPast;
  if (!best && bot.entity.isInWater) {
    let ax = 0, az = 0;
    for (const q of points) {
      const dx = self.x - q.x, dz = self.z - q.z, d = Math.hypot(dx, dz) || 1;
      ax += dx / d; az += dz / d;
    }
    if (g) { ax += FLEE_SWIM_GOAL_PULL * g.x; az += FLEE_SWIM_GOAL_PULL * g.z; }
    const al = Math.hypot(ax, az);
    if (al > 1e-6) best = { v: 0, h: { x: ax / al, z: az / al, climb: false, swim: true } };
  }
  lastFlee = best ? best.h : null;
  return best ? best.h : null;
}

// ── SECTION 4d: THE GATHER — the blob: approaching brawlers are walked in front before they strike ───────────
// A guard covers the half in front of the facing; a brawler beside or behind the body lands its blow. The body does not
// go out of its way to gather: it fights the closest mob always. The gather is the walk BETWEEN swings while a
// brawler other than the closest is still coming in — within GATHER_RANGE_B but beyond BLOB_STRIKE_B — and the
// brawlers near stand spread over more than GATHER_ENTER_DEG around the body: the body backs off (THE BACK-OFF,
// SECTION 4b) even where the band would hold, which turns every chaser's bearing toward one side, so the newcomer
// arrives in front, into the blob. Once every brawler near is inside strike range the gather ends and the body simply fights
// the closest. Brawlers that strike again and again count, and a creeper that has not lit: gathered in front, the arm
// reaches it on its way in (gunner, a creeper in reach is struck first). Its strike range is CREEPER_OUTER, the band it
// is held at. An archer is not walked into.
// The gather holds until the spread closes to GATHER_EXIT_DEG, so it does not flip at the threshold.
const GATHER_RANGE_B = 6;
const GATHER_ENTER_DEG = 80;
const GATHER_EXIT_DEG = 45;
const GATHER_HOLD_RANGE_B = 7.5;   // while gathering, a brawler counts out to here, so one at the edge does not flicker it
const BLOB_STRIKE_B = 2.5;      // a brawler's strike range: inside it, it is fought, not walked around

// spreadOf(self, mobs) → { arcDeg, gapMid } for the bearings of `mobs` around `self`, or null with fewer than two:
// arcDeg is the smallest arc covering them all, gapMid the bearing (radians, atan2(z, x)) of the middle of the widest
// empty gap between them.
function spreadOf(self, mobs) {
  const angles = mobs.map((p) => Math.atan2(p.z - self.z, p.x - self.x)).sort((a, b) => a - b);
  if (angles.length < 2) return null;
  let gap = -1, from = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    if (next - angles[i] > gap) { gap = next - angles[i]; from = angles[i]; }
  }
  return { arcDeg: (2 * Math.PI - gap) * 180 / Math.PI, gapMid: from + gap / 2, gapRad: gap };
}

// ── SECTION 4c: The route — a short hop walked while a long plan is searched past its end ──────────
// computeAStar under the navigator's own guards (navigator.freshSearchState), never through a build (spareBuilds). COMBAT_THINK_MS
// is the short search: out of thinking time, its closest explored cell is a hop the body walks at once. While it walks, a search of
// LONG_THINK_MS starts from the hop's end; if the body has not passed that cell when it answers, the two are joined. The search
// runs from battle_stations' pass loop (think), never from the tick; the tick follows the latest route cell by cell under the
// gunner's facing, and asks the gunner for each dig and block the route's edges need (edgeWant).
const COMBAT_THINK_MS = 300;
const LONG_THINK_MS = 2000;
// ── A FIGHT WALKS EVERY EDGE THE NAVIGATOR WALKS ──────────────────────────────────────────────────────────
// The edges come from the pathfinder's own catalogue (pathfinding_utils.EDGE_TYPES), so combat never lags the walk: a
// swim, a wade, a door and the three ways out of water are walked in a fight as on a job. What differs is how, not what:
// the gunner owns the facing, so every block set, dug or door opened on the way is asked of it (edgeWant), and the keys
// move the body under the mob-facing yaw. EDGE_DRIVE says how each edge is driven:
//   walk   the heading to the cell, pressed (a door's cell is opened first, a dug or bridged edge worked first)
//   climb  the same, jump held as the body reaches a tread up (a stair, a pillar's rise, a container's rim)
//   swim   the heading to the cell, jump held while the head is under or the cell stands higher; arrived in the cell
//   exit   out of water by a block set beside the body: centred, the block asked for, swum onto, then up
// Refused, with the reason: an airlock keeps the base shut against the mobs this body is fighting, so no fight opens one.
const COMBAT_REFUSED_EDGES = Object.freeze({ airlock: 'the airlock keeps the base shut against the mobs being fought' });
const EDGE_DRIVE = Object.freeze({
  walk: 'walk', door: 'walk', bridge: 'walk', dig_through: 'walk', dig_down: 'walk', dig_stair_down: 'walk', climb_down: 'walk',
  climb_up: 'climb', dig_stair_up: 'climb', jump_out: 'climb', pillar: 'climb',
  swim: 'swim', water_exit: 'swim', wade: 'swim', wade_down: 'swim',
  water_bank_out: 'exit', water_step_up: 'exit',
});
const COMBAT_EDGES = new Set(EDGE_TYPES.filter((e) => !COMBAT_REFUSED_EDGES[e]));
// Law 13: an edge the pathfinder mints that this seat neither drives nor refuses is a coding violation at load, never a
// route silently cut short in a fight.
for (const e of EDGE_TYPES) {
  if (!EDGE_DRIVE[e] && !COMBAT_REFUSED_EDGES[e]) throw new Error(`[driver] CODING VIOLATION: pathfinder edge '${e}' has no combat drive (EDGE_DRIVE) and no refusal`);
}
// A fight's prices: a dug block is dear, since it spends time under fire and opens the ground; a placed block is cheap.
const FIGHT_DIG_SCALE = 5;
const FIGHT_PLACE_SCALE = 0.4;
// The band goal: floor cells within this many cells of the mob's column, a level either side of its floor.
const BAND_GOAL_CELLS = 2;
// A route is searched again when the mob has moved this far from the cell it was searched toward, when the body is
// this far off its next cell, when it has run out, or when it is this old.
const REPLAN_DRIFT_B = 1.5;
const OFF_ROUTE_B = 1.5;
const ROUTE_MAX_AGE_MS = 2000;
// A route cell is reached inside this flat distance of its centre; a climb is jumped inside CLIMB_JUMP_B of it.
const ARRIVE_B = 0.4;
// THE FLANK: how far behind the brawler, on its far side from the shooter, the walk ends (inside the arm's 3 b, so the
// brawler is struck as the body arrives), how near that point counts as there, and the goal's cell reach.
const FLANK_BEHIND_B = 2.5;
const FLANK_ARRIVE_B = 1;
const FLANK_GOAL_REACH = 1.2;
const CLIMB_JUMP_B = 1.3;

// ── A BODY THAT STOPS GETTING THERE IS A NAVIGATION FAULT, NOT A MOB'S ───────────────────────────────
// With every move legal, every block can be dug and every gap filled, so a route always exists and no mob is out of reach. A body that has
// not moved GAIN_B for STUCK_MS while closing on its mob says so as a fault and raycasts to the mob: the first block on the ray is dug,
// and a clear ray is walked straight at it. It leaves a mob above it with no block in the pocket to pillar on (that body's turn on the
// mob ends and the next body takes it, combat_board THE TERMINATOR). A body that stays put climbs THE STUCK LADDER below, and stops the
// run (Law 13) only once it is spent.
const STUCK_MS = 3000;
// The navigator's failed-step price tiers (navigator STEP 5), the same constants in the same order (Law 16).
const PENALTY_LADDER = Object.freeze([COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET]);
const GAIN_B = 1;
const STUCK_RAY_B = 32;
const STUCK_DIG_REACH = 4.5;
const ABOVE_B = 1.5;

let route = null;   // { purpose: 'approach'|'flank', mobId, goalAt, path, idx, at, offRoute, longFrom }
let chase = null;   // { mobId, name, nearest, gainedAt, bodyAt, stuck, ray, gaveUp, close }
let longSearching = false;
let lastMode = null;     // the tick's last order mode, read by think()
let lastMobId = null;
// The flank's walk-to point while one is open (THE FLANK), read by think(); null otherwise.
let flankPoint = null;
// The last route search's own account, carried on the route row it produced: how long it thought, whether it ran out of
// thinking time, and how many goal cells it was given.
let lastSearch = null;
// The flank point last announced, so a `flank_point` row is written when it moves, not every tick.
let saidFlankPoint = null;
const FLANK_POINT_MOVE_B = 1;
let gather = null;   // { since, arcDeg } while backing out of a surround (THE GATHER)
let lastPlan = null; // THE FIELD AHEAD: the last step taken, so the next is held to it unless another is clearly cheaper
let saidPlan = null; // { key, at } of the last plan row written
let saidPress = null; // THE PRESS: the last press row's state and the mob circled from, for one row per change

// Only cells whose centre lies within BAND_GOAL_REACH of the mob across the ground: a body on one is inside the band
// even with the mob a level off, so a route that has run out never leaves the body short of it.
const BAND_GOAL_REACH = 2.2;
// Lines kept from the one traced re-search a fight's first route 'none' earns.
const ROUTE_NONE_TRACE_LINES = 40;
// A MOB UNDER WATER IS MET FROM THE SURFACE OVER IT. The search swims only at the surface (a swim node stands at its
// column's surface water, pathfinding_utils.findWaterSurface) and has no edge that dives, so a goal on a drowned's own
// floor deep under is one no route ends in. With `bot`, each of the band's columns that holds water at the mob's height
// also offers its surface cell: the body swims over the mob, and a drowned rises to it.
function bandGoal(mobPos, reach = BAND_GOAL_REACH, bot = null) {
  const mx = Math.floor(mobPos.x), my = Math.floor(mobPos.y) - 1, mz = Math.floor(mobPos.z);
  const positions = [];
  const { findWaterSurface } = require('@utils/pathfinding_utils');
  const isWater = (b) => !!b && (b.name === 'water' || b.name === 'bubble_column');
  for (let dx = -BAND_GOAL_CELLS; dx <= BAND_GOAL_CELLS; dx++) {
    for (let dz = -BAND_GOAL_CELLS; dz <= BAND_GOAL_CELLS; dz++) {
      if (Math.hypot(mx + dx + 0.5 - mobPos.x, mz + dz + 0.5 - mobPos.z) > reach) continue;
      for (let dy = -1; dy <= 1; dy++) positions.push(new Vec3(mx + dx, my + dy, mz + dz));
      if (bot && isWater(bot.blockAt(new Vec3(mx + dx, my + 1, mz + dz)))) {
        const surfY = findWaterSurface(bot, mx + dx, my + 1, mz + dz);
        if (surfY !== null && surfY > my + 1) positions.push(new Vec3(mx + dx, surfY, mz + dz));
      }
    }
  }
  return { type: 'multi', positions };
}

// searchRoute(bot, goal, opts) → { path, partial }, { path: [], atGoal: true } when the body already stands on a goal cell,
// or null when no cell can be walked toward it. `works`: the search may dig and place
// at a fight's prices. `from`: where the search starts, the body's floor when omitted. A path stops short of its first edge outside
// COMBAT_EDGES.
async function searchRoute(bot, goal, { works = false, from = null, deadlineMs = COMBAT_THINK_MS } = {}) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  const navigator = require('@locomotion/navigator');
  const t0 = Date.now();
  // The stuck ladder's priced moves (THE STUCK LADDER) ride every search of the chase that charged them.
  const movePenalties = chase && chase.penalties && chase.penalties.size ? chase.penalties : undefined;
  const res = await computeAStar(bot, from || self.floored().offset(0, -1, 0), goal, {
    sense: () => navigator.freshSearchState(bot, goal), deadlineMs, owner: 'combat', movePenalties,
    allowWorldAlteration: works, spareBuilds: true, digScale: FIGHT_DIG_SCALE, placeScale: FIGHT_PLACE_SCALE, combatGate: false, planningGate: false,
  });
  const ms = Date.now() - t0;
  lastSearch = { ms, timed_out: !!(res && res.timedOut), goal_cells: goal && goal.positions ? goal.positions.length : null };
  stats.routeSearches++;
  if (ms > stats.thinkMsMax) stats.thinkMsMax = ms;
  if (res && res.timedOut) stats.routeTimedOut++;
  const all = res && res.path ? res.path : [];
  // An empty complete path is the search's "already at the goal": the body stands in the band, not 'no route'.
  if (res && !res.partial && !all.length) return { path: [], partial: false, atGoal: true };
  const offEdge = all.findIndex((s) => !COMBAT_EDGES.has(s.edgeType));
  if (offEdge >= 0) stats.routeOffEdge++;
  const path = offEdge >= 0 ? all.slice(0, offEdge) : all;
  if (!path.length) {
    // The fight's first 'none' is searched once more with the search's own trace, so the record says why no cell came nearer.
    if (stats.routeNone === 0) {
      const lines = [];
      await computeAStar(bot, from || self.floored().offset(0, -1, 0), goal, {
        sense: () => navigator.freshSearchState(bot, goal), deadlineMs, owner: 'combat',
        allowWorldAlteration: works, spareBuilds: true, digScale: FIGHT_DIG_SCALE, placeScale: FIGHT_PLACE_SCALE, combatGate: false, planningGate: false,
        trace: (_lbl, msg) => { if (lines.length < ROUTE_NONE_TRACE_LINES) lines.push(msg.trim()); },
      });
      watcher.summary(TAG, `first route none this fight, offEdge=${offEdge}, ${all.length} cell(s) before the cut; goal ${goal.positions ? goal.positions.length : '?'} cell(s); search trace:\n  ${lines.join('\n  ')}`);
    }
    stats.routeNone++;
    return null;
  }
  const partial = !!res.partial || offEdge >= 0;
  if (partial) stats.routeHops++; else stats.routeFound++;
  return { path, partial };
}

// planPast(bot, mob, hop) — the long search, from the end of the hop being walked. Not awaited: the body walks while it thinks.
function planPast(bot, mob, hop) {
  if (longSearching) return;
  const end = hop.path[hop.path.length - 1].pos;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  hop.longFrom = key(end);
  longSearching = true;
  searchRoute(bot, bandGoal(mob.entity.position, BAND_GOAL_REACH, bot), { works: true, from: end, deadlineMs: LONG_THINK_MS }).then((long) => {
    longSearching = false;
    if (!engaged || !long || long.atGoal || route !== hop) return;
    const at = hop.path.findIndex((s) => key(s.pos) === hop.longFrom);
    if (at < hop.idx) return;
    const rest = long.path.filter((s) => key(s.pos) !== hop.longFrom);
    hop.path = hop.path.slice(0, at + 1).concat(rest);
    hop.longFrom = null;
    hop.at = Date.now();
    stats.routeJoined++;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'joined', cells: hop.path.length });
  }, (e) => {
    longSearching = false;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'long_threw', why: e && e.message });
  });
}

function routeStale(mob, purpose, now) {
  if (!route || route.purpose !== purpose || route.mobId !== mob.id) return true;
  if (route.offRoute || route.idx >= route.path.length) return true;
  // A hop whose long plan is still thinking is walked out: a new search now would throw that plan away.
  if (route.longFrom && longSearching) return false;
  if (now - route.at > ROUTE_MAX_AGE_MS) return true;
  const p = mob.entity.position;
  return Math.hypot(p.x - route.goalAt.x, p.y - route.goalAt.y, p.z - route.goalAt.z) > REPLAN_DRIFT_B;
}

// A swum cell is arrived IN, as the navigator's swim step arrives: within this flat distance of its centre and inside
// its column, whatever the height the water holds the body at.
const SWIM_ARRIVE_B = 0.8;
// A water exit's block is refused by the server into a cell the body overlaps, so the body is centred in its own water
// cell first, within this flat distance (the navigator's waterBankOutStep centres to the same).
const EXIT_CENTRE_B = 0.15;

// routeFrom(self) → the cell the route's next edge leaves from: the cell before it, or the body's floor at the start.
function routeFrom(self) {
  return route.idx > 0 ? route.path[route.idx - 1].pos : self.floored().offset(0, -1, 0);
}

function arrivedAt(self, n, drive) {
  const flat = Math.hypot(n.x + 0.5 - self.x, n.z + 0.5 - self.z);
  if (drive === 'swim') return flat <= SWIM_ARRIVE_B && Math.floor(self.x) === n.x && Math.floor(self.z) === n.z;
  return flat < ARRIVE_B && Math.abs(self.y - (n.y + 1)) < 0.75;
}

// waterExit(bot, self) → where a water exit next on the route stands, or null when the next edge is no exit:
//   centre  the body is off its water cell's centre (`at`); the block cannot be set yet
//   set     centred, the block is asked for at `fill` (edgeWant)
//   board   the block is set; the body swims onto it
//   up      the body stands on it: the bank's one step up, or one pillar for a step up
// The fill cell is read once per edge through the navigator's own waterExitFill (Law 16): once set it is no longer
// water, and a second read would find no exit.
function waterExit(bot, self) {
  const { pos: n, edgeType } = route.path[route.idx];
  if (EDGE_DRIVE[edgeType] !== 'exit') return null;
  if (!route.exit || route.exit.idx !== route.idx) {
    const from = routeFrom(self);
    const fill = require('@locomotion/navigator').waterExitFill(bot, edgeType, n, from);
    route.exit = { idx: route.idx, from: { x: from.x, z: from.z }, fill: fill ? { x: fill.x, y: fill.y, z: fill.z } : null };
  }
  const { fill, from } = route.exit;
  if (!fill) { route.offRoute = true; return null; }
  const b = bot.blockAt(new Vec3(fill.x, fill.y, fill.z));
  if (!b || b.boundingBox !== 'block') {
    return Math.hypot(from.x + 0.5 - self.x, from.z + 0.5 - self.z) > EXIT_CENTRE_B ? { phase: 'centre', fill, at: from } : { phase: 'set', fill };
  }
  const onFill = bot.entity.onGround && Math.floor(self.x) === fill.x && Math.floor(self.z) === fill.z && Math.floor(self.y + 0.01) === fill.y + 1;
  return { phase: onFill ? 'up' : 'board', fill };
}

// routeHeading(bot, self) → { x, z, climb, swim, rise } toward the route's next cell, or null when there is nothing to
// walk this tick: the route has run out, or the next edge is waiting on a block, a dig or a door the gunner is asked for.
// `swim`: jump is held while the head is under, and also, with `rise`, while the cell stands higher.
function routeHeading(bot, self) {
  if (!route) return null;
  const path = route.path;
  while (route.idx < path.length && arrivedAt(self, path[route.idx].pos, EDGE_DRIVE[path[route.idx].edgeType])) route.idx++;
  if (route.idx >= path.length) return null;
  const { pos: n, edgeType } = path[route.idx];
  const drive = EDGE_DRIVE[edgeType];
  let to = n, swim = drive === 'swim';
  if (drive === 'exit') {
    const ex = waterExit(bot, self);
    if (!ex || ex.phase === 'set') return null;
    if (ex.phase === 'centre') { to = { x: ex.at.x, z: ex.at.z }; swim = true; }   // held level: no height, so no rise
    else if (ex.phase === 'board') { to = ex.fill; swim = true; }
    else if (edgeType === 'water_step_up') return null;   // on the block: the pillar is asked (edgeWant)
  }
  const x = to.x + 0.5 - self.x, z = to.z + 0.5 - self.z;
  const flat = Math.hypot(x, z);
  // Off the route past the edge's own span: a door's edge reaches two cells, a bank exit up to two.
  const from = routeFrom(self);
  const span = Math.hypot(n.x - from.x, n.z - from.z);
  if (flat > Math.max(OFF_ROUTE_B, span + 0.5)) route.offRoute = true;
  // jump_out holds jump the whole crossing, as the navigator's jumpOutStep does: the rim stands over the auto-step.
  const climb = !swim && (edgeType === 'jump_out' || (n.y + 1 > self.y + 0.5 && flat < CLIMB_JUMP_B));
  return { x, z, climb, swim, rise: swim && to.y != null && to.y + 1 - self.y > 0.3 };
}

// ── THE EDGE: NO MOB IS WORTH A FALL ─────────────────────────────────────────────────────────────────────
// A route never falls (pathfinding_utils has no free-fall edge), but the fight also presses where no route was planned:
// the stuck body's walk down the ray at its mob, the knockback press at a mob in reach, a back-off step. Any press is
// probed ahead first, to EDGE_LOOK_B (EDGE_LOOK_SPRINT_B under sprint, which carries the body on): a cell whose floor
// lies more than SAFE_DROP below the feet, over lava or fire, or not loaded, is an edge, and the press stops at it. A
// wall ahead is no edge. A miner whose tunnel broke into a ravine stands at the lip and lets the archer across be the
// next body's mob (combat_board THE TERMINATOR); it does not walk off after it.
const SAFE_DROP = 3;              // blocks a body falls with no damage
const EDGE_LOOK_B = 1.2;
const EDGE_LOOK_SPRINT_B = 2.0;
const EDGE_PROBE_B = 0.4;
const EDGE_DEADLY = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'powder_snow']);
// edgeAhead(bot, self, heading, lookB) → { x, z, depth } for the first edge on the heading within lookB, or null.
function edgeAhead(bot, self, heading, lookB) {
  const len = Math.hypot(heading.x, heading.z);
  if (len < 1e-6) return null;
  const hx = heading.x / len, hz = heading.z / len;
  const fy = Math.floor(self.y + 0.01);
  const sx = Math.floor(self.x), sz = Math.floor(self.z);
  const ownMargin = besideLava(bot, sx, fy - 1, sz);
  for (let s = EDGE_PROBE_B; s <= lookB + 1e-6; s += EDGE_PROBE_B) {
    const x = Math.floor(self.x + hx * s), z = Math.floor(self.z + hz * s);
    if (x === sx && z === sz) continue;
    const feet = bot.blockAt(new Vec3(x, fy, z));
    if (!feet) return { x, z, depth: null };
    if (feet.boundingBox === 'block') return null;
    // Lava or fire level with the feet (a flow, a lake whose surface stands as high as the body) is an edge too.
    if (EDGE_DEADLY.has(feet.name)) return { x, z, depth: 0, deadly: feet.name };
    // THE LAVA MARGIN: a cell with lava in any of the eight cells round it, level with its floor, its feet or its head, is an
    // edge too, so a press keeps a block clear of a pool as a route does (pathfinding_utils.besideLava). A body already
    // standing beside lava is not held by it: every step would be barred and it could not leave.
    if (!ownMargin && besideLava(bot, x, fy - 1, z)) return { x, z, depth: 0, deadly: 'lava_margin' };
    let depth = 0;
    for (;;) {
      const b = bot.blockAt(new Vec3(x, fy - 1 - depth, z));
      if (!b) return { x, z, depth: null };
      if (EDGE_DEADLY.has(b.name)) return { x, z, depth, deadly: b.name };
      if (b.boundingBox === 'block' || b.name === 'water') break;
      depth++;
      if (depth > SAFE_DROP) return { x, z, depth };
    }
  }
  return null;
}

// ── OUT OF THE FIRE ────────────────────────────────────────────────────────────────────────────────────────
// A body whose feet touch fire walks to the nearest standing cell with no fire in it or beside it, through fire if it
// must: THE EDGE stops every press at a fire cell, and a body ringed by burning ground stood in it for 10 s and died of
// it with three mobs left (arena). The walk out outranks the fight's own walk and is not probed for an edge.
const FIRE_BLOCKS = new Set(['fire', 'soul_fire']);
const FIRE_OUT_B = 4;
function fireExit(bot, self) {
  const fy = Math.floor(self.y + 0.01);
  const fireAt = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z)); return !!b && FIRE_BLOCKS.has(b.name); };
  let touching = false;
  for (const ox of [-0.3, 0.3]) for (const oz of [-0.3, 0.3]) if (fireAt(Math.floor(self.x + ox), Math.floor(self.z + oz))) touching = true;
  if (!touching) return null;
  const sx = Math.floor(self.x), sz = Math.floor(self.z);
  let best = null;
  for (let dx = -FIRE_OUT_B; dx <= FIRE_OUT_B; dx++) for (let dz = -FIRE_OUT_B; dz <= FIRE_OUT_B; dz++) {
    const x = sx + dx, z = sz + dz;
    if (fireAt(x, z) || standsAt(bot, new Vec3(x, fy, z)) === null) continue;
    let beside = 0;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (fireAt(x + ax, z + az)) beside++;
    const d = Math.hypot(x + 0.5 - self.x, z + 0.5 - self.z);
    const cost = d + beside * 2;
    if (!best || cost < best.cost) best = { cost, x: x + 0.5 - self.x, z: z + 0.5 - self.z };
  }
  return best;
}

function carriesBlock(bot) {
  const items = bot.inventory.items();
  return BRIDGE_PREFS.some((name) => items.some((i) => i.name === name && i.count > 0));
}

// edgeWant(bot, self) → the dig or block the route's next edge needs before the body can take it, or null. Digs come first, nearest
// the body first; a pillar then rises, a bridge then lays its floor.
function edgeWant(bot, self) {
  if (!route || route.idx >= route.path.length) return null;
  const { pos: n, edgeType } = route.path[route.idx];
  const feet = self.floored();
  const solid = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return !!b && b.boundingBox === 'block';
  };
  // THE LEAF REFLEX, AS WALKING HAS IT: the search reads a loose leaf as air (pathfinding_utils.isBlockPassable), so a
  // route runs through the canopy on a plain edge; the cells the body will stand in at the next cell, and over its head
  // where the edge rises, are cut first (the navigator's clearStance and punch, the same cells). leaf_authority.isPhantom
  // keeps a blueprint's leaf out.
  const { isPhantomAt, stepCells } = require('@utils/movement/leaf_authority');
  const leafCells = stepCells(feet, new Vec3(n.x, n.y + 1, n.z)).map(c => [c.x, c.y, c.z]);
  if (n.y + 1 > feet.y) leafCells.push([feet.x, feet.y + 2, feet.z], [feet.x, feet.y + 3, feet.z]);
  for (const [x, y, z] of leafCells) {
    if (isPhantomAt(bot, x, y, z)) return { kind: 'dig', at: { x, y, z }, why: 'route_leaf', refused: false };
  }
  // A WATER EXIT: the block beside the body first, then (on it) the step up's pillar.
  if (EDGE_DRIVE[edgeType] === 'exit') {
    const ex = waterExit(bot, self);
    if (!ex) return null;
    if (ex.phase === 'set') return { kind: 'bridge', at: ex.fill, why: `route_${edgeType}`, refused: false };
    if (ex.phase === 'up' && edgeType === 'water_step_up') return { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'route_water_step_up', refused: false };
    return null;
  }
  // A DOOR: the edge reaches two cells, the door midway (pathfinding_utils mints it so the body never stops inside it).
  // A shut one is opened by the gunner, which owns the facing; the navigator's door reflex looks at it, and in a fight
  // that look is not the reflex's to take.
  if (edgeType === 'door') {
    const from = routeFrom(self);
    const at = { x: (from.x + n.x) / 2, y: from.y + 1, z: (from.z + n.z) / 2 };
    const door = bot.blockAt(new Vec3(at.x, at.y, at.z));
    if (isDoorBlock(door) && !require('@locomotion/survival_instincts').isDoorOpen(door)) return { kind: 'open', at, why: 'route_door', refused: false };
    return null;
  }
  let cells = [];
  // The three cells an ascent needs open, as the navigator's stairUpStep clears them: the origin's ceiling, the tread's
  // headroom, the landing's headroom.
  if (edgeType === 'dig_stair_up') cells = [[feet.x, feet.y + 2, feet.z], [n.x, n.y + 1, n.z], [n.x, n.y + 2, n.z]];
  else if (edgeType === 'dig_through') cells = [[n.x, n.y + 1, n.z], [n.x, n.y + 2, n.z]];
  else if (edgeType === 'dig_stair_down') for (let y = feet.y + 1; y > n.y; y--) cells.push([n.x, y, n.z]);
  else if (edgeType === 'dig_down') cells = [[feet.x, feet.y - 1, feet.z]];
  else if (edgeType === 'pillar') cells = [[feet.x, feet.y + 2, feet.z], [feet.x, feet.y + 3, feet.z]];
  for (const [x, y, z] of cells) {
    if (!solid(x, y, z)) continue;
    const at = { x, y, z };
    if (isProtected(bot, at)) { route.offRoute = true; return null; }
    return { kind: 'dig', at, why: `route_${edgeType}`, refused: false };
  }
  if (edgeType === 'pillar') return { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'route_pillar', refused: false };
  if (edgeType === 'bridge' && !solid(n.x, n.y, n.z)) return { kind: 'bridge', at: { x: n.x, y: n.y, z: n.z }, why: 'route_bridge', refused: false };
  return null;
}

// The route edge's last terrain ask ({ kind, at }), set by terrainWant; noteGain reads whether it landed.
let edgeAsked = null;
function edgeLanded(bot, ask) {
  const b = bot.blockAt(new Vec3(ask.at.x, ask.at.y, ask.at.z));
  const solid = !!b && b.boundingBox === 'block';
  return ask.kind === 'dig' ? !solid : solid;
}

// noteGain(bot, mob, now) — reads whether this approach is getting there, and raycasts when it is not.
function noteGain(bot, mob, now) {
  const self = bot.entity.position;
  const d = mob.entity.position.distanceTo(self);
  if (!chase || chase.mobId !== mob.id) {
    chase = { mobId: mob.id, name: mob.name, nearest: d, gainedAt: now, bodyAt: self.clone(), stuck: false, ray: null, gaveUp: false, close: false,
      rungs: 0, penalties: new Map(), penaltyRung: new Map(), tried: [] };
  }
  // A mob at the band is being fought, not chased: the dead-wait clock answers for that fight.
  chase.close = d <= BAND_OUTER + GAIN_B;
  // GAIN IS THE BODY'S OWN: a mob coming in is not this body getting there, so a pinned body's clock runs while a mob
  // swims or walks toward it.
  const moved = chase.bodyAt.distanceTo(self) >= GAIN_B;
  // A BLOCK THE ROUTE ASKED FOR IS PROGRESS, as a finished step is the navigator's: a bridge laid, a pillar set, a dig
  // opened. A chain of bridges down a cliff holds the body still while each lands; that is the route being built, not
  // a body pinned. Bounded by the blocks carried and the cells there are to dig.
  const built = !!edgeAsked && edgeLanded(bot, edgeAsked);
  if (built) edgeAsked = null;
  if (chase.close || moved || built) {
    chase.nearest = Math.min(d, chase.nearest);
    chase.gainedAt = now;
    chase.bodyAt = self.clone();
    chase.stuck = false;
    chase.ray = null;
    chase.rungs = 0;
    return;
  }
  if (now - chase.gainedAt < STUCK_MS) return;
  const hit = eyeLineHit(bot, eyePos(bot.entity), eyePos(mob.entity), STUCK_RAY_B);
  chase.ray = hit && hit.position ? { x: hit.position.x, y: hit.position.y, z: hit.position.z, name: hit.name } : null;
  if (!chase.stuck) {
    chase.stuck = true;
    stats.stuck++;
    crewLog.event(TAG, 'stuck', { subject: `${mob.name}#${mob.id}`, d: d.toFixed(2), route: route ? route.path.length - route.idx : 0, ray: chase.ray ? `${chase.ray.name}@${chase.ray.x},${chase.ray.y},${chase.ray.z}` : 'clear', blocks: carriesBlock(bot) });
  }
  if (!chase.gaveUp && mob.entity.position.y - self.y > ABOVE_B && !carriesBlock(bot)) {
    chase.gaveUp = true;
    chase.gaveUpWhy = 'no_pillar_material';
    stats.gaveUp++;
    crewLog.event(TAG, 'gave_up', { subject: `${mob.name}#${mob.id}`, d: d.toFixed(2), why: chase.gaveUpWhy });
  } else if (!chase.gaveUp) {
    escalate(bot, mob, self, d, now);
  }
}

// ── THE STUCK LADDER: EVERYTHING NAVIGATION KNOWS, THEN THE STOP ─────────────────────────────────────
// Each STUCK_MS the body has not moved is one rung, the navigator's own failed-step answer (navigator STEP 5): the route's
// next move is priced up one tier of PENALTY_LADDER (keyed cell|edge, so only that way in is charged; the other ways stay
// open) and the route is searched again around it, while the raycast dig (stuckWant) opens the first block on the line
// to the mob. Once every tier has been charged on the move the body is pinned at and a further STUCK_MS passes with no
// movement, navigation has tried everything it knows: a coding violation (Law 13), so the run stops and the failure is
// inspected. What was tried goes in the record and the throw.
function escalate(bot, mob, self, d, now) {
  const rung = Math.floor((now - chase.gainedAt) / STUCK_MS);
  if (rung <= chase.rungs) return;
  chase.rungs = rung;
  const next = route && route.idx < route.path.length ? route.path[route.idx] : null;
  const edge = next ? `${next.edgeType}@${next.pos.x},${next.pos.y},${next.pos.z}` : 'none';
  if (rung <= PENALTY_LADDER.length) {
    if (next) {
      const key = `${next.key || keyOf(next.pos)}|${next.edgeType}`;
      const tier = chase.penaltyRung.get(key) || 0;
      chase.penaltyRung.set(key, tier + 1);
      chase.penalties.set(key, PENALTY_LADDER[Math.min(tier, PENALTY_LADDER.length - 1)]);
      chase.tried.push(`priced ${edge} at ${chase.penalties.get(key)}`);
    } else {
      chase.tried.push('no route move to price');
    }
    if (chase.ray) chase.tried.push(`ray dig ${chase.ray.name}@${chase.ray.x},${chase.ray.y},${chase.ray.z}`);
    if (route) route.offRoute = true;   // the next think() searches again, around the priced move
    crewLog.event(TAG, 'stuck_rung', { subject: `${mob.name}#${mob.id}`, rung, of: PENALTY_LADDER.length, edge,
      ray: chase.ray ? `${chase.ray.name}@${chase.ray.x},${chase.ray.y},${chase.ray.z}` : 'clear', still_ms: now - chase.gainedAt });
    return;
  }
  const fields = { subject: `${mob.name}#${mob.id}`, d: d.toFixed(2), at: `${Math.floor(self.x)},${Math.floor(self.y)},${Math.floor(self.z)}`,
    mob_at: `${Math.floor(mob.entity.position.x)},${Math.floor(mob.entity.position.y)},${Math.floor(mob.entity.position.z)}`,
    edge, route: route ? route.path.length - route.idx : 0,
    ray: chase.ray ? `${chase.ray.name}@${chase.ray.x},${chase.ray.y},${chase.ray.z}` : 'clear', still_ms: now - chase.gainedAt,
    tried: chase.tried.join('; ') };
  crewLog.event(TAG, 'stuck_fault', fields);
  throw new Error(`[${TAG}] CODING VIOLATION (Law 13): navigation failure: every rung tried and the body has not moved ${GAIN_B} b in `
    + `${fields.still_ms} ms closing on ${fields.subject} ${fields.d} b away. Body ${fields.at}, mob ${fields.mob_at}, next edge ${fields.edge}, `
    + `${fields.route} route cell(s) left, ray to the mob ${fields.ray}. Tried: ${fields.tried}.`);
}

// stuckWant(bot, self) → the dig of the first block on a stuck body's ray to its mob, once in reach; or null.
function stuckWant(bot, self) {
  if (!chase || !chase.stuck || !chase.ray) return null;
  const at = { x: chase.ray.x, y: chase.ray.y, z: chase.ray.z };
  if (Math.hypot(at.x + 0.5 - self.x, at.y + 0.5 - self.y, at.z + 0.5 - self.z) > STUCK_DIG_REACH || isProtected(bot, at)) return null;
  return { kind: 'dig', at, why: 'stuck_ray', refused: false };
}

// think(bot) — the route decision, awaited once per battle_stations pass. Runs at most one search; the tick keeps
// walking the last route while it does.
async function think(bot) {
  if (!engaged || !stats) return;
  const self = bot.entity && bot.entity.position;
  if (!self) return;
  const board = crewBoard.readCommander();
  const mob = (board.active || []).find((h) => h.id === lastMobId) || null;
  if (!mob || !mob.entity || !mob.entity.position) return;
  const now = Date.now();

  // An approach and a flank are walks to a place, both on the stuck clock: a body that stops getting there climbs the
  // stuck ladder to its Law 13 stop either way. A body backing off or running is on no clock.
  if (lastMode === 'approach' || lastMode === 'flank') noteGain(bot, mob, now);
  else if (chase) { chase.gainedAt = now; chase.stuck = false; chase.ray = null; }
  if (lastMode === 'flank' && flankPoint) {
    if (!routeStale(mob, 'flank', now)) return;
    const goalAt = mob.entity.position.clone();
    // Held for the row: the tick may clear flankPoint while the search thinks.
    const point = flankPoint.clone();
    // The goal carries the water-surface cell over each column (bandGoal with the body), as the approach's does: a
    // line-up point over open water is swum to, never searched for mid-water until the thinking time runs out.
    const found = await searchRoute(bot, bandGoal(point, FLANK_GOAL_REACH, bot));
    if (!engaged) return;
    if (found && found.atGoal) { route = null; return; }
    // A partial search is walked as a hop, as the approach walks one, and searched again from where it ends: the
    // flank keeps moving toward its point while the search catches up, never standing on a refused partial.
    const path = found && found.path.length ? found.path : null;
    route = path ? { purpose: 'flank', mobId: mob.id, goalAt, path, idx: 0, at: Date.now(), offRoute: false } : null;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: !path ? 'none' : found.partial ? 'hop' : 'found', purpose: 'flank', cells: path ? path.length : 0,
      to: `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10},${Math.round(point.z * 10) / 10}`, ...(lastSearch || {}) });
    return;
  }
  if (lastMode !== 'approach' || !routeStale(mob, 'approach', now)) return;
  const found = await searchRoute(bot, bandGoal(mob.entity.position, BAND_GOAL_REACH, bot), { works: true });
  if (!engaged) return;
  if (found && found.atGoal) {
    if (route) crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'at_goal' });
    route = null;
    return;
  }
  if (found) {
    if (!route || route.mobId !== mob.id) crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: found.partial ? 'hop' : 'found', cells: found.path.length, ...(lastSearch || {}) });
    route = { purpose: 'approach', mobId: mob.id, goalAt: mob.entity.position.clone(), path: found.path, idx: 0, at: Date.now(), offRoute: false, longFrom: null };
    if (found.partial) planPast(bot, mob, route);
    return;
  }
  route = null;
  crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'none', ...(lastSearch || {}) });
}

// chaseVerdict() → { mobId, state, why } for the mob this fight is closing on, or null. 'chasing' is the fight still open; 'gave_up' ends it.
function chaseVerdict() {
  return chase ? { mobId: chase.mobId, state: chase.gaveUp ? 'gave_up' : chase.close ? 'close' : 'chasing', why: chase.gaveUp ? chase.gaveUpWhy : null } : null;
}

// endChase(id) — battle_stations retired the mob; the chase and its route go with it.
function endChase(id) {
  if (chase && chase.mobId === id) chase = null;
  if (route && route.mobId === id) route = null;
}

// This seat never writes yaw (Invariant D), so a dig/place need is asked of the gunner (serveTerrain) as
// a want, republished each tick it holds and null the instant it doesn't (silence is withdrawal,
// Invariant B). Per-tick, not a route: vertical_gap above/below asks place/dig; a stalled press asks dig
// only after a second stall-jump confirms a wall, not a kerb.
const STALL_JUMPS_BEFORE_DIG = 2;

// A want re-derived from a moving heading names a different cell every tick and never lets a dig
// finish, so the cell is latched when first asked for and re-published unchanged while its own reason
// holds (a mode change or the cell going to air clears it).
let wantLatch = null;

function latchHolds(bot, order, dy) {
  const L = wantLatch;
  if (!L) return false;
  if (L.kind === 'place') return order.mode === 'vertical_gap' && dy > 0;
  const b = bot.blockAt(new Vec3(L.at.x, L.at.y, L.at.z));
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false;
  return L.why === 'target_below'
    ? (order.mode === 'vertical_gap' && dy < 0)
    : stallJumps >= STALL_JUMPS_BEFORE_DIG;
}

// navigator.loadProtectedBlocks is the one inspection point for what the bot refuses to dig (Law 16);
// the gate belongs on the ask, not the gunner's serve. Required lazily to avoid a require cycle with
// battle_stations and to skip building the Set on ticks with no want.
function isProtected(bot, cell) {
  const { loadProtectedBlocks } = require('@locomotion/navigator');
  const set = loadProtectedBlocks(bot);
  return !!set && set.has(`${cell.x},${cell.y},${cell.z}`);
}

function terrainWant(bot, self, order, dy, heading, mob) {
  // The route's own edge outranks every other ask.
  const edge = order.mode === 'approach' || order.mode === 'flank' ? edgeWant(bot, self) : null;
  if (edge) {
    wantLatch = null;
    stallJumps = 0;
    if (edge.kind === 'bridge' || edge.kind === 'place' || edge.kind === 'dig') edgeAsked = { kind: edge.kind, at: edge.at };
    return edge;
  }
  const ray = order.mode === 'approach' && chase && chase.mobId === mob.id ? stuckWant(bot, self) : null;
  if (ray) {
    wantLatch = null;
    return ray;
  }
  // A refusal is latched too and re-validated by the same test, so it expires only when a fresh answer
  // could differ.
  if (latchHolds(bot, order, dy)) return wantLatch.refused ? null : wantLatch;
  wantLatch = null;
  const feet = self.floored();
  if (order.mode === 'vertical_gap') {
    if (dy > 0) {
      wantLatch = { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'target_above', refused: false };
      return wantLatch.refused ? null : wantLatch;
    }
    const floor = { x: feet.x, y: feet.y - 1, z: feet.z };
    // NO DIG DOWN TOWARD A MOB IN WATER: a body afloat has water for a floor, and a body on a bridge or a bank over water
    // would dig its own footing into it. The refusal is latched like any other, so it is not re-asked every tick; a
    // drowned below comes up to the body, which fights it where it rises.
    const wet = (p) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return !!b && (b.name === 'water' || b.name === 'bubble_column'); };
    const overWater = !!bot.entity.isInWater || wet(floor) || wet({ x: floor.x, y: floor.y - 1, z: floor.z });
    wantLatch = { kind: 'dig', at: floor, why: 'target_below', refused: overWater || isProtected(bot, floor) };
    return wantLatch.refused ? null : wantLatch;
  }
  if (stallJumps < STALL_JUMPS_BEFORE_DIG || !heading) return null;
  // Only closing on a mob may dig: a body backing off, running or walking a gather never digs or places its way out;
  // a stalled step there is a blocked retreat, and the body stands its ground.
  if (order.mode !== 'approach') return null;
  // A body walking a route that stalls is searched a new route from where it stands, as the navigator would; it
  // never digs a way the route did not ask for (SECTION 4c).
  if (order.mode === 'approach' && route && route.mobId === mob.id) {
    route.offRoute = true;
    stallJumps = 0;
    return null;
  }
  // Feet level first, then head, so the ask targets what's actually blocking; air at both asks nothing
  // (Law 25).
  const len = Math.hypot(heading.x, heading.z) || 1;
  const ahead = feet.offset(Math.round(heading.x / len), 0, Math.round(heading.z / len));
  for (const cell of [ahead, ahead.offset(0, 1, 0)]) {
    const b = bot.blockAt(cell);
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      // A protected cell is no ask at all — the next cell of a protected wall is protected too.
      wantLatch = { kind: 'dig', at: { x: cell.x, y: cell.y, z: cell.z }, why: 'stalled_against_it',
        refused: isProtected(bot, cell) };
      return wantLatch.refused ? null : wantLatch;
    }
  }
  return null;
}

// ── SECTION 5: The tick ────────────────────────────────────────────────────

// creeperOrder(bot, entity, dy, crowded) → the band order against a creeper that has not lit, or null to leave the
// ordinary band (unreadable, or a rise the flat band cannot answer). A line holds for a lead that walks in; a still
// creeper is not walking in, so it is closed on, line or not, unless another brawler would then stand too near
// (`crowded`, THE LINE's own test). `recharging`: the weapon is more than KITE_LEAD_MS from charged.
function creeperOrder(bot, entity, dy, crowded, recharging) {
  const flat = predictionEngine.stopGap(bot, entity, CREEPER_LEAD_MS);
  if (flat === null || Math.abs(dy) >= CREEPER_INNER) return null;
  const gap = Math.hypot(flat, dy);
  const outer = Math.sqrt(CREEPER_OUTER * CREEPER_OUTER - dy * dy);
  const hold = { mode: 'hold', setpoint: null, error: 0 };
  const still = predictionEngine.stillMs(entity) >= CREEPER_STILL_MS;
  const approach = crowded || !still ? hold : { mode: 'approach', setpoint: outer, error: outer - flat };
  if (CREEPER_FOOTWORK === 'move') {
    const inner = recharging ? CREEPER_OUTER : CREEPER_INNER;
    if (gap < inner) return { mode: 'retreat', setpoint: inner, error: inner - gap };
  }
  return flat > outer ? approach : hold;
}

// meleeOf(h) → a mob met with the hit-and-back: a BRAWLER that walks in to strike, a creeper included, never one of the
// skeleton family.
function meleeOf(h) {
  return !(h.name in MOB_AGGRO_RANGE) && combatUtils.combatTactic(h.name, h.entity) === 'BRAWLER';
}

// The mob this seat controls on, which can differ from the gunner's target (a swelling creeper takes
// over). A body with a shield in its off-hand tanks the blast behind it (gunner's swell guard), so for it a swelling
// creeper is held in the band like any other mob, never backed off from.
const witchChase = (board) => !!board.focus && combatUtils.healsItself(board.focus.name);
function controlMob(board, shielded) {
  // An open flank is walked around its brawler, the focus, to line its shooter up behind it.
  if (board.flank && board.focus && board.focus.id === board.flank.meleeId) {
    const shooter = (board.active || []).find((h) => h.id === board.flank.shooterId) || null;
    return { mob: board.focus, swelling: false, shooter };
  }
  // A SHIELD IS THE ANSWER TO A SWELL, in a witch chase too: the guard turns to the creeper (gunner guardBearing) and the
  // arm holds every blow, the witch's included, until the fuse is gone, while the feet keep on her. Only a body with no
  // shield backs off, and one carrying a block stands behind its blast wall instead (wall_hold).
  const swelling = shielded ? [] : (board.swelling || []);
  if (swelling.length) {
    // active is already nearest-first (commander sorts once).
    const creeper = (board.active || []).find((h) => swelling.includes(h.id));
    if (creeper) return { mob: creeper, swelling: true };
  }
  // THE WITCH CHASE: a witch the commander has made the focus (A WITCH ABOVE EVERYTHING) is the feet's mob, past every
  // nearer one: no band is held against a brawler standing between, and the body walks by it to her.
  if (witchChase(board)) return { mob: board.focus, swelling: false };
  // Band held against the nearest mob, independent of the gunner's target; swell still outranks it
  // (Law 17).
  const nearestAny = (board.active || [])[0] || null;
  if (nearestAny && nearestAny.distance < BAND_INNER) {
    return { mob: nearestAny, swelling: false };
  }

  // `focus` answers the arm's question and is null while drawing; feet fall back to `closest`.
  const stand = board.focus || board.closest;
  return stand ? { mob: stand, swelling: false } : { mob: null, swelling: false };
}

// One trace line when the feet's answer changes; a control-mob switch counts as a change too.
function announceMode(mode, distance, setpoint, mob, horizontal, dy) {
  const on = mob ? mob.id : null;
  if (mode === saidMode && on === saidOn) return;
  saidMode = mode;
  saidOn = on;
  crewLog.event(TAG, 'mode', {
    subject: mob ? crewLog.subject(mob.entity) : null,
    to: mode,
    d: distance === null || distance === undefined ? null : distance.toFixed(2),
    // Rides with the mode: `approach` reads differently flat vs vertical.
    across: Number.isFinite(horizontal) ? horizontal.toFixed(2) : null,
    up: Number.isFinite(dy) ? dy.toFixed(2) : null,
    setpoint: setpoint === null || setpoint === undefined ? null : setpoint,
  });
}

// Unguarded: setControlState only asserts on our own bad literal, never mid-tick state.
function release(bot) {
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false);
  if (sprintArmed) { bot.setControlState('sprint', false); sprintArmed = false; }
  if (jumpTicks > 0) { bot.setControlState('jump', false); jumpTicks = 0; }
  // Lives here, not the tick's latch, since this is where the key actually drops.
  if (saidSprint) {
    saidSprint = false;
    crewLog.event(TAG, 'sprint', { state: 'off', why: 'released' });
  }
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  // lastPos does not carry across an engagement boundary.
  lastPos = null;
}

function onPhysicsTick(bot) {
  if (!engaged) return;
  // The water survival owner holds the controls until the interrupted engagement ends.
  if (require('@locomotion/underwater_swimming').survivalHasControl(bot)) return;
  stats.ticks++;

  const self = bot.entity && bot.entity.position;
  if (!self) return;                                        // dead or mid-respawn: nothing to drive

  const board = crewBoard.readCommander();
  // Only a shield in the off-hand holds the band against a swell. A body without one backs off, unless the gunner's
  // blast wall is placing or set for it (wall_hold below outranks the back-off): a carried block with no wall cell
  // stops nothing.
  const control = controlMob(board, combatUtils.holdsShield(bot));
  const { swelling, shooter } = control;
  // THE LINE: the brawlers within LINE_RANGE_B, nearest first (commander sorts once). With two
  // or more, and no swell or flank of its own, the band is held against the nearest of them, whatever the arm's target.
  const brawlers = (board.active || []).filter((h) => h.entity && h.entity.position && h.distance <= LINE_RANGE_B
    && meleeOf(h));
  const line = brawlers.length >= 2 && !swelling && !shooter && !witchChase(board);
  const mob = line ? brawlers[0] : control.mob;
  const survival = crewBoard.readSurvival();

  if (!mob) {
    stats.noTarget++;
    release(bot);
    // OUT OF THE FIRE with no mob left too: a body that cleared its field stood eating on burning ground and died of it.
    const out = bot.entity && bot.entity.position ? fireExit(bot, bot.entity.position) : null;
    if (out) {
      const keys = headingKeys(out, bot.entity.yaw);
      for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, keys[k]);
      stats.fireOutTicks++;
    }
    if (!!out !== saidFire) { saidFire = !!out; crewLog.event(TAG, 'fire', { state: out ? 'leaving' : 'out', field: 'clear' }); }
    writeBoard({ mode: 'no_target', setpoint: null, error: null, keys: null, sprint: false, sprinting: false, targetId: null, terrainRequest: null, at: Date.now() });
    return;                                                 // release() above dropped both carried samples
  }

  // Read fresh, not the board's cached distance: this seat corrects sub-block (Invariant B).
  const mobPos = mob.entity && mob.entity.position;
  if (!mobPos) { release(bot); return; }                    // body left the table between sweep and now
  const distance = Math.hypot(self.x - mobPos.x, self.y - mobPos.y, self.z - mobPos.z);
  // horizontal is what the feet can change; dy is why they sometimes cannot.
  const horizontal = Math.hypot(self.x - mobPos.x, self.z - mobPos.z);
  const dy = mobPos.y - self.y;

  // Read-back before this tick writes (Law 23); peak speed distinguishes a real sprint from dilution.
  if (sprintArmed) {
    stats.sprintAskedLastTick++;
    // A plain property read on mineflayer's own state object — optional chaining is the whole guard.
    if (bot.controlState?.sprint === true) stats.sprintHeld++;
  }

  const now = Date.now();
  const friend = crewBoard.readGunner().sweepFriend;
  if (!recenter && friend) {
    recenter = { setpoint: horizontal + RECENTER_BLOCKS, at: now, friend: friend.name };
    stats.recenters++;
    crewLog.event(TAG, 'recenter', { subject: crewLog.subject(mob.entity), friend: friend.name, from: horizontal.toFixed(2), setpoint: recenter.setpoint.toFixed(2) });
  }
  // A melee mob is held at MELEE_BAND_INNER, outside its own reach, so the knockback swing lands before its blow can.
  const meleeMob = meleeOf(mob);
  // THE HIT-AND-BACK: a melee mob, and the weapon still recharging.
  const readyInMs = crewBoard.readGunner().readyInMs;
  const recharging = Number.isFinite(readyInMs) && readyInMs > KITE_LEAD_MS;
  const crowded = line && brawlers.some((h) => h.id !== mob.id
    && h.distance - Math.max(0, h.closing || 0) * (LINE_LOOK_MS / 1000) < LINE_SAFE_B);
  if (line) stats.lineTicks++;
  if (crowded) stats.crowdedTicks++;
  const kite = meleeMob && (recharging || crowded);
  if (kite) stats.kiteTicks++;
  let order = bandOrder({ horizontal, dy, distance, swelling, standoff: recenter ? recenter.setpoint : standoff,
    inner: kite ? KITE_INNER : line ? LINE_INNER : meleeMob ? MELEE_BAND_INNER : BAND_INNER,
    outer: kite ? KITE_OUTER : line ? LINE_OUTER : BAND_OUTER });
  // A LINE IS NEVER WALKED INTO: the brawlers come to the body, so a lead out past the band is waited for where the body
  // stands; closing on it would walk the body toward the rest of them.
  if (line && order.mode === 'approach') order = { mode: 'hold', setpoint: null, error: 0 };
  // A CREEPER BEFORE ITS FUSE (SECTION 1) takes the band from whatever else set it, line or kite. Lit is read off the
  // board's own swell list, not `swelling`: a shielded body's control mob never reads swelling, and a lit creeper is met
  // by the swell's defence (the guard, the wall, the back-off) exactly as before, never by this band or the blob.
  const lit = new Set(board.swelling || []);
  if (mob.name === 'creeper' && !lit.has(mob.id)) {
    const fw = creeperOrder(bot, mob.entity, dy, crowded, recharging);
    if (fw) { order = fw; stats.creeperTicks++; }
  }
  // ── THE FLANK ──────────────────────────────────────────────────────────────
  // Walk to FLANK_BEHIND_B behind the brawler (the control mob) on its far side from the shooter. From there the
  // shooter stands behind the brawler, so both come from the front, where the shield faces, while the arm strikes the
  // brawler; the commander closes the flank once they share a side, and the band takes over. Arrived early, the band
  // holds against the brawler meanwhile.
  flankPoint = null;
  if (shooter && shooter.entity && shooter.entity.position) {
    const sp = shooter.entity.position;
    const ux = mobPos.x - sp.x, uz = mobPos.z - sp.z;
    const len = Math.hypot(ux, uz);
    if (len > 0) {
      const point = new Vec3(mobPos.x + ux / len * FLANK_BEHIND_B, mobPos.y, mobPos.z + uz / len * FLANK_BEHIND_B);
      if (Math.hypot(point.x - self.x, point.z - self.z) > FLANK_ARRIVE_B) {
        flankPoint = point;
        order = { mode: 'flank', setpoint: null, error: 0 };
        if (!saidFlankPoint || saidFlankPoint.distanceTo(point) > FLANK_POINT_MOVE_B) {
          saidFlankPoint = point.clone();
          const r1 = (n) => Math.round(n * 10) / 10;
          crewLog.event(TAG, 'flank_point', { subject: `${mob.name}#${mob.id}`, at: `${r1(point.x)},${r1(point.y)},${r1(point.z)}`,
            shooter: `${shooter.name}#${shooter.id}`, shooter_at: `${r1(sp.x)},${r1(sp.y)},${r1(sp.z)}`,
            to_point: r1(Math.hypot(point.x - self.x, point.z - self.z)) });
        }
        stats.flankTicks++;
      }
    }
  }
  // ── THE GATHER ─────────────────────────────────────────────────────────────
  // A swelling creeper or an open flank keeps its own walk. A witch chase walks past the blob: a step back from the
  // brawlers is a step away from her, and she throws for as long as she is out of reach (the arm still strikes
  // whatever brawler walks into reach on the way).
  let blob = false;
  if (order.mode !== 'flank' && !swelling && !witchChase(board)) {
    // The blob's brawlers: repeat strikers near, closest first (board.active is sorted by distance).
    const reach = gather ? GATHER_HOLD_RANGE_B : GATHER_RANGE_B;
    const brawlers = (board.active || []).filter((h) => h.distance <= reach && h.entity && h.entity.position
      && meleeOf(h) && (combatUtils.strikesRepeatedly(h.name) || (h.name === 'creeper' && !lit.has(h.id))));
    const near = brawlers.map((h) => h.entity.position);
    // Only while one other than the closest is still approaching; all inside strike range → fight the closest.
    const approaching = brawlers.slice(1).some((h) => h.distance > (h.name === 'creeper' ? CREEPER_OUTER : BLOB_STRIKE_B));
    const spread = spreadOf(self, near);
    const wide = spread && spread.arcDeg >= (gather ? GATHER_EXIT_DEG : GATHER_ENTER_DEG);
    blob = !!wide && approaching;
    if (blob && !gather) {
      gather = { since: now, arcDeg: spread.arcDeg };
      stats.gathers++;
      crewLog.event(TAG, 'gather', { state: 'open', arc: Math.round(spread.arcDeg), mobs: near.length });
    } else if (!blob && gather) {
      crewLog.event(TAG, 'gather', { state: 'closed', arc: spread ? Math.round(spread.arcDeg) : null, mobs: near.length, held: `${now - gather.since}ms`,
        why: !approaching ? 'in_strike_range' : 'gathered' });
      gather = null;
    }
    // The blob backs off by THE BACK-OFF, the one move every step back takes: the same heading as the band's retreat.
    if (blob) { order = { mode: 'retreat', setpoint: null, error: 0, blob: true }; stats.gatherTicks++; }
  } else if (gather) {
    crewLog.event(TAG, 'gather', { state: 'closed', held: `${now - gather.since}ms`, why: swelling ? 'swelling' : witchChase(board) ? 'witch' : 'flank' });
    gather = null;
  }
  // THE FIELD AHEAD (SECTION 4f) takes a mixed field from the band, the line, the flank and the gather; a swell keeps its own.
  if (!swelling && planField(board)) { order = { mode: 'plan', setpoint: null, error: 0 }; stats.planTicks++; }
  else lastPlan = null;
  // THE PRESS (above) takes the walk to a witch within WITCH_PRESS_B on her level from the band and the approach.
  const onWitch = !swelling && combatUtils.witchOnly(board.focus) && mob.id === board.focus.id && order.mode !== 'plan'
    ? witchPress(bot, self, mob, board) : null;
  pressing = onWitch ? mob.id : null;
  if (onWitch) { order = { mode: 'press', setpoint: WITCH_HOLD_B, error: Math.max(0, horizontal - WITCH_HOLD_B) }; stats.pressTicks++; }
  // THE RETURN STAND: a ghast's fireball comes to the body and the gunner strikes it back into the ghast (fireball_return),
  // so the feet stand where they are. A walk toward a ghast in the air reaches nothing and turns the body off the return.
  // The run and the blast wall still outrank it.
  if (!swelling && combatUtils.combatTactic(mob.name, mob.entity) === combatUtils.COMBAT_TACTICS.RETURNER) {
    order = { mode: 'stand', setpoint: null, error: 0 };
  }
  if (recenter && (order.mode.endsWith('_clear') || now - recenter.at >= RECENTER_MAX_MS)) recenter = null;
  // THE RUN outranks every walk of the fight: the body's life before the mob (Law 17).
  const fleeing = survival.fleeing === true;
  if (fleeing) { order = { mode: 'flee', setpoint: null, error: 0 }; stats.fleeTicks++; } else fleeArrived = false;
  // BEHIND THE BLAST WALL THE BODY STANDS STILL (gunner, THE BLAST WALL): a step off the creeper's line walks the body
  // out from behind its block. Outranks the run: no body outruns a fuse.
  const wallNow = crewBoard.readGunner().wall;
  if (wallNow && (wallNow.state === 'placing' || wallNow.state === 'set')) {
    order = { mode: 'wall_hold', setpoint: null, error: 0 };
    stats.wallHoldTicks++;
  }

  // Two accumulators: standoff errs against SWELL_CLEAR, the band against BAND_INNER/OUTER, so one
  // doesn't print as the other (Law 25).
  if (order.mode === 'flank' || order.blob || order.mode === 'flee' || order.mode === 'wall_hold' || order.mode === 'plan' || order.mode === 'press' || order.mode === 'stand') {
    // The flank and the blob walk to a heading, not a band: they add to neither error accumulator.
  } else if (order.mode === 'approach' || order.mode === 'retreat' || order.mode === 'hold' || order.mode === 'vertical_gap') {
    stats.errTicks++;
    stats.errSum += order.error;
    if (order.error > stats.worstBreach) stats.worstBreach = order.error;
  } else {
    stats.standoffTicks++;
    stats.standoffErrSum += order.error;
  }
  // Scored against the flat gap the band actually holds, not the 3-D total.
  if (horizontal >= BAND_INNER && horizontal <= BAND_OUTER) stats.inBandTicks++;
  // Counted apart so the report can say specifically that a fight was unwinnable from the ground.
  if (order.mode === 'vertical_gap') { stats.verticalGapTicks++; stats.verticalGapSum += Math.abs(dy); }
  announceMode(order.mode, distance, order.setpoint, mob, horizontal, dy);
  lastMode = order.mode;
  lastMobId = mob.id;
  // Backing off is whole-field (nine-candidate search); closing is one-mob, since anything else is
  // further by construction. moving is full press or none.
  const moving = order.mode !== 'hold' && order.mode !== 'vertical_gap' && order.mode !== 'wall_hold' && order.mode !== 'stand'
    && order.mode !== 'no_target' && !order.mode.endsWith('_clear');
  let heading = null;
  let stepInfo = null;
  let climb = false;
  let swim = false;
  let rise = true;      // a swum press holds jump; a route's swim holds it only while its cell stands higher
  let routed = false;   // the press walks a planned route's next cell, which never falls
  if (moving && order.mode === 'flee') {
    const run = fleeStep(bot, board.active, survival.goal);
    if (run) { heading = { x: run.x, z: run.z }; climb = run.climb; swim = !!run.swim; }
  } else if (moving && order.mode === 'flank') {
    // Walked only on a route, like the approach: no route yet is standing while think() searches.
    const step = route && route.mobId === mob.id && route.purpose === 'flank' ? routeHeading(bot, self) : null;
    if (step && !edgeWant(bot, self)) { heading = { x: step.x, z: step.z }; climb = step.climb; swim = step.swim; rise = step.rise; routed = true; }
  } else if (moving && order.mode === 'press') {
    if (!onWitch.stay) { heading = { x: onWitch.x, z: onWitch.z }; climb = onWitch.climb; }
    if (onWitch.circle) stats.circleTicks++;
    // One row on each change, so a fight's record says when the body pressed, held on her, or circled and from which mob.
    const pressKey = onWitch.stay ? 'on_her' : onWitch.circle ? `circle:${onWitch.circle}` : 'pressing';
    if (pressKey !== saidPress) {
      saidPress = pressKey;
      crewLog.event(TAG, 'press', { subject: `${mob.name}#${mob.id}`, state: onWitch.stay ? 'on_her' : onWitch.circle ? 'circle' : 'pressing',
        from: onWitch.circle || null, d: Math.round(horizontal * 10) / 10 });
    }
  } else if (moving && order.mode === 'plan') {
    const step = planStep(bot, board, self);
    if (step && !step.stay) { heading = { x: step.x, z: step.z }; climb = step.climb; }
  } else if (moving && order.mode !== 'approach') {
    // THE BACK-OFF (SECTION 4b): away from the whole press, not just the control mob, round what stands in the way.
    const pressing = (board.active || []).filter((h) => h.entity && h.entity.position && h.distance <= BACK_RANGE_B);
    stepInfo = backHeading(bot, pressing.length ? pressing : [mob]);
    if (stepInfo && !stepInfo.held) { heading = { x: stepInfo.x, z: stepInfo.z }; climb = stepInfo.climb; }
    const held = !!(stepInfo && stepInfo.held);
    if (held) stats.backHeld++;
    if (held !== saidBackHeld) {
      saidBackHeld = held;
      crewLog.event(TAG, 'back', { subject: `${mob.name}#${mob.id}`, state: held ? 'held' : 'open', blocked: stepInfo ? stepInfo.blocked : null, blob: !!order.blob });
    }
  } else if (moving) {
    // The approach walks only a route (SECTION 4c). No route for this mob yet is standing still while think() searches: never a
    // straight press at the mob. An edge still owing a dig or a block is worked from where the body stands.
    const step = route && route.mobId === mob.id && route.purpose === 'approach' ? routeHeading(bot, self) : null;
    if (step && !edgeWant(bot, self)) { heading = { x: step.x, z: step.z }; climb = step.climb; swim = step.swim; rise = step.rise; routed = true; }
    // A stuck body walks the ray itself, up to the block it has to dig: no route planned this press, so THE EDGE probes it.
    // A RAY THE EDGE WOULD STOP IS NO PRESS, and it does not take the route's step away: with a step to walk, the step
    // is kept and the ladder goes on pricing the route, so a body above a drop whose route walks onto its own bridge
    // keeps walking it.
    if (chase && chase.mobId === mob.id && chase.stuck && !stuckWant(bot, self) && !edgeWant(bot, self)) {
      const ray = { x: mob.entity.position.x - self.x, z: mob.entity.position.z - self.z };
      const vetoed = !!step && bot.entity.onGround && !!edgeAhead(bot, self, ray, distance > 3.3 ? EDGE_LOOK_SPRINT_B : EDGE_LOOK_B);
      if (!vetoed) { heading = ray; routed = false; }
      else stats.rayVetoed++;
    }
  }

  // THE LEDGE: a body holding its band with a ledge near steps away from it (ledgeStep); the band answers next tick.
  let ledged = null;
  if ((order.mode === 'hold' || order.mode === 'stand') && !heading && bot.entity.onGround) {
    ledged = ledgeStep(bot, self);
    if (ledged) { heading = { x: ledged.x, z: ledged.z }; stats.ledgeSteps++; }
  }
  if (!!ledged !== saidLedge) {
    saidLedge = !!ledged;
    crewLog.event(TAG, 'ledge', { subject: `${mob.name}#${mob.id}`, state: ledged ? 'stepping' : 'clear', ledges: ledged ? ledged.ledges : 0 });
  }

  // THE KNOCK LINE (above): a body whose throw from a mob near enough to strike ends at an edge steps to where it does not,
  // whatever walk the fight had it on. The run, the blast wall and a swell's back-off keep their own walk.
  let knock = null;
  if (!fleeing && !swelling && order.mode !== 'wall_hold' && bot.entity.onGround) {
    const near = (board.active || []).filter((h) => h.entity && h.entity.position && h.distance <= KNOCK_NEAR_B);
    const lines = near.length ? knockLines(bot, self, near) : [];
    if (lines.length) {
      knock = knockStep(bot, self, near, lines);
      knock.lines = lines;
      if (!knock.held) { heading = { x: knock.x, z: knock.z }; climb = false; routed = false; stats.knockSteps++; }
    }
  }
  const knockState = !knock ? 'clear' : knock.held ? 'held' : 'stepping';
  if (knockState !== saidKnock) {
    saidKnock = knockState;
    const l = knock && knock.lines[0];
    crewLog.event(TAG, 'knock', { subject: l ? `${l.mob.name}#${l.mob.id}` : `${mob.name}#${mob.id}`, state: knockState,
      lines: knock ? knock.lines.length : 0, left: knock && !knock.held ? knock.left : null,
      edge: l ? `${l.edge.x},${l.edge.z}${l.edge.deadly ? `:${l.edge.deadly}` : ''}` : null });
  }

  // ── THE DIVE ───────────────────────────────────────────────────────────────
  // The route ends at the water's surface (the search has no diving edge), so a mob under it is closed on here: the press
  // goes at the mob, jump is released and each tick strokes down, until the mob is in the arm's reach. The breath override
  // watches the air as on any swim and takes the body up at low air.
  const mp = mob.entity.position;
  const mobCell = bot.blockAt(new Vec3(Math.floor(mp.x), Math.floor(mp.y), Math.floor(mp.z)));
  const diveNow = !fleeing && !routed && (order.mode === 'approach' || order.mode === 'hold' || order.mode === 'vertical_gap')
    && !!mobCell && (mobCell.name === 'water' || mobCell.name === 'bubble_column')
    && self.y - mp.y >= DIVE_BELOW_B && distance > BOT_STRIKE_REACH - 0.3;
  if (diveNow !== diving) {
    diving = diveNow;
    crewLog.event(TAG, 'dive', { subject: `${mob.name}#${mob.id}`, state: diving ? 'on' : 'off', d: distance.toFixed(2), below: (self.y - mp.y).toFixed(2) });
  }
  if (diving) {
    heading = horizontal > 0.4 ? { x: mp.x - self.x, z: mp.z - self.z } : null;
    climb = false; swim = true; rise = false; routed = true;
    stats.diveTicks++;
  }

  // ── THE KNOCKBACK SWING ────────────────────────────────────────────────────
  // A melee mob is hit with a sprint swing, so the blow throws it back out of its own reach and it never lands one.
  // The gunner lowers the shield and publishes `knockback` with its swing target's id, holding the swing; this seat
  // presses toward that mob, which need not be the chase target, and arms sprint, and publishes `sprinting`, so the
  // server holds the sprint before the attack packet. Read off the gunner's board, never called across (Law 1).
  const gunnerBoard = crewBoard.readGunner();
  // A crowded line makes no press toward the lead, nor does a line whose lead already stands inside LINE_PRESS_B: the
  // press would carry the body into the lead's own reach. The swing, if it comes, is thrown from where the body stands.
  const LINE_PRESS_B = 2.8;
  const kbMob = gunnerBoard.knockback != null && gunnerBoard.shield !== true && !crowded && !(line && horizontal < LINE_PRESS_B)
    ? (board.active || []).find((h) => h.id === gunnerBoard.knockback && h.entity && h.entity.position) || null : null;
  const knockback = !!kbMob;
  if (knockback) {
    heading = { x: kbMob.entity.position.x - self.x, z: kbMob.entity.position.z - self.z };
    climb = false;
    routed = false;
    stats.knockbackTicks++;
  }

  // OUT OF THE FIRE (SECTION 4c) outranks every walk above.
  const fireOut = fireExit(bot, self);
  if (fireOut) { heading = { x: fireOut.x, z: fireOut.z }; routed = false; stats.fireOutTicks++; }
  if (!!fireOut !== saidFire) { saidFire = !!fireOut; crewLog.event(TAG, 'fire', { subject: `${mob.name}#${mob.id}`, state: fireOut ? 'leaving' : 'out' }); }

  // THE EDGE (SECTION 4c): every press is probed before it is pressed; an edge ahead stops it where the body stands.
  if (heading && !swim && !routed && !fireOut && bot.entity.onGround) {
    const sprinting = knockback || fleeing || order.mode === 'flank' || ((order.mode === 'approach' || order.mode === 'plan') && distance > 3.3);
    const edge = edgeAhead(bot, self, heading, sprinting ? EDGE_LOOK_SPRINT_B : EDGE_LOOK_B);
    if (edge) {
      heading = null;
      stats.edgeHolds++;
      // A run held at an edge turns: the heading is barred as a stalled one is (THE RUN), so the next tick takes the next open
      // heading. Unbarred, the run picks the same heading every tick and the body stands at the edge.
      if (order.mode === 'flee') barFleeHeading(Date.now());
      if (!saidEdge) crewLog.event(TAG, 'edge', { subject: `${mob.name}#${mob.id}`, mode: order.mode, at: `${edge.x},${edge.z}`, depth: edge.depth, deadly: edge.deadly || null, knockback });
      saidEdge = true;
    } else saidEdge = false;
  } else saidEdge = false;

  // ── SPRINT ─────────────────────────────────────────────────────────────────
  // The knockback swing, the sprint primed for it behind the shield, the run for life, and the close on a shooter: a
  // KITER keeps its distance and shoots while the body walks, and the flank walks round a brawler. Never a long close on a mob
  // that walks to the body itself. Never at rest (Law 19). SPRINT_RELEASE_B releases one tick clear of the arm's reach
  // so the flag drops before a swing resolves.
  const SPRINT_RELEASE_B = 3.3;
  const kiter = combatUtils.combatTactic(mob.name, mob.entity) === 'KITER';
  // THE FIELD AHEAD closes on a shooter as the approach does: at a walk the body crossed the witch's and the archers'
  // whole fire at a third of the speed and died under it.
  // THE WITCH IS NOT THROWN: a blow sent within a tick or two of the sprint's release still carries the sprint's throw
  // (arena: struck at 2.9 b from a sprint let go at 3.3, she flew 3.5 b a blow down a hill, six blows in 8 s over 30 b and
  // none a crit, and her potions killed the body). The sprint at her is let go at WITCH_SPRINT_RELEASE_B.
  const releaseB = combatUtils.healsItself(mob.name) ? WITCH_SPRINT_RELEASE_B : SPRINT_RELEASE_B;
  const closing = ((order.mode === 'approach' || order.mode === 'plan' || order.mode === 'press') && kiter && distance > releaseB)
    || order.mode === 'flank';

  // A press is a press — no fraction, no dither. `heading` null is the only stop.
  const press = heading !== null;

  // Yaw read raw from the body, not the board — this seat never writes yaw (Law 21).
  const keys = press && heading ? headingKeys(heading, bot.entity.yaw) : NO_KEYS;

  // Unguarded, same reason as release(): the only throw setControlState has is our own bad literal.
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, keys[k]);

  // Re-armed, not set, because the server clears sprint after an attack while mineflayer's flag stays
  // true (Law 19); shield exclusion is read off the gunner's published guard, not reached for (Law 1).
  const guarding = crewBoard.readGunner().shield === true;
  if (guarding) stats.sprintBlockedByShield++;
  // SPRINT PRIMED BEHIND THE SHIELD: the server's knockback bonus reads only the sprint flag at the attack, so with a
  // melee mob within PRIME_B the flag is held up while the guard is, and the gunner's knockback swing lowers the shield
  // and strikes in one tick, with no wait for sprint during which the mob could land its blow.
  const PRIME_B = 3.5;
  // Never in THE PRESS: a sprint blow throws the witch further off, and the walk back is her time to drink and throw.
  const primed = guarding && order.mode !== 'press' && (board.active || []).some((h) => h.distance <= PRIME_B
    && meleeOf(h));
  if (primed) stats.primedTicks++;
  const wantSprint = knockback || primed || (press && (closing || fleeing) && !guarding);
  if (wantSprint) {
    combatUtils.armSprint(bot);
    sprintArmed = true;
    stats.sprintTicks++;
  } else if (sprintArmed) {
    combatUtils.releaseSprint(bot);
    sprintArmed = false;
  }
  // Announced with its stop reason since guard/not-brawler/no-press want different repairs.
  if (wantSprint !== saidSprint) {
    saidSprint = wantSprint;
    crewLog.event(TAG, 'sprint', {
      state: wantSprint ? 'on' : 'off',
      why: knockback ? 'knockback_swing' : primed ? 'primed' : wantSprint ? (fleeing ? 'flee' : order.mode === 'flank' ? 'flank' : 'closing_kiter') : (guarding ? 'guarding' : !press ? 'no_press' : 'walked_to'),
    });
  }
  if (press) stats.pressedTicks++;

  // ── THE STALL TAP ──────────────────────────────────────────────────────────
  const travelled = lastPos ? Math.hypot(self.x - lastPos.x, self.z - lastPos.z) : null;
  if (travelled !== null) {
    // Sampled only on ticks the body was asked to move (Law 25).
    if (press) {
      stats.speedTicks++;
      const bps = travelled * 20;
      stats.speedGotSum += bps;
      if (bps > stats.speedPeak) stats.speedPeak = bps;
    }
    if (press && travelled < STALL_EPS) stallTicks++; else { stallTicks = 0; stallJumps = 0; }
  }
  // THE CRIT is a terminator's, against the mob its feet are on when that mob takes the plain blow: a witch or an archer.
  const critMob = require('@api/combat_board').fightsAsTerminator() && kiter
    && (order.mode === 'press' || order.mode === 'hold' || order.mode === 'approach' || order.mode === 'retreat');
  // A swum run holds jump, re-armed each tick it swims, and released by the countdown once it stops. A route's swim holds
  // it only toward a higher cell (the stroke up and the climb out); level or down, the head-up rule below keeps it up.
  if (diving) {
    bot.setControlState('jump', false); jumpTicks = 0;
    require('@locomotion/underwater_swimming').swimDown(bot);
  } else if (swim && press && rise) { bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; }
  // THE HEAD KEPT UP IN WATER: a body that fights standing in water two deep has its eyes under, and nothing else holds
  // it up (underwater_swimming is only the breath override, taken at low air, and it ends the wave). Jump is held while
  // the eye is under, as the navigator's swim step holds it, so the fight is fought breathing.
  else if (bot.entity.isInWater && require('@locomotion/underwater_swimming').submerged(bot)) { bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; }
  if (jumpTicks > 0) {
    jumpTicks--;
    if (jumpTicks === 0) bot.setControlState('jump', false);
  } else if (critMob && bot.entity.onGround && !(board.swelling || []).length && horizontal <= CRIT_REACH_B
    && Math.abs(dy) <= CRIT_DY && Number.isFinite(readyInMs) && readyInMs <= CRIT_LEAD_MS) {
    // THE CRIT (THE PRESS): up as the arm comes ready, so the blow leaves on the way down.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; stats.critJumps++;
  } else if (climb && press && bot.entity.onGround) {
    // The route's next cell is a tread up: jumped as the body reaches it, not after a stall.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS;
  } else if (stallTicks >= STALL_TICKS) {
    let jumped = false;
    // setControlState asserts only on our own bad literal, never the world's, so the press is unguarded.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; jumped = true;
    stallTicks = 0;
    stallJumps++;
    if (order.mode === 'flee') barFleeHeading(Date.now());
    // A stall event carries its cause (mode + keys) and whether the jump tap was tried.
    crewLog.event(TAG, 'stall', {
      subject: crewLog.subject(mob.entity), mode: order.mode, d: distance.toFixed(2),
      keys: Object.keys(keys).filter((k) => keys[k]).join('+') || 'none',
      jump: jumped ? 'yes' : 'no',
    });
  }
  lastPos = { x: self.x, z: self.z };
  stats.engagedTicks++;

  // Counted before the write so the tally and the published want can never disagree.
  const want = terrainWant(bot, self, order, dy, heading, mob);
  if (want) {
    stats.terrainAskTicks++;
    if (want.kind === 'dig') stats.terrainAskDig++; else if (want.kind === 'bridge') stats.terrainAskBridge++; else if (want.kind === 'open') stats.terrainAskOpen++; else stats.terrainAskPlace++;
    // Read, never assumed (Law 1, Law 23).
    const ans = crewBoard.readGunner().terrainStatus;
    if (ans && ans.state === 'refused') stats.terrainRefusedTicks++;
    // A block the gunner could not set ends that route: the next search reads the world as it stands.
    if (want.kind !== 'dig' && ans && ans.state === 'failed' && route) route.offRoute = true;
  }

  writeBoard({
    mode: order.mode,
    setpoint: order.setpoint,
    error: order.error,
    // Recomputed from this tick's state, never carried (level-triggered; a stale want cannot survive).
    terrainRequest: want,
    distance,
    targetId: mob.id,
    swelling,
    keys: press ? keys : null,
    // The flat unit heading pressed this tick; the gunner turns a running body along it (THE RUN).
    heading: press && heading ? { x: heading.x, z: heading.z } : null,
    sprint: press,
    // Sprint armed this tick: the gunner holds a knockback swing until it reads true (THE KNOCKBACK SWING).
    sprinting: wantSprint,
    // Step search verdict posted, not re-derived.
    back: stepInfo ? { held: !!stepInfo.held, offDeg: stepInfo.offDeg ?? null, blocked: stepInfo.blocked, blob: !!order.blob } : null,
    // The route being walked and the chase verdict (SECTION 4c), for any reader.
    route: route ? { purpose: route.purpose, mobId: route.mobId, cells: route.path.length, idx: route.idx } : null,
    chase: chaseVerdict(),
    at: Date.now(),
  });
}

// ── SECTION 6: Public API ──────────────────────────────────────────────────

// Handler held so stop() removes exactly its own; three seats share physicsTick.
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  // removeListener is EventEmitter bookkeeping and cannot fail; a throw here would mean no bot (Law 13).
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
  engaged = false;
}

// engage()/disengage() bracket a wave; release() runs on the way out (Law 8).
function engage() {
  if (engaged) return;
  stats = _blankStats();
  lastPos = null;
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  recenter = null;
  standoff = null;
  route = null;
  chase = null;
  lastMode = null;
  lastMobId = null;
  flankPoint = null;
  gather = null;
  lastPlan = null;
  saidPlan = null;
  saidPress = null;
  // Cleared so a new wave's first line isn't suppressed by the last mode (Invariant B).
  saidMode = null;
  saidOn = null;
  saidBackHeld = false;
  saidSprint = false;
  diving = false;
  engaged = true;
}

function disengage(bot) {
  if (!engaged) return;
  engaged = false;
  recenter = null;
  route = null;
  chase = null;
  gather = null;
  diving = false;
  if (bot) release(bot);
}

// One aggregated line per wave (Law 5 — no per-tick logging in this seat).
function report() {
  if (!stats) return;
  // Silence would read as nothing to report when the feet never got a target (Law 25). A run or a stand behind a
  // blast wall had one: neither adds to the band's error.
  if (!stats.errTicks && !stats.fleeTicks && !stats.wallHoldTicks) {
    if (stats.ticks) {
      watcher.warn(TAG,
        `🚗 Driver: ${stats.ticks} tick(s) engaged and NOT ONE of them had a target — ` +
        `${stats.noTarget} tick(s) read an empty board. The feet sat out this entire fight. The commander ` +
        `owns which mob is on the board (aggro + sightline); this seat only reads it.`);
    }
    return;
  }
  const meanErr = stats.errTicks ? stats.errSum / stats.errTicks : 0;
  const inBand = stats.errTicks ? (100 * stats.inBandTicks) / stats.errTicks : 0;
  const got = stats.speedTicks ? stats.speedGotSum / stats.speedTicks : 0;
  // These numbers are measured on ticks that emitted nothing to the event stream.
  watcher.summary(TAG,
    `🚗 Driver: ${stats.errTicks} tick(s) on a target. Mean error ${meanErr >= 0 ? '+' : ''}${meanErr.toFixed(2)}b ` +
    `outside the band (positive = too close, 0 = in it), worst breach ${stats.worstBreach.toFixed(2)}b, ` +
    `${inBand.toFixed(0)}% of ticks inside ${BAND_INNER}–${BAND_OUTER}b. ` +
    `Body achieved ${got.toFixed(2)}b/s while moving (a sprint is ${SPRINT_SPEED}) over ${stats.pressedTicks} pressed tick(s). ` +
    // Sprint as a fraction of the press is the policy itself; the read-back is the only proof it fired
    // (Law 23).
    `Sprint (knockback swing, fleeing, closing on shooters): armed on ${stats.sprintTicks} of ${stats.pressedTicks} pressed tick(s), ` +
    `still set on the next tick ${stats.sprintHeld}/${stats.sprintAskedLastTick}, ` +
    `peak ${stats.speedPeak.toFixed(2)}b/s against a ${SPRINT_SPEED} sprint and a ${WALK_SPEED} walk` +
    `${stats.sprintBlockedByShield ? `, and the shield held sprint down on ${stats.sprintBlockedByShield} tick(s)` : ''}` +
    `${stats.knockbackTicks ? `; sprinted into the gunner's knockback swing on ${stats.knockbackTicks} tick(s)` : ''}` +
    `${stats.flankTicks ? `; walked a flank round a brawler (its shooter lined up behind it) on ${stats.flankTicks} tick(s)` : ''}` +
    `${stats.gatherTicks ? `; backed off for the blob ${stats.gathers} time(s) over ${stats.gatherTicks} tick(s)` : ''}` +
    `${stats.backHeld ? `; a back-off found no open heading on ${stats.backHeld} tick(s) and held` : ''}` +
    `${stats.kiteTicks ? `; held a melee mob out of reach while the weapon recharged on ${stats.kiteTicks} tick(s)` : ''}` +
    `${stats.lineTicks ? `; kited ${stats.lineTicks} tick(s) with several brawlers in front, ${stats.crowdedTicks} of them too crowded to strike` : ''}` +
    `${stats.fleeTicks ? `; ran for its life on ${stats.fleeTicks} tick(s)` : ''}` +
    `${stats.wallHoldTicks ? `; stood behind a blast wall on ${stats.wallHoldTicks} tick(s)` : ''}.` +
    `${stats.standoffTicks ? ` Standoff (counted apart from the band): ${stats.standoffTicks} tick(s), mean error ${(stats.standoffErrSum/stats.standoffTicks).toFixed(2)}b.` : ''}` +
    `${stats.recenters ? ` Recentered off a friend in the sweep: ${stats.recenters} time(s).` : ''}`);

  if (stats.routeSearches) {
    watcher.summary(TAG,
      `🚗 Route: ${stats.routeSearches} search(es) on the navigator's pathfinder with ${COMBAT_THINK_MS}ms to think — ` +
      `${stats.routeFound} found, ${stats.routeNone} none (${stats.routeTimedOut} out of thinking time, ` +
      `${stats.routeOffEdge} only through an airlock, which a fight never opens); slowest think ${stats.thinkMsMax}ms.` +
      `${stats.routeHops ? ` ${stats.routeHops} hop(s) walked on a partial search, ${stats.routeJoined} joined to a long plan.` : ''}${stats.stuck ? ` ${stats.stuck} navigation fault(s): stuck ${STUCK_MS}ms, raycast to the mob.` : ''}${stats.gaveUp ? ` ${stats.gaveUp} mob(s) handed on (no pillar material).` : ''}${stats.edgeHolds ? ` ${stats.edgeHolds} tick(s) stopped at an edge.` : ''}${stats.ledgeSteps ? ` ${stats.ledgeSteps} tick(s) stepped away from a ledge.` : ''}${stats.knockSteps ? ` ${stats.knockSteps} tick(s) stepped off a knock line ending at an edge.` : ''}${stats.rayVetoed ? ` ${stats.rayVetoed} stuck tick(s) kept the route step: the ray press would cross an edge.` : ''}`);
  }
  // Separate from the summary: an unwinnable-from-ground fight is a terrain fact, not a steering fault.
  if (stats.terrainAskTicks) {
    watcher.summary(TAG,
      `🚗 asked the gunner for terrain on ${stats.terrainAskTicks} tick(s) — ${stats.terrainAskDig} dig, ` +
      `${stats.terrainAskPlace} pillar, ${stats.terrainAskBridge} bridge, ${stats.terrainAskOpen} door; the yaw was spoken for on ${stats.terrainRefusedTicks} of them. ` +
      `This seat never digs: it publishes a want and the gunner serves it or does not (see its own line).`);
  }
  if (stats.verticalGapTicks) {
    const meanRise = stats.verticalGapSum / stats.verticalGapTicks;
    watcher.warn(TAG,
      `🚗 UNWINNABLE FROM THE GROUND — ${stats.verticalGapTicks} of ${stats.errTicks} tick(s) had the feet correctly ` +
      `placed with the mob still out of the arm's ${BOT_STRIKE_REACH}b, mean ${meanRise.toFixed(2)}b of rise between them. ` +
      `The band is held across the ground because that is the only axis the feet move on, so this separation is ` +
      `not a steering fault and no key closes it — it needs a verb that changes the body's height. ` +
      `The engagement was never dropped: admitting a mob is the commander's (aggro + sightline), and this seat only ` +
      `reports that it has done all a pair of feet can.`);
  }
}

// The one thing another seat may write here — a setpoint, not a command (Invariant D).
function setStandoff(range) {
  standoff = Number.isFinite(range) ? range : null;
}

function state() {
  return { attached, engaged, stats: stats ? { ...stats } : null };
}

module.exports = {
  start, stop, engage, disengage, report, state, setStandoff,
  // The route seat's async half, awaited by battle_stations' pass, and its verdict (SECTION 4c).
  think, chaseVerdict, endChase, edgeAhead,
  // Bench exports: both pure, both where this seat can be wrong arithmetically.
  bandOrder, backHeading,
  // Bench export for the run: the heading it takes (SECTION 4e).
  fleeStep,
  // Bench export for the route: the goal.
  bandGoal,
  BAND_INNER, BAND_OUTER, SWELL_CLEAR, WALK_SPEED, SPRINT_SPEED, COMBAT_THINK_MS,
};
