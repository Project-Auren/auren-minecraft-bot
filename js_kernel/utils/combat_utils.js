// module: combat_utils — the one home for every combat ACT primitive. Primitives move the bot, never
// emit signals or route payloads; composition (which mob/tactic/when to abandon) belongs to
// battle_stations. Pure arithmetic lives in attack_cadence_calculator; facts there, policy here.
//
// Hit damage is a function of time since last hit, not aim: Java refills "charge" over 1/attackSpeed s
// and scales damage 0.2 + 0.8·charge²; a damaged mob is invulnerable 10 ticks, absorbing equal-or-weaker
// hits entirely. An immediate re-swing does around 20% damage or often none, with nothing in-world
// reporting either half (the swing animates, the log says landed). Every primitive here is built around
// that clock.

'use strict';

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { sleep } = require('@utils/fragment_utils');
const { weaponProfile, attackCharge, chargeDamageMultiplier, msUntilCharge, swingPeriodMs, CRIT_MIN_CHARGE, sustainedDamagePerSecond } = require('@utils/calculators/attack_cadence_calculator');
// `BOT_STRIKE_REACH` is the reach `swingNow` gates on, so its one owner is the file that owns the swing.
// `BOT_WIDTH` is exported for the driver's vertical case, where a mob's column overlapping the bot's own
// is the only derived statement of arrived-beneath available, and a copy over there would drift from the
// reach figure it shares a derivation with (Law 16).
const BOT_STRIKE_REACH = 3.0;   // a player's reach, from the eyes to the target's box (swingDistance)
const BOT_WIDTH = 0.6;
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'combat_utils';

// ── 1. THE SWING CLOCK ───────────────────────────────────────────────────────
// Module-level (Law 9: per-process transient, one owner); read through the functions below, never a
// bare export, so nothing writes it out of step with a swing (Law 6). mineflayer tracks no cooldown
// itself — `bot.attack` sends its packets synchronously — so this clock is an estimate stamped at send
// time, and wait helpers add margin against latency making it optimistic.

let _lastSwingAt = 0;      // epoch ms of the last swing THIS process fired
let _swings = 0;           // monotonic, for the trace only

// Java resets attack cooldown on a held-item change; the stamp stops the next swing from reading full
// charge. Without it, switching weapons every swing would let the bot land repeated full-damage strikes
// it has not actually recovered for — a fairness constraint (Law 19), not a correctness optimisation
// (Invariant E, Rogue Machine).
function noteEquip() { _lastSwingAt = Date.now(); }

function msSinceLastSwing(now) {
  if (!_lastSwingAt) return Infinity;                 // never swung ⇒ fully charged
  return (now != null ? now : Date.now()) - _lastSwingAt;
}

// chargeNow(cooldownMs) → 0..1, this process's estimate of the server's attack charge.
function chargeNow(cooldownMs, now) {
  const since = msSinceLastSwing(now);
  if (since === Infinity) return 1;
  return attackCharge(since, cooldownMs);
}

// Inspection surface (Law 6). Read-only by construction — snapshot, not the variables.
function swingClock(cooldownMs) {
  const since = msSinceLastSwing();
  const charge = chargeNow(cooldownMs);
  return {
    swings: _swings,
    msSinceLastSwing: since === Infinity ? null : since,
    charge,
    damageFraction: chargeDamageMultiplier(charge),
    critEligible: charge > CRIT_MIN_CHARGE,
  };
}

// Test seam ONLY — clock is process-global, a swinging test would poison the next. A production fight
// needing to forget its own cadence is a bug in the fight.
function _resetSwingClock() { _lastSwingAt = 0; _swings = 0; }

// ── 2. EQUIP THE BEST WEAPON — one stat-aware ranking, sword-primary by arithmetic ───────────────────
// One score, sustainedDamagePerSecond (full-charge damage over the real minimum time between two
// landing hits), ranks every weapon; no category rungs. Sword-primary is the output of that score, not
// a rule, and backup on a broken sword is emergent: the next-best score becomes whichever item is left.
// A stats-aware score, not a category preference, so a high-tier axe can outrank a junk sword.

