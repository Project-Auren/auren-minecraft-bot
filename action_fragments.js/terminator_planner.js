// fragment: terminator_planner — A TERMINATOR'S PLANNING TURN, IN PLACE OF THE JOB BOARD.
//
// A body designated T (Thinking_fragments/designations) plans here: recursive_judge reads the designation's planner and
// passes every planning turn to it. One turn takes one step and reports back to the judge, so every loop check the job
// board's turns pass still judges this one. A fight takes the body as it takes any body (battle stations); when it ends
// the judge hands the next turn back here.
//
// THE FOREMAN CONTROLS THE BOARD; THE T-1 EXECUTES ITS LIST. The foreman's threat board (foreman/threat_board) keeps every
// threat round the base and every call, and orders each T-1's own list: calls first, then threats, nearest first. This
// planner takes the first key of its list as it stands (board) and says in its chair which target it holds and, when done,
// which and why (sayTarget), so the board leaves it off another T-1's list and passes one finished without a kill.
//
// A TURN WITH A TARGET IN HAND: ONE TARGET AT A TIME, FINISHED BEFORE THE NEXT. The T-1 works its targets as a bot works its
// jobs: a target is taken off the list (TARGET), worked leg after leg, and only when it is finished is the list read again,
// as a bot replans when a task ends. While a target is in hand the turn wears, eats when hungry, and walks the next leg; no
// chest trip, refill or newer target breaks into it, a call for help included: the mob it is after is already dangerous.
// A target is finished when its mob is dead or its termination ended, off the board (the foreman saw it die or leave the zone),
// gone where the body stands, the walk could not reach it, TARGET_LEGS legs found no fight, or TARGET_MAX_MS passed
// (targetDone).
//
// A TURN WITH NO TARGET IN HAND, IN ORDER (the first that applies is the turn's step):
//   1. WEAR    what the pocket holds goes on first: the best armour piece of each kind (armor.wearArmor) and the shield in
//              the off-hand (combat_utils.readyShield). A spare piece carried replaces a broken one with no trip home.
//   2. FLOOR   the kit's floor (terminator_kits: every armour piece, the sword, the shield, food): a part below it is taken
//              from the chests, the best the chests hold up to the ceiling; a shield is made from a banked iron ingot when
//              none is banked; bread is baked from wheat when no food is. AN ARMOUR PIECE NO CHEST HOLDS IS CRAFTED FROM ITS
//              INGOTS AND PUT ON AT ONCE, the floor's tier first (copper before iron): nothing is crafted to be put back in a
//              barrel. The ingots come from the pocket, then the chests, then the output of a furnace cooking them
//              (station_registry.cookedOf, taken through furnace_executor.collectOutput); what the set no longer needs is
//              banked after the craft. The floor is read as one set (floorUnmet): every piece the body lacks must be paid
//              for out of the same ingots, so the seat is offered only when the whole set's ingots are there. THE KIT GOES BEFORE THE CHESTS' MINIMUMS: the take
//              goes through the withdrawal door (inventory_swapper.retrieveItems), which honours other bodies' claims and
//              no stock row's minimum, for the kit and food only. A floor the chests cannot lift STEPS THE BODY DOWN: its
//              designation is dropped, and the judge's next read sends it to the job board as a bot.
//   3. EAT     hungry (architect_config.HUNGER_EAT_THRESHOLD), it eats what it carries.
//   4. RAISE   a part below the ceiling is raised when the chests hold a better one; food is topped back up to the kit's
//              `want` as soon as one is eaten (a T-1 carries 2: it keeps the base, and the chests are near).
//   5. TRASH   planks under TRAVEL_TRASH_LOW are dug back up (refill).
//   6. TARGET  THE BODY MOVES ONLY WITH PURPOSE. The first key of its list on the foreman's board is taken in hand. A call
//              heads the list; taking one, the T-1 holds it with the help line, and the T-2 holding the mob is relieved when the
//              T-1 reaches it (help_line.checkRelief). A fight that opens takes the body; when it ends the target in hand is
//              read again.
//   7. POST    with no target, it idles and reads its list every POST_LOOK_MS, and takes the first key that appears. For TERMINATOR_POSTS.after_battle_ms after a battle of its own it holds
//              the open ground nearest that battle, in case it comes back; else it idles at the crew's park spot
//              (idle_park.parkSpot). The battle ledger counts every battle to its nearest anchor as a record; it chooses
//              no post. It never walks a round (postOf, holdPost).
// On a peaceful world no monster spawns, so there is nothing to terminate: the body steps down.
// THE SEAT IS TAKEN BY THE SAME READING THAT GIVES IT UP: a bot is offered the crew's terminator seat only while every part of
// the floor it lacks can come from the chests (floorUnmet, assessors/terminator_duty), and a terminator steps down when one
// cannot (step 2).
//
// Logged as T_GEAR, T_STEP_DOWN, T_ATE, T_REFILL, T_TARGET, T_TARGET_LEG, T_TARGET_DONE and T_POST.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'terminator_planner';

