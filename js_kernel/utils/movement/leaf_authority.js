// The fleet's one definition of what a leaf is: a phantom leaf reads as air to every predicate and is
// punched by reflex when the body reaches it; a blueprint leaf is bedrock. The body asks no permission to
// remove one, and a route never refuses one; a route search prices each leaf a step would cut (below), so
// a short way round a tree wins and a forest is walked through, the canopy cut as the body arrives.
//
// isPhantom is the only question this module answers about a specific cell, and the blueprint exception
// lives inside the predicate — there is no leaf-only path exported for a caller to reach past it
// (Invariant D — one owner).
//
// A LEAF IS PRICED, NEVER REFUSED: a route search adds COST_LEAF for each leaf a step would cut (leavesOn), so a
// route goes round a tree when the way round is short and through the canopy when it is not.
//
// A leaf plays two separate roles: NEVER A FLOOR — a canopy decays under a standing body, so
// terrain_predicates.isWalkableSurface keeps every leaf out of the floors a route may land on.
// INVISIBLE AS OBSTRUCTION — a leaf in the body's path is not an obstruction. Conflating the two roles
// makes a canopy a wall.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');

const TAG = 'leaf_authority';

// THE ONE DEFINITION of a leaf block. Leaf litter, bushes and firefly_bush are not named here: the server
// already reports them with an empty bounding box, and every predicate in the fleet already passes them
// (Invariant B).
const LEAF_NAME = /(^|_)leaves$/;
function isLeaf(block) {
    return !!(block && typeof block.name === 'string' && LEAF_NAME.test(block.name));
}

// ── THE PROTECTED SET IS CACHED ─────────────────────────────────────────────────────────────────────
// `getAllProtectedBlocks` walks every locked conference room and expands each blueprint's voxel keys —
// too expensive for `getClearance`, among the most-asked questions in the fleet.
//
// The cached set is built from DECLARED voxels of blueprints that hold a locked `transpose_origin`, so it
// changes only when a building is SITED, not as blocks are placed. The one-second window can miss a
// blueprint sited within the last second; it cannot make the fleet punch an already-declared blueprint leaf.
const PROTECTED_TTL_MS = 1000;
let _protectedAt = 0;
let _protected = null;
function protectedSet(bot) {
    const now = Date.now();
    if (now - _protectedAt < PROTECTED_TTL_MS) return _protected;
    _protected = require('@perception/blueprint_survey').getAllProtectedBlocks(bot) || null;
    _protectedAt = now;
    return _protected;
}

// isPhantom — TRUE when this block is a leaf the body may treat as air and remove on contact.
// FALSE for everything else, including a leaf the fleet declared: that one is bedrock.
function isPhantom(bot, block) {
    if (!isLeaf(block)) return false;
    const p = block.position;
    if (!p) return false;
    const owned = protectedSet(bot);
    return !(owned && owned.has(`${p.x},${p.y},${p.z}`));
}

// isPhantomAt — the same question from coordinates, for a caller that has not already read the cell.
function isPhantomAt(bot, x, y, z) {
    return isPhantom(bot, bot.blockAt(new Vec3(x, y, z)));
}

// ── A LEAF IS CUT BY HAND, ALWAYS ─────────────────────────────────────────────────────────────────────
// A leaf costs a sword 2 durability, and a body walking through a forest cuts hundreds: the T-1's night-4 march wore
// out its iron sword and then its stone sword on leaves (item book: the stone sword `worn_out` by `dig`), and it fought
// its last three fights with a stone axe. A hand cuts a leaf in 6 ticks against a sword's 4 and drops nothing either
// way, so every leaf is cut with the empty hand: a walk's, a fight's terrain errand's and the scout's. A fight's next
// swing re-equips through pickBestWeapon.
// cut(bot, block, tag) → performDig's answer: true when the cell re-senses passable.
async function cut(bot, block, tag) {
    const { performDig } = require('@utils/movement/dig_authority');
    const { hold } = require('@utils/hand');
    await hold(bot, null, tag);
    return await performDig(bot, block.position, block, tag, { equip: 'none' });
}