// _score(itemName) → sustained dps; null (not 0) for non-weapons, so a caller can tell "scored badly"
// from "not a weapon".
function _score(itemName) {
  const p = weaponProfile(itemName);
  if (!p.known) return null;
  return sustainedDamagePerSecond(itemName);
}

// Tie-break for identical scores (golden and wooden sword both read 6.4): a fixed category order makes
// the choice deterministic (Law 19).
const _CATEGORY_PREFERENCE = { sword: 0, axe: 1 };
function _prefers(candidate, incumbent) {
  const c = _CATEGORY_PREFERENCE[candidate.category] ?? 2;
  const i = _CATEGORY_PREFERENCE[incumbent.category] ?? 2;
  if (c !== i) return c < i;
  return false;   // same category and same score — keep the incumbent, so the scan is order-stable
}

// heldWeaponName(bot) → what is actually in hand, 'fist' when nothing. Distinct from pickBestWeapon:
// they can disagree exactly when it matters (durability break, failed swap, never-equipped arm), so a
// measurement is tagged with the weapon that actually swung, not the one merely intended. Reads 'fist',
// not null or 'none', so tallies group it as a weapon — a condition under test.
function heldWeaponName(bot) {
  return (bot && bot.heldItem && bot.heldItem.name) || 'fist';
}

// pickBestWeapon(bot) → { item, profile, rung }; item null = bare hands. `rung` is the winning CATEGORY
// ('sword'|'axe'|'tool'|'fist'), not a ladder index — no ladder; the log says what the arithmetic chose.
function pickBestWeapon(bot) {
  const items = (bot && bot.inventory && bot.inventory.items()) || [];
  let best = null, bestScore = -1, bestProfile = null;
  for (const it of items) {
    if (!it || !it.name) continue;
    const score = _score(it.name);
    if (score == null) continue;
    const profile = weaponProfile(it.name);
    if (score > bestScore || (score === bestScore && bestProfile && _prefers(profile, bestProfile))) {
      bestScore = score; best = it; bestProfile = profile;
    }
  }
  notePick(bot, best, items);
  if (!best) return { item: null, profile: weaponProfile(null), rung: 'fist' };
  const rung = bestProfile.category === 'sword' || bestProfile.category === 'axe' ? bestProfile.category : 'tool';
  return { item: best, profile: bestProfile, rung };
}
// THE WEAPON PICK IS RECORDED WHEN IT CHANGES: a `weapon_pick` row names the new pick with its durability left, the
// one it replaced, and every weapon-scored item the pocket held (`available`, 'name:left'), so a body that fights with
// an axe says it was the best it had and what it had.
let _pickSaid;
function notePick(bot, best, items) {
  const name = best ? best.name : 'fist';
  if (name === _pickSaid) return;
  const was = _pickSaid === undefined ? null : _pickSaid;
  _pickSaid = name;
  const left = (i) => (i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : null);
  require('@api/combat_record').record('weapon_pick', {
    pick: name, pick_left: best ? left(best) : null, was,
    available: items.filter((i) => i && i.name && _score(i.name) != null).map((i) => `${i.name}:${left(i)}`),
  });
}

// equipBestWeapon(bot) → same shape after equipping, through the hand's one gate (utils/hand): already held is a no-op
// and does not stamp the clock, since no item change is sent and stamping would dump charge on every pick.
async function equipBestWeapon(bot) {
  const choice = pickBestWeapon(bot);
  if (!choice.item) return choice;
  // mineflayer's equip losing a race with an inventory update is environmental: degrade to the rung
  // below, and report the degraded rung as `rung`, so a caller reading it never sees the weapon it
  // asked for when the bot is actually holding fists.
  const held = await require('@utils/hand').hold(bot, choice.item, TAG);
  if (!held.ok) {
    return { item: bot.heldItem || null, profile: weaponProfile(bot.heldItem ? bot.heldItem.name : null), rung: 'fist' };
  }
  if (held.changed) noteEquip();
  return choice;
}

// ── THE SHIELD RIDES IN THE OFF-HAND ─────────────────────────────────────────────────────────────────
// holdsShield(bot) → true when the off-hand holds a shield: the gunner's raise (activateItem(true)) blocks only then.
function holdsShield(bot) {
  const slot = bot && bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
  return !!(slot && slot.name === 'shield');
}