// THE HUNT
const HUNT_RANGE = 48;           // blocks: the farthest hostile hunted from where the body stands
const HUNT_DY = 8;               // a hostile further above or below than this is in a cave or on a cliff: not hunted
const HUNT_SKIP_MS = 60000;      // the T-1 march's quarry passes over a mob it could not close on this long
const FINISH_HOLD_MS = 3000;     // a key just finished is not taken again before the board has read the finish
const TARGET_MAX_MS = 180000;    // a target held longer than this is finished: the mob has outrun the body
const TARGET_LEGS = 8;           // walks toward one target that open no fight before it is finished
const ARRIVE_B = 6;              // a target whose mob is not seen within this of where it was is gone
const HUNT_PASS = new Set(['phantom']);   // never provoked by a body walking up: a hunt would circle it
// THE TARGETS AND THE POST
const POST_REACH = 4;            // within this of its post's stand the body holds it
const POST_HOLD_MS = 30000;      // one hold of the post, ended early by a target
const POST_LOOK_MS = 1000;       // how often a body holding its post looks for a target
// THE KIT
const FETCH_SKIP_MS = 120000;    // an item the chests failed to give is not asked for again this long
const REFILL_STEPS = 96;         // cells dug at most in one refill of trash
const REFILL_SKIP_MS = 120000;   // a refill that dug nothing is not tried again this long: the ground round it gave none
const BREAD_WHEAT = 3;           // wheat in one bread (crafting_blueprints bread)
const TORCHES_PER_LUMP = 4;      // torches from one coal or charcoal (crafting_blueprints torch)

const _fetchFailed = new Map();  // item → until when the chests are not asked for it
let _current = null;             // the target in hand: { source, name, id, key, pos, began, legs }, held until it is finished
const _justFinished = new Map(); // key → until when it is left off the list read here (FINISH_HOLD_MS)
let _holds = 0;                  // holds of the post so far, numbered in their outcomes
let _refillIdleUntil = 0;        // until when a refill that dug nothing is passed over
let _groundLoaded = false;       // the ground round the body has loaded once: a post read before it finds no ground

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const at = (p) => `(${Math.floor(p.x)},${Math.floor(p.z)})`;

// ── THE KIT, READ OFF THE BODY ────────────────────────────────────────────────────────────────────────

function foodNames() { return require('@utils/fragment_utils').group_to_item.food; }
function pocketCount(bot, test) {
  return bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0);
}
const swordRank = (name) => require('@thinking/terminator_kits').SWORD_TIERS.indexOf(String(name).replace(/_sword$/, ''));

// gearOf(bot, kit) → the body's kit against its range: each armour kind's worn piece and rank, the best sword carried, the
// shield, the food, and the parts below the floor (`short`) and below the ceiling (`raise`).
function gearOf(bot, kit) {
  const armor = require('@api/armor');
  const { ARMOR } = require('@thinking/architect_config');
  const { SWORD_TIERS } = require('@thinking/terminator_kits');
  const { holdsShield } = require('@utils/combat_utils');
  const short = [];
  const raise = [];
  const armour = {};
  const floorA = ARMOR.tiers.indexOf(kit.armour[0]);
  const ceilA = ARMOR.tiers.indexOf(kit.armour[kit.armour.length - 1]);
  for (const [kind, slot] of Object.entries(armor.SLOT_OF)) {
    const w = armor.worn(bot, slot);
    const piece = w ? armor.armorPiece(w.name) : null;
    const rank = piece ? piece.rank : -1;
    armour[kind] = { name: w ? w.name : 'none', rank };
    if (rank < floorA) short.push(kind);
    else if (rank < ceilA) raise.push(kind);
  }
  const swords = bot.inventory.items().filter((i) => /_sword$/.test(i.name) && swordRank(i.name) >= 0);
  const best = swords.sort((a, b) => swordRank(b.name) - swordRank(a.name))[0] || null;
  const rankS = best ? swordRank(best.name) : -1;
  if (rankS < SWORD_TIERS.indexOf(kit.sword[0])) short.push('sword');
  else if (rankS < SWORD_TIERS.indexOf(kit.sword[kit.sword.length - 1])) raise.push('sword');
  const shield = holdsShield(bot) || bot.inventory.items().some((i) => i.name === 'shield');
  if (!shield) short.push('shield');
  const foods = new Set(foodNames());
  const food = pocketCount(bot, (n) => foods.has(n));
  if (food < kit.food.least) short.push('food');
  else if (food < kit.food.want) raise.push('food');
  // Torches are never a floor: carried for lighting, topped up to `want` between targets.
  const torches = pocketCount(bot, (n) => n === 'torch');
  if (torches < kit.torches.want && !(_fetchFailed.get('torch') > Date.now())) raise.push('torch');
  return { armour, sword: best ? best.name : 'none', swordRank: rankS, shield, food, torches, short, raise };
}