// ── THE SCOUT: LEAVES AHEAD ARE CUT BEFORE THE BODY REACHES THEM ──────────────────────────────────────
// The reflex below cuts a leaf only when the next step is about to enter it, and the walk stands still for
// the cut. The scout is handed the stance cells of the next few steps and starts ONE fist dig on the nearest
// phantom leaf within reach, without awaiting it, so the walk carries on while the leaf comes down.
// It digs without turning the head (`'ignore'`): the drive steers by holding its yaw, and the server checks
// reach, not gaze. One dig is in flight at a time; the reflex waits for it before cutting, so two digs
// never overlap. A dig the server does not finish in SCOUT_DIG_MS is stopped and the reflex takes the cell.
const SCOUT_REACH_B = 4.3;      // eye to block centre; a survival arm reaches 4.5
const SCOUT_DIG_MS = 900;       // a hand leaf is 6 ticks (300 ms); three times that and some latency
let _scoutDig = null;
let _scouted = 0;
let _scoutCells = [];
function scout(bot, cells) {
    _scoutCells = cells;
    if (_scoutDig || !bot.entity) return false;
    const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
    let target = null;
    let best = Infinity;
    for (const c of cells) {
        const b = bot.blockAt(c instanceof Vec3 ? c : new Vec3(c.x, c.y, c.z));
        if (!isPhantom(bot, b)) continue;
        const d = eye.distanceTo(b.position.offset(0.5, 0.5, 0.5));
        if (d <= SCOUT_REACH_B && d < best) { best = d; target = b; }
    }
    if (!target) return false;
    let cleared = false;
    _scoutDig = (async () => {
        const { hold } = require('@utils/hand');
        const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');
        const held = await hold(bot, null, TAG);
        if (!held.ok) return;
        let timer = null;
        const r = await Promise.race([
            guardExternal(TAG, `scout dig ${target.name}`, () => bot.dig(target, 'ignore')),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), SCOUT_DIG_MS); }),
        ]);
        clearTimeout(timer);
        if (!r.ok) {
            if (r.reason === 'timeout') guardExternalSync(TAG, 'stop the scout dig', () => bot.stopDigging());
            return;
        }
        _scouted++;
        cleared = true;
        watcher.summary(TAG, `scouted a leaf ${best.toFixed(1)} b ahead (${_scouted} this life).`);
    })().finally(() => {
        _scoutDig = null;
        // After a cut, the next leaf of the same cells starts at once: a fused run walks several steps in one
        // navigator call, so waiting for the next call would leave the rest for the reflex. A refused or stopped
        // dig is not retried; the reflex takes that cell.
        if (cleared) scout(bot, _scoutCells);
    });
    return true;
}
// scoutSettled — the reflex's wait: a scout dig in flight finishes (or is stopped) before another dig starts.
async function scoutSettled() {
    while (_scoutDig) await _scoutDig;   // a chained cut starts as the last one settles
}

// ── THE REFLEX ──────────────────────────────────────────────────────────────────────────────────────
// Takes no dispatcher, no job, no claim and no permission. It is handed the cells the body is about to
// occupy and empties them. Nothing here decides WHERE the body is going — that is the caller's, and a
// reflex that chose its own targets would be a second navigator (Invariant D).
//
// Reports what it cleared. A cell that is not a phantom is silently skipped, since the overwhelming
// majority of calls clear nothing.
async function punch(bot, cells) {
    await scoutSettled();
    let cleared = 0;
    for (const c of cells) {
        const b = bot.blockAt(c instanceof Vec3 ? c : new Vec3(c.x, c.y, c.z));
        if (!isPhantom(bot, b)) continue;
        if (await cut(bot, b, TAG)) cleared++;
    }
    if (cleared) watcher.summary(TAG, `punched ${cleared} leaf block(s) out of the body's own path.`);
    return cleared;
}

// ── A LEVEL STEP CUTS TWO ──────────────────────────────────────────────────────────────────────────
// stepCells(from, to) → the cells of the destination column a body stepping from feet `from` to feet `to` passes
// through: always the feet and the head there. A step that rises jumps, and the arc reaches the cell over the
// landing's head; a step that drops crosses at its old height before it falls, so the column is open up to the old
// head. A level step needs neither. The one rule the walk's reflex, the scout, the fight's driver and the route
// search's price all use (Law 16).
function stepCells(from, to) {
    const t = to instanceof Vec3 ? to : new Vec3(to.x, to.y, to.z);
    const f = from || t;
    const cells = [t, t.offset(0, 1, 0)];
    const top = Math.max(t.y + (t.y > f.y ? 2 : 1), f.y + 1);
    for (let y = t.y + 2; y <= top; y++) cells.push(new Vec3(t.x, y, t.z));
    return cells;
}

// clearStance — the cells a body stepping from feet `from` onto feet `feet` passes through (stepCells). With no
// `from`, the step is read as level.
async function clearStance(bot, feet, from = null) {
    const f = feet instanceof Vec3 ? feet : new Vec3(feet.x, feet.y, feet.z);
    return await punch(bot, stepCells(from, f));
}

// leavesOn(bot, from, to) → how many of the step's cells hold a phantom leaf: what a route search prices.
function leavesOn(bot, from, to) {
    let n = 0;
    for (const c of stepCells(from, to)) if (isPhantomAt(bot, c.x, c.y, c.z)) n++;
    return n;
}

// isLeafBlock is exported for the FLOOR question alone — `terrain_predicates.isWalkableSurface` and
// `pathfinding_utils.isLeafFloor`, which ask it of any leaf, a blueprint's included.
// Every other caller wants `isPhantom`, which carries the blueprint exception.
module.exports = { isPhantom, isPhantomAt, punch, cut, clearStance, stepCells, leavesOn, scout, isLeafBlock: isLeaf, TAG };