// readyShield(bot) → holdsShield after the call. A shield in the pocket goes to an EMPTY off-hand when a fight opens;
// an off-hand already holding something (a herder's wheat) is left as it is, since herd_executor owns putting it back.
async function readyShield(bot) {
  if (holdsShield(bot)) return true;
  const slot = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
  if (slot) return false;
  const shield = bot.inventory.items().find(it => it && it.name === 'shield');
  if (!shield) return false;
  await guardExternal(TAG, 'equip the shield to the off-hand', () => bot.equip(shield, 'off-hand'));
  return holdsShield(bot);
}

// swingNow(bot, entity, tag) — raw hit + clock stamp, in that order, never separated. Every swing goes
// through here or the clock lies about how long it should wait (Law 25). Range travels with the swing
// record, since an out-of-reach swing cannot land yet still spends the cooldown. The caller hands down
// its own tag: the strike belongs to the ordering seat, so the gunner's trace filter can find its own
// swings under its own name.

// swingDistance(bot, entity) → the player's reach measure: from the body's eyes to the nearest point of the target's
// box, null when a body is unreadable. A player strikes what lies within 3.0 b of its eyes, measured to the box, so a
// zombie on level ground is struck at about 3.3 b centre to centre, and its own blow reaches 1.5–2.0 b. Split out so
// the refusal gate and the journal read the same measurement, not two samples taken moments apart (Law 16).
// Unguarded: the two null checks are the guard — an unreadable body is a state to read, not an
// exception to catch, and null here means unreadable, never a guessed number.
const EYE_HEIGHT = 1.62;
function swingDistance(bot, entity) {
  if (!bot.entity?.position || !entity?.position) return null;
  return reachGap(bot, bot.entity.position, entity, entity.position);
}

// reachGap(bot, feet, entity, at) → the same measure taken from the body's feet at `feet` to the entity's box standing at
// `at`: swingDistance for any pair of positions, so a predicted position is measured exactly as a seen one is.
function reachGap(bot, feet, entity, at) {
  const me = feet;
  const eye = { x: me.x, y: me.y + (Number.isFinite(bot.entity && bot.entity.eyeHeight) ? bot.entity.eyeHeight : EYE_HEIGHT), z: me.z };
  const p = at;
  const half = (Number.isFinite(entity.width) && entity.width > 0 ? entity.width : 0.6) / 2;
  const tall = Number.isFinite(entity.height) && entity.height > 0 ? entity.height : 1.8;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dx = eye.x - clamp(eye.x, p.x - half, p.x + half);
  const dy = eye.y - clamp(eye.y, p.y, p.y + tall);
  const dz = eye.z - clamp(eye.z, p.z - half, p.z + half);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── A SWING THAT WOULD LAND ON A FRIEND IS NOT SENT ─────────────────────────────────────────────
// A charged sword hit sweeps: the server deals 1 damage to every living thing whose box meets the target's
// box grown 1.0 across and 0.25 up and down, within 3 blocks of the attacker, except the attacker's allies.
// Friendly fire is on, so a player beside the target is struck. SWEEP_MARGIN covers both bodies moving
// between this read and the server's tick.
const SWEEP_ACROSS = 1.0;
const SWEEP_UP = 0.25;
const SWEEP_ATTACKER_REACH = 3.0;
const SWEEP_MARGIN = 0.3;

// sweepFriend(bot, entity) → { name, d } for the first player a sword swing at `entity` would sweep, or null.
// Null for any hand that does not sweep.
function sweepFriend(bot, entity) {
  const held = bot.heldItem && bot.heldItem.name;
  if (!held || !/_sword$/.test(held)) return null;
  const me = bot.entity && bot.entity.position;
  const t = entity && entity.position;
  if (!me || !t) return null;
  const tw = (entity.width || BOT_WIDTH) / 2 + SWEEP_ACROSS + SWEEP_MARGIN;
  const tLow = t.y - SWEEP_UP - SWEEP_MARGIN;
  const tHigh = t.y + (entity.height || 1.8) + SWEEP_UP + SWEEP_MARGIN;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e === entity || e.type !== 'player' || !e.position) continue;
    const p = e.position;
    if (me.distanceTo(p) >= SWEEP_ATTACKER_REACH + SWEEP_MARGIN) continue;
    const pw = (e.width || BOT_WIDTH) / 2;
    if (Math.abs(p.x - t.x) > tw + pw || Math.abs(p.z - t.z) > tw + pw) continue;
    if (p.y > tHigh || p.y + (e.height || 1.8) < tLow) continue;
    return { name: e.username || e.name || `player#${e.id}`, d: Math.round(p.distanceTo(t) * 100) / 100 };
  }
  return null;
}