// gearLine(gear) → the kit as one log field set.
function gearLine(gear) {
  return `worn=${Object.values(gear.armour).map((a) => a.name).join(',')} sword=${gear.sword} shield=${gear.shield} food=${gear.food} torches=${gear.torches}`;
}

// ── THE KIT, TAKEN FROM THE CHESTS ────────────────────────────────────────────────────────────────────

// banked(item) → how many the chests hold that no other body has claimed (chest_ledger), 0 while the item lately failed.
function banked(item) {
  const until = _fetchFailed.get(item);
  if (until && Date.now() < until) return 0;
  return require('@perception/chest_ledger').unclaimedOf([item]);
}

// madeFrom(item) → { item, n }: the one ingredient an armour piece is crafted from and how many (the recipe book), or
// null when it is crafted from more than one or not at a table (netherite is smithed).
function madeFrom(item) {
  const r = require('@kernel/crafting_blueprint_registry').tryGetRecipe(item);
  const ins = r && r.ingredients ? Object.entries(r.ingredients) : [];
  return ins.length === 1 ? { item: ins[0][0], n: ins[0][1] } : null;
}

// ingotsFor(bot, item) → what the body could have of `item` to craft with: in the pocket, banked unclaimed, and cooked in
// the furnaces by their clocks, with the furnace holding the most.
function ingotsFor(bot, item) {
  const ovens = require('@perception/station_registry').cookedOf(item);
  return { pocket: pocketCount(bot, (n) => n === item), bank: banked(item), oven: ovens.reduce((s, o) => s + o.cooked, 0), best: ovens[0] || null };
}

// fetchFor(bot, kit, gear, part, above, floor) → the step that gets `part` above rank `above`, or null when the chests cannot:
// { take, n } a withdrawal, { take, n, then } a withdrawal crafted into `then`, { craft, goal } a craft from the pocket, or
// { collect, from, need, then } a furnace's output taken and crafted into `then`. `floor` ({ spent }) reads a part below the
// floor: an armour piece no chest holds may be crafted from its ingots, out of what the parts read before it have not
// spent; a raise never crafts armour (the surplus-iron sets are the chests' own rows).
function fetchFor(bot, kit, gear, part, above, floor = null) {
  const { ARMOR } = require('@thinking/architect_config');
  const { SWORD_TIERS } = require('@thinking/terminator_kits');
  if (part === 'sword') {
    for (const tier of [...kit.sword].reverse()) {
      if (SWORD_TIERS.indexOf(tier) > above && banked(`${tier}_sword`) > 0) return { take: `${tier}_sword`, n: 1 };
    }
    return null;
  }
  if (part === 'shield') {
    if (banked('shield') > 0) return { take: 'shield', n: 1 };
    if (banked('iron_ingot') > 0) return { take: 'iron_ingot', n: 1, then: { craft: 'shield', goal: 1 } };
    return null;
  }
  if (part === 'torch') {
    // Banked torches first; else coal or charcoal (4 torches a lump), the sticks made from the planks every body carries.
    const want = kit.torches.want - gear.torches;
    if (banked('torch') > 0) return { take: 'torch', n: Math.min(want, banked('torch')) };
    const lumps = Math.ceil(want / TORCHES_PER_LUMP);
    for (const fuel of ['coal', 'charcoal']) {
      const held = pocketCount(bot, (n) => n === fuel);
      if (held > 0) return { craft: 'torch', goal: gear.torches + Math.min(want, held * TORCHES_PER_LUMP) };
      const b = banked(fuel);
      if (b > 0) { const k = Math.min(lumps, b); return { take: fuel, n: k, then: { craft: 'torch', goal: gear.torches + k * TORCHES_PER_LUMP } }; }
    }
    return null;
  }
  if (part === 'food') {
    const want = kit.food.want - gear.food;
    const wheat = pocketCount(bot, (n) => n === 'wheat');
    const bread = pocketCount(bot, (n) => n === 'bread');
    if (wheat >= BREAD_WHEAT) return { craft: 'bread', goal: bread + Math.min(want, Math.floor(wheat / BREAD_WHEAT)) };
    // Bread first, the farm's food; then any food the chests hold, the most first.
    const offered = foodNames().map((name) => ({ name, n: banked(name) })).filter((f) => f.n > 0)
      .sort((a, b) => (b.name === 'bread') - (a.name === 'bread') || b.n - a.n);
    if (offered.length) return { take: offered[0].name, n: Math.min(want, offered[0].n) };
    const wheatBanked = banked('wheat');
    if (wheatBanked >= BREAD_WHEAT) {
      const loaves = Math.min(want, Math.floor(wheatBanked / BREAD_WHEAT));
      return { take: 'wheat', n: loaves * BREAD_WHEAT, then: { craft: 'bread', goal: bread + loaves } };
    }
    return null;
  }
  for (const tier of [...kit.armour].reverse()) {
    if (ARMOR.tiers.indexOf(tier) > above && banked(`${tier}_${part}`) > 0) return { take: `${tier}_${part}`, n: 1 };
  }
  if (!floor) return null;
  for (const tier of kit.armour) {
    const piece = `${tier}_${part}`;
    const m = ARMOR.tiers.indexOf(tier) > above && !(_fetchFailed.get(piece) > Date.now()) ? madeFrom(piece) : null;
    if (!m) continue;
    const have = ingotsFor(bot, m.item);
    const spent = floor.spent.get(m.item) || 0;
    if (have.pocket + have.bank + have.oven - spent < m.n) continue;
    floor.spent.set(m.item, spent + m.n);
    const then = { craft: piece, goal: 1, tier };
    if (have.pocket >= m.n) return { ...then };
    if (have.pocket + have.bank >= m.n) return { take: m.item, n: m.n - have.pocket, then };
    return { collect: m.item, from: have.best.id, need: m.n, then };
  }
  return null;
}

// rankOf(gear, part) → the part's rank now, the bar a fetch must clear.
function rankOf(gear, part) {
  if (part === 'sword') return gear.swordRank;
  if (part === 'shield' || part === 'food' || part === 'torch') return -1;
  return gear.armour[part].rank;
}

// fetch(bot, step) → the readable of the step taken, or undefined when a door abandoned the chain to the judge (Law 15).
async function fetch(bot, part, step) {
  const { retrieveItems } = require('@api/inventory_swapper');
  const { craftItems } = require('@api/craft_handler');
  let moved = 0;
  if (step.collect) {
    // A FURNACE'S OUTPUT, TAKEN TO BE USED: the whole output slot comes out, the piece is crafted at once, and what the set
    // no longer needs is banked below.
    const r = await require('@action/furnace_executor').collectOutput(bot, step.from, step.collect);
    moved = r.taken || 0;
    watcher.summary(TAG, `T_GEAR part=${part} collect=${step.collect} from=${step.from} got=${moved}${r.ok ? '' : ` why=${r.reason}`}`);
    const rest = step.need - pocketCount(bot, (n) => n === step.collect);
    if (rest > 0 && banked(step.collect) >= rest) {
      const got = await retrieveItems(bot, step.collect, rest);
      if (got === undefined) return undefined;
    }
    if (pocketCount(bot, (n) => n === step.collect) < step.need) {
      _fetchFailed.set(step.then.craft, Date.now() + FETCH_SKIP_MS);
      return { readable: `${TAG}: the furnace gave ${moved} ${step.collect}, short of the ${step.need} the ${step.then.craft} takes`, moved };
    }
  }
  if (step.take) {
    const got = await retrieveItems(bot, step.take, step.n);
    if (got === undefined) return undefined;
    moved = got && got.transferred > 0 ? got.transferred : 0;
    if (!moved) {
      _fetchFailed.set(step.take, Date.now() + FETCH_SKIP_MS);
      watcher.summary(TAG, `T_GEAR part=${part} take=${step.take} asked=${step.n} got=0 — not asked again for ${FETCH_SKIP_MS / 1000}s`);
      return { readable: `${TAG}: the chests gave no ${step.take} for the ${part}`, moved: 0 };
    }
  }
  const craft = step.craft ? step : step.then;
  let made = null;
  if (craft) {
    const held = pocketCount(bot, (n) => n === craft.craft);
    const r = await craftItems(bot, craft.craft, Math.max(craft.goal, held + 1));
    if (r === undefined) return undefined;
    made = pocketCount(bot, (n) => n === craft.craft) - held;
    // A craft that made nothing would make nothing again from the same pocket: the part is not asked for again for a while.
    if (made <= 0) _fetchFailed.set(craft.craft, Date.now() + FETCH_SKIP_MS);
  }
  // THE INGOTS THE SET NO LONGER NEEDS GO TO THE CHESTS, not carried: the pieces still short at this tier are counted.
  const material = craft && craft.tier ? madeFrom(craft.craft) : null;
  if (material) {
    await require('@api/armor').wearArmor(bot);
    const g = gearOf(bot, kitOfThisBody());
    const owed = g.short.map((p) => madeFrom(`${craft.tier}_${p}`)).filter((x) => x && x.item === material.item).reduce((s, x) => s + x.n, 0);
    const spare = pocketCount(bot, (n) => n === material.item) - owed;
    if (spare > 0) {
      const put = await require('@api/inventory_swapper').depositItems(bot, material.item, spare);
      if (put === undefined) return undefined;
      watcher.summary(TAG, `T_GEAR banked=${material.item} n=${spare} still_owed=${owed}`);
    }
  }
  await require('@api/armor').wearArmor(bot);
  await require('@utils/combat_utils').readyShield(bot);
  watcher.summary(TAG, `T_GEAR part=${part}${step.collect ? ` collect=${step.collect} got=${moved}` : ''}${step.take ? ` take=${step.take} got=${moved}` : ''}${craft ? ` craft=${craft.craft} made=${made}` : ''}`
    + ` ${gearLine(gearOf(bot, kitOfThisBody()))}`);
  return { readable: `${TAG}: ${part} — ${step.take ? `took ${moved} ${step.take}` : ''}${step.take && craft ? ', ' : ''}${craft ? `made ${made} ${craft.craft}` : ''}`, moved };
}