// One line per friend a run of withheld swings protects, not one per tick.
let _withheldFor = null;

// `judged`: the reach the caller judged the swing at, when it measured a predicted position (prediction_engine) rather
// than the last one the server reported. The gate below reads it in place of the seen measure; both ride the strike row.
function swingNow(bot, entity, tag, judged) {
  // A missing tag is a coding violation (Law 13): a silent fallback here would make a strike
  // unattributable at whichever call site forgot to pass one.
  if (!tag) throw new Error('[combat_utils] swingNow requires the ordering seat\'s tag — a strike belongs to whoever ordered it, not to this utility.');
  // Reach is a precondition, not a warning: a swing beyond reach cannot land, so it is refused before
  // the packet is sent. Gated here, not per-arm, since every melee swing funnels through this function
  // (Law 16). A refusal does not stamp the clock — nothing was spent, so the next pass may swing the
  // instant the mob is in reach.
  const seen = swingDistance(bot, entity);
  const d = Number.isFinite(judged) ? judged : seen;
  if (d != null && d > BOT_STRIKE_REACH) {
    watcher.warn(TAG,
      `🚫 swing REFUSED at ${d.toFixed(2)}b — beyond the ${BOT_STRIKE_REACH}b reach, so it could not land and would ` +
      `spend the cooldown for nothing. No packet sent and the swing clock is untouched; the arm may swing again ` +
      `the moment the body is inside reach.`);
    return false;
  }
  // A swing whose sweep would reach a player is not sent and spends nothing.
  const friend = sweepFriend(bot, entity);
  if (friend) {
    if (_withheldFor !== friend.name) {
      _withheldFor = friend.name;
      crewLog.event(tag, 'withheld', { subject: crewLog.subject(entity), friend: friend.name, friend_d: friend.d });
    }
    return false;
  }
  _withheldFor = null;
  // mineflayer can refuse an attack on an entity that left the table between the gate above and this
  // line. A refused swing spends nothing, so the clock is not stamped, same as a reach refusal (Law 25).
  if (!guardExternalSync(TAG, `attack ${entity && entity.name}`, () => bot.attack(entity)).ok) return false;
  _lastSwingAt = Date.now();
  _swings++;
  // `hp` is the target's health, the fleet's only view of it in this line. The bot's own health is
  // deliberately absent, since it changes on the mob's schedule, not the swing's. The field is often
  // absent — mineflayer does not reliably populate `entity.health` — and crew_log drops nulls for free.
  crewLog.event(tag, 'strike', {
    subject: crewLog.subject(entity),
    d: d == null ? null : d.toFixed(2),
    seen: Number.isFinite(judged) && seen != null ? seen.toFixed(2) : null,
    with: (bot.heldItem && bot.heldItem.name) || 'fists',
    hp: entity && typeof entity.health === 'number' ? entity.health.toFixed(1) : null,
  });
  // The ledger's swing, resolved by the server's hurt as a hit or a miss (combat_record).
  require('@api/combat_record').swing(entity, {
    seat: tag, d: d == null ? null : Math.round(d * 100) / 100,
    with: (bot.heldItem && bot.heldItem.name) || 'fists',
  });
  return true;
}