function kitOfThisBody() {
  const { parse } = require('@thinking/designations');
  return require('@thinking/terminator_kits').kitNamed(parse(require('@api/combat_board').designation()).kit);
}

// floorUnmet(bot, kitName) → the parts of the kit's floor this body lacks that the chests cannot lift: empty when the body
// holds the floor or the chests can make it up. The seat is posted on it (assessors/terminator_duty); step 2 steps down on it.
function floorUnmet(bot, kitName) {
  const kit = require('@thinking/terminator_kits').kitNamed(kitName);
  const gear = gearOf(bot, kit);
  const floor = { spent: new Map() };
  return gear.short.filter((part) => !fetchFor(bot, kit, gear, part, rankOf(gear, part), floor));
}

// stepDown(why) → the readable: the designation is dropped; the judge's next read sends the body to the job board.
function stepDown(bot, gear, why) {
  const board = require('@api/combat_board');
  const was = board.designation();
  board.designate(null);
  if (_current) sayTarget({ t_target: null });
  _current = null;
  watcher.summary(TAG, `T_STEP_DOWN designation=${was} why=${why} ${gear ? gearLine(gear) : ''} at=${at(bot.entity.position)}`);
  return `${TAG}: ${was} stepped down to ${board.designation()} (${why})`;
}

// ── THE HUNT ──────────────────────────────────────────────────────────────────────────────────────────

// quarry(bot, skipped, reach?) → the nearest hostile the hunt may go after now, or null: within HUNT_RANGE across and HUNT_DY
// up or down, not in water, not one HUNT_PASS names, not one `skipped` holds, and, when `reach` is given, one it accepts
// (a test's own reach). Shared with the T-1 march (test_module), which hunts with no base and no foreman's board.
function quarry(bot, skipped, reach = null) {
  const { isHostile } = require('@perception/threat_scanner');
  const { shouldInitiate, terminatorTakes } = require('@utils/combat_utils');
  const me = bot.entity.position;
  let best = null, bestD = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !isHostile(e) || HUNT_PASS.has(String(e.name))) continue;
    // A neutral the fleet never swings at first (combat_utils NEVER_INITIATE) is never walked up to either: the commander
    // declines it, so the hunt would only circle it. The pack a terminator takes (combat_utils TERMINATOR_TAKES) is hunted.
    if (!shouldInitiate(e.name) && !terminatorTakes(e.name)) continue;
    const skip = skipped.get(e.id);
    if (skip && Date.now() < skip) continue;
    if (Math.abs(e.position.y - me.y) > HUNT_DY) continue;
    if (reach && !reach(e.position)) continue;
    const d = flat(e.position, me);
    if (d > HUNT_RANGE || d >= bestD) continue;
    const cell = bot.blockAt(e.position.floored());
    if (cell && (cell.name === 'water' || cell.name === 'flowing_water')) continue;
    best = e; bestD = d;
  }
  return best ? { e: best, d: bestD } : null;
}

// refill(bot, tag) → digs trash back up to TRAVEL_TRASH when the pocket is under TRAVEL_TRASH_LOW (navigator.gatherScaffold);
// true when it dug. Shared with the T-1 march (test_module).
async function refill(bot, tag) {
  const { TRAVEL_TRASH, TRAVEL_TRASH_LOW } = require('@thinking/terminator_kits');
  const nav = require('@locomotion/navigator');
  const had = nav.scaffoldCarried(bot);
  if (had >= TRAVEL_TRASH_LOW || Date.now() < _refillIdleUntil) return false;
  const got = await nav.gatherScaffold(bot, TRAVEL_TRASH - had, { maxSteps: REFILL_STEPS });
  const p = bot.entity.position;
  watcher.summary(tag, `${tag === TAG ? 'T' : 'T1'}_REFILL had=${had} got=${got} now=${nav.scaffoldCarried(bot)} at=(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`);
  // A refill that dug nothing would dig nothing again from the same ground: the turn goes on, and the refill waits.
  if (got > 0) return true;
  _refillIdleUntil = Date.now() + REFILL_SKIP_MS;
  return false;
}

// ── TARGETS AND THE POST ──────────────────────────────────────────────────────────────────────────────

// listed() → the foreman's threat board as this body holds it (keeper_verdicts `threats`), or null when the body has none.
function listed() {
  return require('@kernel/keeper_verdicts').get('threats');
}

// board(bot) → this T-1's list on the foreman's board, in the board's order, each { key, source, name, id, pos, d, call,
// caller }. The key this body just finished is left out until the board has read it (FINISH_HOLD_MS), so the body does
// not take it again from a list sent before its word arrived.
function board(bot) {
  const v = listed();
  if (!v || !v.lists) return [];
  const me = process.env.BOT_ID || 'default';
  const byKey = new Map((v.targets || []).map((t) => [t.key, t]));
  const now = Date.now();
  return (v.lists[me] || []).map((k) => byKey.get(k)).filter((t) => t && t.pos && !(_justFinished.get(t.key) > now))
    .map((t) => ({ key: t.key, source: t.source, name: t.name, id: t.id, pos: t.pos, call: t.call, caller: t.caller, d: flat(t.pos, bot.entity.position) }));
}

// targetDone(bot, cur) → why the target in hand is finished, or null while it is still to work. Its place is renewed from the
// mob when the body sees it, else from the board.
function targetDone(bot, cur) {
  if (Date.now() - cur.began > TARGET_MAX_MS) return 'timeout';
  const end = require('@api/combat_board').terminationEnd(cur.id);
  if (end) return `ended:${String(end.why).replace(/\s+/g, '_')}`;
  const e = bot.entities[cur.id];
  if (e && e.position) { cur.pos = e.position.clone(); return null; }
  const v = listed();
  const on = v && (v.targets || []).find((t) => t.key === cur.key);
  if (v && !on) return 'gone:off_the_board';
  if (on && on.pos) cur.pos = on.pos;
  return flat(bot.entity.position, cur.pos) <= ARRIVE_B ? 'gone' : null;
}

// sayTarget(fields) — this T-1's chair says which target it holds (`t_target`) and which it finished and why
// (`t_finished`), and goes to the foreman at once: the board keeps the target off another T-1's list and passes one
// finished without a kill.
function sayTarget(fields) {
  const hq = require('@kernel/corporate_headquarters');
  const me = process.env.BOT_ID || 'default';
  hq.writeBoardroomChair(me, { ...(hq.readBoardroomChair(me, {}) || {}), ...fields });
  require('@utils/external_library_guard').guardExternalSync(TAG, 'send the target in hand', () => require('@kernel/foreman_link').sendUpdate());
}

// finish(bot, why) — the target in hand is done; the list is read on the next turn.
function finish(bot, why) {
  const cur = _current;
  _current = null;
  _justFinished.set(cur.key, Date.now() + FINISH_HOLD_MS);
  if (cur.source === 'called') require('@api/help_line').dropSummon(cur.id);
  sayTarget({ t_target: null, t_finished: { key: cur.key, why, at: Date.now() } });
  watcher.summary(TAG, `T_TARGET_DONE source=${cur.source} target=${cur.name}#${cur.id} why=${why} legs=${cur.legs} held_s=${Math.round((Date.now() - cur.began) / 1000)} at=${at(bot.entity.position)}`);
  return `${TAG}: ${cur.source} ${cur.name}#${cur.id} finished (${why})`;
}

// leg(bot) → the readable: one walk toward the target in hand. A fight that opens takes the body, and the walk never returns
// here; when the fight ends the next turn reads the target again. Each leg is numbered: working one target is the work, not
// a loop, and TARGET_LEGS bounds it.
async function leg(bot) {
  const cur = _current;
  cur.legs++;
  if (cur.legs > TARGET_LEGS) return finish(bot, 'no_fight');
  const d = flat(cur.pos, bot.entity.position);
  watcher.summary(TAG, `T_TARGET_LEG n=${cur.legs} source=${cur.source} target=${cur.name}#${cur.id} d=${d.toFixed(1)} at=(${Math.floor(cur.pos.x)},${Math.floor(cur.pos.z)}) hp=${Math.round(bot.health)}`);
  const went = await require('@api/sector_finder').walkToward(bot, { x: cur.pos.x, z: cur.pos.z }, { survey: true });
  if (!went.arrived) return finish(bot, `unreached:${went.reason}`);
  return `${TAG}: ${cur.source} ${cur.name}#${cur.id} leg ${cur.legs} arrived at=${at(bot.entity.position)}`;
}