// ── THE SPRINT FLAG ──────────────────────────────────────────────────────────
// The driver arms sprint every approach tick; a plain setControlState('sprint', true) cannot be trusted
// after a hit.
//
// Java's Player.attack() ends a sprint attack with setSprinting(false) server-side; mineflayer's
// controlState.sprint stays true (bot.attack only writes use_entity), so a plain setControlState
// short-circuits on equal state and sends nothing — the body then sprints until the first swing and
// walks the rest with the flag still reading true. `armSprint` forces false-then-true: the
// redundant-looking `false` is the fix. It is synchronous by contract, since an await between the sprint
// and attack packets breaks the ordering Java's knockback check depends on — both go down one TCP stream
// in call order.
//
// prismarine-physics also adds a horizontal impulse in the facing direction when a jump starts under
// sprint; the gunner faces the mob, so a sprint-jump shoves the bot into it — driver.js taps jump only
// on a measured stall, never holds it.

const KNOCKBACK_SETTLE_MS = 400;   // long enough for a shove to play out before measuring it

// armSprint(bot) → true once the start_sprinting packet is written.
// Unguarded: setControlState only asserts on a bad control name or a non-boolean state, both literals
// here, so a wrapped guard could only ever fire on a defect and must travel (Law 13).
function armSprint(bot) {
  bot.setControlState('sprint', false);
  bot.setControlState('sprint', true);
  return true;
}

function releaseSprint(bot) {
  // Unguarded: setControlState's only throw is an assert on a bad control name or non-boolean state,
  // which would be our defect and must travel (Law 13).
  bot.setControlState('sprint', false);
}

// ── 8. THE TACTICS — the fleet's whole monster taxonomy ──────────────────────
// Every monster resolves to exactly one counter (Law 16): stand still and knock back what approaches,
// charge what kites, or stand and strike its shot back into it — everything else is a special case of one.
//
// The discriminator is one question: does it come to you? Walks/swims/flies/teleports into reach on its
// own ⇒ BRAWLER (standing still is free; the bot's own ground is the only verified ground). Holds range,
// retreats, or won't move ⇒ KITER (waiting is waiting forever, under fire). Holds range but its shot comes
// to you and a fist returns it ⇒ RETURNER (the ghast: the gunner returns the fireball, fireball_return, and a
// returned one kills it; the feet stand, since a body walking toward a ghast in the air reaches nothing).
//
// Hardcoded, not a file read: these are fixed strings. monster_tactics.json's `group` field is
// documentation only — a third counter reads the JSON, a fight reads this. Two monsters share a list
// only if the same counter, unmodified, works on both.
const COMBAT_TACTICS = {
  BRAWLER: 'BRAWLER',   // comes to the bot on its own. The driver sprints into it and keeps the shove.
  KITER:   'KITER',     // will not come, or backs away. A shove undoes the approach that earned it.
  RETURNER: 'RETURNER', // will not come, but its shot does and is struck back into it. The driver stands.
};

// Authored tactic→[names] (the shape a human edits); consumed name→tactic below (the shape a fight looks up).
const MONSTER_TACTICS = {
  // Comes on its own — met where the bot already stands. The creeper counts as BRAWLER: the zombie pass
  // and a shield while it swells beats it, since no movement-based counter can outrun the fuse. Swoopers
  // are let in, then knocked back; splitters are stood among their children once closed. A few names
  // here have no answer that beats them; not walking toward them is the least bad one.
  BRAWLER: [
    'zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider', 'endermite',
    'creeper',
    'wither_skeleton', 'vindicator', 'piglin_brute', 'hoglin', 'zoglin', 'zombified_piglin', 'piglin', 'polar_bear',
    'ravager', 'iron_golem',
    'silverfish', 'wolf', 'bee',
    'slime', 'magma_cube',
    'phantom',
    'vex',
    'enderman',
    'creaking',
    'warden', 'wither', 'ender_dragon',
  ],

  // Will not come; every second waiting is spent under fire. Archers and displacers are beaten by
  // closing the distance; casters spend the delay healing or summoning; turrets will not follow.
  KITER: [
    'skeleton', 'stray', 'bogged', 'pillager',
    'witch', 'evoker',
    'blaze', 'guardian', 'elder_guardian', 'shulker',
    'breeze',
  ],

  // Its shot is returned where the body stands: a punched ghast fireball flies back along the look and kills
  // the ghast outright (Ghast.isReflectedFireball; fireball_return, tested live in Worklog 825 and 827).
  RETURNER: [
    'ghast',
  ],
};