// take(bot, t, size) → the readable: the first key of the list goes in hand and its first leg is walked. A call is held
// with the help line, so the T-1 says when it reaches the mob and the T-2 is relieved.
function take(bot, t, size) {
  _current = { source: t.source, name: t.name, id: t.id, key: t.key, pos: t.pos, began: Date.now(), legs: 0 };
  if (t.source === 'called') require('@api/help_line').summon({ call: t.call, mob: { id: t.id, name: t.name, pos: t.pos }, by: t.caller });
  sayTarget({ t_target: t.key });
  watcher.summary(TAG, `T_TARGET source=${t.source} target=${t.name}#${t.id} d=${t.d.toFixed(1)} board=${size} at=(${Math.floor(t.pos.x)},${Math.floor(t.pos.z)}) hp=${Math.round(bot.health)}`);
  return leg(bot);
}

// postOf(bot) → { kind, name, x, z, stand? }: where the body idles now.
//   battle  for TERMINATOR_POSTS.after_battle_ms after a battle of its own: the open ground nearest that battle, in case it
//           comes back;
//   park    else the park spot every idle body stands at (idle_park.parkSpot: the home's first anchor);
//   here    before home is sited and floored, where it stands.
function postOf(bot) {
  const { TERMINATOR_POSTS } = require('@thinking/architect_config');
  const last = require('@api/battle_ledger').lastOwnBattle();
  if (last && Date.now() - last.at < TERMINATOR_POSTS.after_battle_ms) return { kind: 'battle', name: last.anchor, x: last.pos.x, z: last.pos.z };
  const park = require('@action/idle_park').parkSpot(bot);
  if (park) return { kind: 'park', name: park.key, x: park.stand.x, z: park.stand.z, stand: park.stand, anchor: park.anchor };
  const p = bot.entity.position;
  return { kind: 'here', name: 'home_unsited', x: p.x, z: p.z };
}

// postStand(bot, post) → the nearest dry cell within TERMINATOR_POSTS.stand_search of the post that no sited footprint covers,
// or null: a battle may have been fought against a wall, so the body stands on the open ground beside it. The spawn proofing's
// footprint is the whole lit base, not a building, and is stood in (fragment_utils.buildingBoxes).
function postStand(bot, post) {
  const { standNear } = require('@perception/ground_line');
  const { TERMINATOR_POSTS } = require('@thinking/architect_config');
  const fu = require('@utils/fragment_utils');
  const boxes = fu.buildingBoxes(0);
  return standNear(bot, Math.floor(post.x), Math.floor(post.z), TERMINATOR_POSTS.stand_search, (x, z) => fu.isInsideBlueprintKeepout({ x, z }, boxes));
}

// holdPost(bot) → the readable: the body walks to its post's stand by the regular route (locomotion goTo), or
// holds it, looking for a target every POST_LOOK_MS for up to POST_HOLD_MS. A post with no open ground round it is held
// where the body stands. Each hold is numbered: holding the post is the work, not a loop, and a repeated outcome would
// read as one to the judge. A walk that does not reach the stand says the same each time, wherever it ended, so a body
// that cannot reach its post repeats one outcome and the judge's loop check stops it.
async function holdPost(bot) {
  const { sleep } = require('@utils/fragment_utils');
  const post = postOf(bot);
  const from = bot.entity.position.clone();
  let stand = post.stand || (post.kind === 'battle' ? postStand(bot, post) : null);
  if (!stand) stand = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z), none: post.kind !== 'here' };
  const counts = JSON.stringify(require('@api/battle_ledger').counts());
  if (flat(from, stand) > POST_REACH) {
    // The park is walked to as idle_park walks to it (goToStand on the home's anchor, tolerant), so the two never differ.
    const loco = require('@locomotion/locomotion_dispatcher');
    const went = post.anchor ? await loco.goToStand(post.anchor, { exact: false })
      : await loco.goTo({ x: stand.x, y: stand.y, z: stand.z, purpose: 'terminator_post' });
    const p = bot.entity.position;
    const reached = flat(p, stand) <= POST_REACH;
    watcher.summary(TAG, `T_POST walk kind=${post.kind} post=${post.name} stand=(${stand.x},${stand.y},${stand.z}) counts=${counts}`
      + ` walked=${Math.round(flat(p, from))} reached=${reached}${went && went.arrived ? '' : ` reason=${(went && went.reason) || 'not arrived'}`} at=${at(p)}`);
    if (!reached) return `${TAG}: the walk to the ${post.kind} post ${post.name} did not reach its stand`;
    return `${TAG}: walked to the ${post.kind} post ${post.name} ${at(p)}`;
  }
  _holds++;
  const began = Date.now();
  let seen = null;
  while (Date.now() - began < POST_HOLD_MS && !(seen = board(bot)[0])) await sleep(POST_LOOK_MS);
  const held = Math.round((Date.now() - began) / 1000);
  watcher.summary(TAG, `T_POST hold=${_holds} kind=${post.kind} post=${post.name}${stand.none ? ' stand=none_open' : ''} at=${at(bot.entity.position)} counts=${counts}`
    + ` held_s=${held} ended=${seen ? `target:${seen.source}` : 'time'}`);
  return `${TAG}: held the ${post.kind} post ${post.name}, hold ${_holds}, ${held}s, ${seen ? `saw ${seen.source} ${seen.name}#${seen.id}` : 'quiet'}`;
}