// Reverse index, built once at load.
const _TACTIC_OF = {};
for (const [tactic, names] of Object.entries(MONSTER_TACTICS)) {
  // A malformed tactic key is caught here at load, before it can fall through battle_stations'
  // dispatch and read as a targeting bug (Law 13).
  if (!COMBAT_TACTICS[tactic]) throw new Error(`[${TAG}] MONSTER_TACTICS names "${tactic}", which is not one of the built arms`);
  for (const n of names) {
    if (_TACTIC_OF[n]) {
      // A name in both lists ⇒ both arms claim it and key order decides — throw instead.
      throw new Error(`[${TAG}] "${n}" is listed under both ${_TACTIC_OF[n]} and ${tactic} — one monster, one tactic`);
    }
    _TACTIC_OF[n] = tactic;
  }
}

// combatTactic(entityName) → 'BRAWLER' | 'KITER' | 'RETURNER', or null for an unclaimed name — never a default. An
// absent name is environmental (modded, game-update, mislabelled passive) (Law 13), and the policy
// belongs to the caller. The driver's null policy is to brake: withholding a shove costs one approach,
// while shoving something that flees costs the engagement.
//
// Also the roster of known hostiles: camera's combat_witness and tools/combat_recorder test `!== null`
// directly; a separate membership set would be a second route that could drift (Law 16).
// `entity`, when given, lets the hand decide where the name alone cannot: a drowned holding a trident is a KITER.
function combatTactic(entityName, entity) {
  if (!entityName) return null;
  if (throwsTrident(entity) || wieldsSpear(entity)) return COMBAT_TACTICS.KITER;
  return _TACTIC_OF[String(entityName).toLowerCase()] || null;
}

// tacticRead(entityName, entity) → { tactic, by, hand }: the class combatTactic gives and what decided it, for the record.
// `by` is 'trident_in_hand' when the hand overruled the name, 'name' when the name alone did, null when unclaimed;
// `hand` is what the mob held when read. Every engage and focus row carries it, so a run says how each mob was fought.
function tacticRead(entityName, entity) {
  const tactic = combatTactic(entityName, entity);
  const by = !tactic ? null : throwsTrident(entity) ? 'trident_in_hand' : wieldsSpear(entity) ? 'spear_in_hand' : 'name';
  return { tactic, by, hand: (entity && entity.heldItem && entity.heldItem.name) || null };
}

// throwsTrident(entity) → a drowned with a trident in its main hand. It throws from where it stands every 40 ticks and
// holds its arm up (the "using an item" flag) the whole time it aims, through every throw: no release ends that draw,
// so it is never a notched arrow. A drowned with an empty hand walks in and strikes like a zombie.
function throwsTrident(entity) {
  return !!entity && entity.name === 'drowned' && !!entity.heldItem && entity.heldItem.name === 'trident';
}

// wieldsSpear(entity) → any mob with a spear in its main hand. It holds the spear's charge raised (the "using an item"
// flag) the whole time it closes and strikes, and its charged blow reaches past a zombie's arm (5.2 a blow at 2.6-2.7 b),
// beyond the hit-and-back's band. It is fought as the trident drowned is: a KITER, closed on and struck, its blows taken on
// the raised shield between swings.
const SPEAR = /_spear$/;
// nearestLava(bot) → { d, at } for the lava block nearest the body within LAVA_SCAN_B across and LAVA_SCAN_DY up or down,
// or null when none is there. For the record of a fire blow: lava lights the ground about it, so how near the nearest lava
// stands says whether the fire came from a pool.
const LAVA_SCAN_B = 10;
const LAVA_SCAN_DY = 4;
function nearestLava(bot) {
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  const Vec3 = require('vec3');
  const bx = Math.floor(me.x), by = Math.floor(me.y), bz = Math.floor(me.z);
  let best = null;
  for (let dx = -LAVA_SCAN_B; dx <= LAVA_SCAN_B; dx++) for (let dz = -LAVA_SCAN_B; dz <= LAVA_SCAN_B; dz++) for (let dy = -LAVA_SCAN_DY; dy <= LAVA_SCAN_DY; dy++) {
    const b = bot.blockAt(new Vec3(bx + dx, by + dy, bz + dz));
    if (!b || (b.name !== 'lava' && b.name !== 'flowing_lava')) continue;
    const d = Math.hypot(bx + dx + 0.5 - me.x, by + dy - me.y, bz + dz + 0.5 - me.z);
    if (!best || d < best.d) best = { d, at: `${bx + dx},${by + dy},${bz + dz}` };
  }
  return best;
}
function wieldsSpear(entity) {
  return !!entity && !!entity.heldItem && SPEAR.test(entity.heldItem.name || '');
}
// THE SPEAR CADENCE: a spear wielder is met behind the guard, raised at once, lowered for each charged swing and raised
// again. Its blow is stopped by the raised shield; with the shield down it lands 3-9 a blow, so the guard never waits
// for its first blow and never stays down after it.
// raisesThroughStrikes(entity) → a mob whose raised hand stays raised through every blow it deals (a trident drowned, a
// spear wielder): no lowered hand marks a release, so its guard is up at once and the arm swings between its blows.
function raisesThroughStrikes(entity) { return throwsTrident(entity) || wieldsSpear(entity); }

// ── WHAT THE SHIELD IS FOR ──────────────────────────────────────────────────────────────────────────────
// The shield blocks what is shot and the blast a blast wall missed (gunner); it is never raised to a melee blow, which the
// body answers with the hit-and-back and the knockback swing (driver). shieldStops(entity) → a KITER whose shot a raised
// shield stops: an arrow, a trident, a fireball. Not a witch: its potions break on the body whatever it holds up, and
// the hand it raises is the one it drinks with, so it is closed on and struck like a brawler. Nor an evoker: its fangs
// rise from the ground.
const SHIELD_PASSES = new Set(['witch', 'evoker']);

// ── A MOB THAT HEALS ITSELF IS FINISHED ─────────────────────────────────────────────────────────────────────
// A witch drinks healing when hurt, so damage spread over two of them undoes itself: the body's focus stays on the one it
// picked until it is dead (commander FOCUS) and the arm strikes it whenever it stands in reach (gunner THE SWING TARGET).
const SELF_HEALERS = new Set(['witch']);
function healsItself(name) { return SELF_HEALERS.has(name); }

// fieldAheadOn(active) → whether this body fights the field by its price (driver THE FIELD AHEAD) and raises its guard
// facing every shooter, not only the one drawing (gunner guardBearing): true only for a body whose designation carries
// engine A (designations ENGINES: the T-1A) AND only while a player stands in the field. THE ENGINE IS FOR HUMAN PLAYERS:
// against monsters the T-1A fights the original way, as the T-1 does. threat_scanner.isHostile names no player today, so
// no fight holds one and the engine stays quiet until the fleet fights players.
function fieldAheadOn(active) {
  return require('@api/combat_board').engine() === 'A' && (active || []).some((h) => h && h.entity && h.entity.type === 'player');
}

// witchOnly(focus) → whether this body fights nothing but the witch now: a terminator (designation T) whose chase target
// heals itself. THE WITCH IS KILLED FIRST AND ALONE: the arm strikes no other mob but a creeper in reach (gunner
// swingTarget) and the feet walk straight on and stay on her, circling her away from the nearest melee mob (driver THE
// PRESS). A swelling creeper is met with the raised shield; only a body with no shield and no block backs off (Law 17).
function witchOnly(focus) {
  return !!focus && healsItself(focus.name) && require('@api/combat_board').isTerminator();
}

// ── WHAT THE BODY CARRIES ───────────────────────────────────────────────────────────────────────────────
// activeEffects(bot) → [{ name, amp }]: every status effect the server says the body carries now, named off the live
// registry (Law 23), `amp` the amplifier (0 = level I). A witch's poison, weakness and slowness are read here.
function activeEffects(bot) {
  const effects = (bot && bot.entity && bot.entity.effects) || {};
  const rows = [];
  for (const e of Object.values(effects)) {
    const row = e && bot.registry && bot.registry.effects && bot.registry.effects[e.id];
    if (row) rows.push({ name: String(row.name).toLowerCase(), amp: typeof e.amplifier === 'number' ? e.amplifier : 0 });
  }
  return rows;
}
// strikesRepeatedly(name) → a melee mob that strikes again and again. A creeper strikes once, by blowing up: it is fought,
// but never made the anchor of a line-up (commander THE FLANK).
const ONE_BLOW = new Set(['creeper']);
function strikesRepeatedly(name) { return !ONE_BLOW.has(name); }
function shieldStops(entity) {
  return !!entity && !SHIELD_PASSES.has(entity.name) && combatTactic(entity.name, entity) === COMBAT_TACTICS.KITER;
}