// ── THE TURN ──────────────────────────────────────────────────────────────────────────────────────────

// turn(bot) → { readable, moved }: the one step this turn takes.
async function turn(bot) {
  const cfg = require('@thinking/architect_config');
  if (cfg.isPeacefulWorld()) return { readable: stepDown(bot, null, 'peaceful: no monster spawns, nothing to terminate') };
  // A BODY JUST LOGGED IN STANDS IN GROUND NOT YET SENT: chests, trash and a post read before it arrives find nothing.
  if (!_groundLoaded) {
    const loaded = await require('@utils/external_library_guard').guardExternal(TAG, 'wait for the ground round the body', () => bot.waitForChunksToLoad());
    _groundLoaded = true;
    if (!loaded.ok) watcher.warn(TAG, `the ground round the body did not report loaded (${loaded.reason}); planning on what has arrived`);
  }
  const kit = kitOfThisBody();
  await require('@api/armor').wearArmor(bot);
  await require('@utils/combat_utils').readyShield(bot);
  // A TARGET IN HAND IS FINISHED FIRST: the body eats if hungry and walks its next leg; nothing else breaks into it.
  if (_current) {
    const why = targetDone(bot, _current);
    if (why) return { readable: finish(bot, why) };
    if (bot.food < cfg.HUNGER_EAT_THRESHOLD) {
      const eaten = await require('@action/eat_executor').eatUntilFull(bot);
      if (eaten.ate > 0) return { readable: `${TAG}: ate ${eaten.ate} with ${_current.source} ${_current.name}#${_current.id} in hand` };
    }
    return { readable: await leg(bot) };
  }
  const gear = gearOf(bot, kit);
  const floor = { spent: new Map() };
  for (const part of gear.short) {
    const step = fetchFor(bot, kit, gear, part, rankOf(gear, part), floor);
    if (step) return fetch(bot, part, step);
  }
  if (gear.short.length) return { readable: stepDown(bot, gear, `below the floor, the chests cannot lift: ${gear.short.join(',')}`) };
  if (bot.food < cfg.HUNGER_EAT_THRESHOLD) {
    const eaten = await require('@action/eat_executor').eatUntilFull(bot);
    watcher.summary(TAG, `T_ATE ate=${eaten.ate} food=${eaten.foodBefore}->${eaten.foodAfter} carried=${gearOf(bot, kit).food}`);
    if (eaten.ate > 0) return { readable: `${TAG}: ate ${eaten.ate}, food ${eaten.foodBefore}->${eaten.foodAfter}` };
  }
  for (const part of gear.raise) {
    const step = fetchFor(bot, kit, gear, part, rankOf(gear, part));
    if (step) return fetch(bot, part, step);
  }
  if (await refill(bot, TAG)) return { readable: `${TAG}: trash dug at ${at(bot.entity.position)}` };
  const list = board(bot);
  if (list.length) return { readable: await take(bot, list[0], list.length) };
  return { readable: await holdPost(bot) };
}

module.exports = {
  gearOf,
  floorUnmet,
  // Exported so a check drives the real target board and the real reading of a finished target.
  board,
  targetDone,
  // Exported so a check drives the real choice of what the chests are asked for.
  fetchFor,
  quarry,
  refill,
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the terminator planned.`);
    if (!require('@api/combat_board').isTerminator()) {
      throw new Error(`[${TAG}] CODING VIOLATION: a planning turn reached the terminator's planner for a body designated ${require('@api/combat_board').designation()}.`);
    }
    const out = await turn(bot);
    if (out === undefined) return;   // a door abandoned the chain to the judge (Law 15): nothing routes again
    routeToJudge(TAG, { readable: out.readable, [TAG]: { success: true, readable: out.readable, transferred: out.moved || 0 } });
  }),
};