// endermanAngry(bot, entity) → true only when the server flags this enderman `creepy`: angry and screaming at a
// target. The index is read from the live registry, as archer_calculator reads a draw; an unread field is not anger.
function endermanAngry(bot, entity) {
  if (!entity || entity.name !== 'enderman' || !Array.isArray(entity.metadata)) return false;
  const row = bot && bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName.enderman;
  const idx = row && Array.isArray(row.metadataKeys) ? row.metadataKeys.indexOf('creepy') : -1;
  return idx >= 0 && entity.metadata[idx] === true;
}

// The neutrals, separate from the tactic table: tactics answer how to fight something, this answers
// whether there is a fight at all (each is inert until the bot acts). An unprovoked iron golem and one
// already swinging want opposite behaviour, so the two questions cannot share one answer.
const NEVER_INITIATE = new Set([
  'zombified_piglin',    // one hit aggros every piglin in a radius larger than the scan
  'piglin',              // and gold armour prevents it outright, which is a counter with no combat in it
  'iron_golem',          // village property; killing one is also a social act the fleet has not modelled
  'wolf', 'polar_bear', 'bee',
]);

// shouldInitiate(entityName) → false only for names the bot should never swing at first. The T-1 hunt reads it
// (test_module quarry); no fight path does yet — declining to attack is a counter of its own. Exported so that counter does not
// invent a second list (Law 16).
function shouldInitiate(entityName) {
  if (!entityName) return true;
  return !NEVER_INITIATE.has(String(entityName).toLowerCase());
}

// A TERMINATOR TAKES THE PACK. A terminator (designation T, combat_board.isTerminator) is built to clear what it meets, the
// pack a struck zombified piglin calls included, so these neutrals are fought by sight and hunted on its march; a worker
// still leaves them be.
const TERMINATOR_TAKES = new Set(['piglin', 'zombified_piglin']);
// terminatorTakes(entityName) → true for a neutral a body in a terminator kit fights on sight.
function terminatorTakes(entityName) {
  return !!entityName && TERMINATOR_TAKES.has(String(entityName).toLowerCase());
}

module.exports = {
  BOT_STRIKE_REACH, BOT_WIDTH,
  sweepFriend,
  activeEffects,
  healsItself,
  fieldAheadOn,
  witchOnly,

  // The one live swing route is `swingNow`, called by `gunner.fire`; sprint stays armed through the
  // driver's approach, read by `swingNow` at resolve time.
  armSprint,
  releaseSprint,

  // The two tactics, and the roster of known hostiles built from them.
  COMBAT_TACTICS,
  MONSTER_TACTICS,
  combatTactic,
  tacticRead,
  throwsTrident,
  shieldStops,
  wieldsSpear,
  nearestLava, LAVA_SCAN_B,
  raisesThroughStrikes,
  strikesRepeatedly,
  endermanAngry,
  NEVER_INITIATE,
  shouldInitiate,
  terminatorTakes,

  // Weapon selection
  pickBestWeapon,
  heldWeaponName,
  equipBestWeapon,
  holdsShield,
  readyShield,

  // The swing clock — one clock, and `swingNow` is the one thing that stamps it
  swingClock,
  chargeNow,
  msSinceLastSwing,
  noteEquip,
  swingNow,
  // Exported so a journal row records the same sample the reach gate judged, not its own later one.
  swingDistance, reachGap,

  // Exported so a caller taking the shove after the primitive waits the same interval, or it is
  // measuring a different quantity under the same name.
  KNOCKBACK_SETTLE_MS,

  // Test seam
  _resetSwingClock,
};
