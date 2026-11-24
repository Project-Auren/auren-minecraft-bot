// fragment: test_module — ONE BEHAVIOUR ON ITS OWN, IN PLACE OF THE PLANNER.
//
// While foreman_config `module` names a test, recursive_judge hands every planning turn here instead of to job_board
// (plannerTarget). The module runs its one test under every rule a job obeys (the judge's loop checks, battle stations,
// the body's own survival) and reports back to the judge. A test runs once per body: when the judge hands the turn
// back after it, the chain ends here and routes nowhere, so the body stands where the test left it and the record is
// read through its lens.
//
// TESTS
//   walk — the foreman asks the server for the nearest `module_biome` (foreman/decoration_locate.locateForModule),
//          and the body walks there by the finder's own walk (sector_finder.walkToward): legs over the navigator,
//          a river swum or its far bank taken, the flattest leg end preferred. Logged as TEST_LOCATE and TEST_WALK,
//          which the --finder lens reads beside the decoration locates.
//   t1   — the T-1 night march, the terminator's loop (Thinking_fragments/designations letter T): each body takes a designation
//          from foreman_config module_kits, dealt round the crew so a T-1 and a T-1A march the same night, is issued the
//          kit at its ceiling (terminator_kits kitFor) over the console
//          (an operator's input, read back off its own pocket, off-hand and armour slots; the shield to the off-hand by
//          combat_utils.readyShield), waits for night, then HUNTS until dawn: the nearest hostile the terminator hunts
//          (terminator_planner.quarry) is walked up to and fought, nearest first; with none in range it marches a short leg on its bearing (east
//          first) and looks again. Between hunts it eats its bread, and digs trash back up when the pocket runs low
//          (TRAVEL_TRASH_LOW). It ends at dawn (survived) or at its death (down). Logged as T1_KIT, T1_HUNT, T1_HUNT_PASS,
//          T1_REFILL, T1_LEG, T1_TURN and T1_END; its fights and kills are the combat ledger's
//          (`trace_monitor --fight-record`). A fight that hands the body back to the judge, or a retreat home, resumes
//          the same march from where the body stands.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'test_module';
const TESTS = Object.freeze(['walk', 't1']);
let _done = null;   // the readable of this body's finished test, or null while it has not run

// moduleName() → the test the run page names, or null when the crew plans its own work.
function moduleName() {
  const name = require('../foreman_config').module;
  if (name === 'off') return null;
  if (!TESTS.includes(name)) {
    throw new Error(`[${TAG}] CODING VIOLATION: foreman_config.module is '${name}'. Known: 'off' | ${TESTS.map(t => `'${t}'`).join(' | ')}.`);
  }
  return name;
}

// plannerTarget() → this module while the run names one, else null: the run's order the judge reads first, ahead of the
// body's designation (recursive_judge THE PLANNER IS READ, NEVER CHOSEN).
function plannerTarget() { return moduleName() ? TAG : null; }

// locateBiome(bot, test) → the nearest `module_biome` the foreman finds from where the body stands, or found null
// with the reason logged.
async function locateBiome(bot, test) {
  const biome = require('../foreman_config').module_biome;
  const from = bot.entity.position.clone();
  const answer = await require('@kernel/foreman_link').askModuleLocate(biome, from);
  if (!answer || !answer.found) {
    const reason = answer ? answer.reason : 'no_foreman';
    watcher.summary(TAG, `TEST_LOCATE item=biome:${biome} found=none reason=${reason}`);
    return { biome, found: null, readable: `${TAG}: ${test} — no ${biome} located (${reason})` };
  }
  const { x, z, distance } = answer.found;
  watcher.summary(TAG, `TEST_LOCATE item=biome:${biome} found=${answer.found.biome} at=(${x},${z}) distance=${distance} from=(${Math.floor(from.x)},${Math.floor(from.z)})`);
  return { biome, found: answer.found };
}

async function walk(bot) {
  const finder = require('@api/sector_finder');
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const began = Date.now();
  const located = await locateBiome(bot, 'walk');
  if (!located.found) return { success: false, readable: located.readable };
  const { biome } = located;
  const { x, z, distance } = located.found;
  const walked = await finder.walkToward(bot, { x, z });
  const p = bot.entity.position;
  const seconds = Math.round((Date.now() - began) / 1000);
  const left = Math.round(flat({ x, z }, p));
  watcher.summary(TAG, `TEST_WALK item=biome:${biome} arrived=${walked.arrived} walked_s=${seconds} left=${left} at=(${Math.floor(p.x)},${Math.floor(p.z)})`
    + `${walked.arrived ? '' : ` reason=${walked.reason}`}`);
  return {
    success: walked.arrived,
    readable: `${TAG}: walk to ${biome} ${walked.arrived ? 'arrived' : `stopped ${left} b short (${walked.reason})`} after ${seconds}s`,
    walked: { biome, distance, seconds, left, arrived: walked.arrived },
  };
}

// ── THE T-1 NIGHT MARCH ───────────────────────────────────────────────────────────────────────────────
const T1_BEARING_DEG = 90;          // the bearing marched first: east (+x)
const T1_TURN_DEG = 45;             // a bearing the ground refuses is turned this far, clockwise
const T1_REFUSALS_TO_STOP = 8;      // this many refused legs in a row, every bearing tried, ends the march
const T1_LEG_GAINED = 16;           // a walk that moved the body at least this far is progress, arrived or not
// THE HUNT: at night the body goes after the nearest hostile terminator_planner.quarry finds, nearest first; walked up to, the
// mob turns on it and the body's own fight takes it (battle stations), and the hunt resumes from where the fight left
// it. With nothing in range it walks a T1_ROAM_STEP leg of the march, then looks again.
// Which hostile is hunted, and the trash dug back up, are the terminator's own (terminator_planner quarry, refill).
const T1_HUNT_SKIP_MS = 60000;      // a quarry the walk could not close on is passed over this long
const T1_ROAM_STEP = 32;            // blocks ahead a roaming leg is aimed, so the hunt looks again soon
const T1_KIT_WAIT_MS = 5000;        // how long the pocket is read for the console's items to arrive
const T1_NIGHT_POLL_MS = 5000;      // how often a body waiting for night reads the clock
const T1_STANDBY_POLL_MS = 60000;   // how often a downed body standing by wakes (it waits on nothing; the run's end takes it)
const T1_NIGHTLESS_SPAN_MS = 550000; // a march where no night falls (the Nether, the End): one night, 11000 ticks at 20 a second
const ARMOR_SLOTS = Object.freeze(['head', 'torso', 'legs', 'feet']);
let _march = null;                  // the one march this body makes: its state, kept across fights and replans

// kitShort(bot, kit) → { item: missing } the body lacks of the kit, counting the pocket, the off-hand and the worn armour.
function kitShort(bot, kit) {
  const armor = require('@api/armor');
  const have = {};
  for (const item of bot.inventory.items()) have[item.name] = (have[item.name] || 0) + item.count;
  const off = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
  if (off) have[off.name] = (have[off.name] || 0) + off.count;
  for (const slot of ARMOR_SLOTS) {
    const w = armor.worn(bot, slot);
    if (w) have[w.name] = (have[w.name] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(kit).filter(([item, n]) => (have[item] || 0) < n).map(([item, n]) => [item, n - (have[item] || 0)]));
}

// designationOfThisBody() → the designation this body marches as: foreman_config module_kits dealt round the run's crew in
// its order (--only as named, else the roster's; the n-th body takes the n-th, round again past the last), so 'T-1,T-1A'
// marches half the crew in each. Each must be a terminator's (designations letter T).
function designationOfThisBody() {
  const cfg = require('../foreman_config');
  const names = String(cfg.module_kits || 'T-1').split(',').map((k) => k.trim()).filter(Boolean);
  const { parse } = require('@thinking/designations');
  const notT = names.find((k) => parse(k).letter !== 'T');
  if (notT) throw new Error(`[${TAG}] CODING VIOLATION: module_kits names '${notT}'; the march is a terminator's (T-<kit>[engine]).`);
  const roster = Object.keys(require('@thinking/architect_config').BOT_SENIORITY);
  const crew = cfg.only || roster.slice(0, cfg.count);
  const at = crew.indexOf(process.env.BOT_ID);
  return names[(at < 0 ? 0 : at) % names.length];
}

// issueKit(bot) → { ok, why }: the kit this body's designation names given over the console for what it lacks, read back off
// the body, the armour put on and the sword taken in hand; then the body is designated.
async function issueKit(bot) {
  const { kitFor } = require('@thinking/terminator_kits');
  const { guardExternal } = require('@utils/external_library_guard');
  const { sleep } = require('@utils/fragment_utils');
  const armor = require('@api/armor');
  const designation = designationOfThisBody();
  const kitName = require('@thinking/designations').parse(designation).kit;
  const kit = kitFor(kitName);   // the kit at its ceiling
  const short = kitShort(bot, kit);
  if (Object.keys(short).length) {
    const cmds = Object.entries(short).map(([item, n]) => `give ${bot.username} minecraft:${item} ${n}`);
    const sent = await guardExternal(TAG, `issue the ${kitName} kit`, () => require('@utils/rcon_link').once(cmds));
    if (!sent.ok) return { ok: false, why: `rcon: ${sent.reason}` };
    for (const end = Date.now() + T1_KIT_WAIT_MS; Object.keys(kitShort(bot, kit)).length && Date.now() < end;) await sleep(250);
  }
  await armor.wearArmor(bot);
  const shielded = await require('@utils/combat_utils').readyShield(bot);
  const missing = kitShort(bot, kit);
  const worn = ARMOR_SLOTS.map(s => armor.worn(bot, s)?.name || 'none');
  const below = require('@action/terminator_planner').gearOf(bot, require('@thinking/terminator_kits').kitNamed(kitName)).short;
  watcher.summary(TAG, `T1_KIT designation=${designation} kit=${kitName} issued=${JSON.stringify(short)} worn=${worn.join(',')} hand=${bot.heldItem ? bot.heldItem.name : 'none'}`
    + ` off_hand=${shielded ? 'shield' : 'none'} missing=${JSON.stringify(missing)} below_floor=${below.join(',') || 'none'}`);
  if (Object.keys(missing).length) return { ok: false, why: `the kit did not arrive: ${JSON.stringify(missing)}` };
  if (!shielded) return { ok: false, why: 'the shield is not in the off-hand' };
  if (below.length) return { ok: false, why: `below the kit's floor: ${below.join(',')} (worn ${worn.join(',')})` };
  // The body is a terminator from here: it never runs, and it heals inside its fight (combat_board THE DESIGNATION).
  require('@api/combat_board').designate(designation);
  return { ok: true };
}

const breadLeft = bot => bot.inventory.items().filter(i => i.name === 'bread').reduce((n, i) => n + i.count, 0);
const hp = bot => Math.round(bot.health * 10) / 10;

// tally(bot) → the flat blocks moved since the march last counted, added to its walk. Counted at every leg's end and at
// every resume, so a leg a fight cut off (its caller handed to the judge, never returning) still counts its ground.
function tally(bot) {
  const p = bot.entity.position;
  const moved = _march.last ? Math.hypot(p.x - _march.last.x, p.z - _march.last.z) : 0;
  _march.walked += moved;
  _march.last = p.clone();
  return moved;
}

// endMarch(bot, outcome, reason) → the readable: the march's one closing line, written once.
function endMarch(bot, outcome, reason) {
  const m = _march;
  if (m.ended) return m.ended;
  if (m.last && bot.entity) tally(bot);
  const p = bot.entity ? bot.entity.position : m.from;
  const marched = m.nightAt ? Math.round(((m.diedAt || Date.now()) - m.nightAt) / 1000) : 0;
  const reach = Math.round(Math.hypot(p.x - m.from.x, p.z - m.from.z));
  watcher.summary(TAG, `T1_END designation=${require('@api/combat_board').designation()} outcome=${outcome} reason=${reason} marched_s=${marched} straight_line=${reach} walked=${Math.round(m.walked)}`
    + ` legs=${m.legs} hunts=${m.hunts} turns=${m.turns} resumes=${m.resumes} bread_left=${breadLeft(bot)} hp=${hp(bot)}`
    + ` food=${bot.food} at=(${Math.floor(p.x)},${Math.floor(p.z)}) time=${bot.time.timeOfDay}`);
  m.ended = `${TAG}: T-1 ${outcome} after ${marched}s marching, ${reach} b from its start (${reason})`;
  return m.ended;
}

async function t1(bot) {
  const cfg = require('@thinking/architect_config');
  const { sleep } = require('@utils/fragment_utils');
  const finder = require('@api/sector_finder');
  if (cfg.isPeacefulWorld()) {
    watcher.summary(TAG, 'T1_END outcome=not_run reason=peaceful — no monster spawns, so there is no night to march through');
    return { success: false, readable: `${TAG}: T-1 not run — the world is peaceful` };
  }
  if (!_march) {
    _march = { from: bot.entity.position.clone(), bearing: T1_BEARING_DEG, nightAt: null, diedAt: null, last: null,
      walked: 0, legs: 0, hunts: 0, skipped: new Map(), turns: 0, refusals: 0, resumes: 0, ended: null };
    bot.once('death', () => {
      _march.diedAt = Date.now();
      endMarch(bot, 'down', 'died');
    });
    const kit = await issueKit(bot);
    if (!kit.ok) return { success: false, readable: endMarch(bot, 'not_run', kit.why) };
  } else {
    if (_march.diedAt) return { success: false, readable: endMarch(bot, 'down', 'died') };
    _march.resumes++;
    tally(bot);
    watcher.summary(TAG, `T1_RESUME resumes=${_march.resumes} hp=${hp(bot)} food=${bot.food} bread=${breadLeft(bot)} walked=${Math.round(_march.walked)}`);
  }
  const m = _march;

  // A T-1 MARCHES ONLY AT NIGHT: before it, it stands where it is and waits. Where no night falls, it marches at once,
  // for one night's length (marching).
  if (!m.nightAt) {
    if (!marching(bot, m)) watcher.summary(TAG, `T1_WAIT time=${bot.time.timeOfDay} — waiting for night`);
    while (!marching(bot, m)) {
      if (m.diedAt) return { success: false, readable: endMarch(bot, 'down', 'died') };
      await sleep(T1_NIGHT_POLL_MS);
    }
    // A BODY JUST SET DOWN IN ANOTHER DIMENSION STANDS IN GROUND NOT YET SENT: a leg read before it arrives finds no
    // stand on any bearing, and the march gives up within a second. It marches once the ground round it has loaded.
    const loaded = await require('@utils/external_library_guard').guardExternal(TAG, 'wait for the ground round the body',
      () => bot.waitForChunksToLoad());
    if (!loaded.ok) return { success: false, readable: endMarch(bot, 'not_run', `the ground did not load: ${loaded.reason}`) };
    m.nightAt = Date.now();
    m.last = bot.entity.position.clone();
    m.from = bot.entity.position.clone();
    watcher.summary(TAG, `T1_MARCH bearing=${m.bearing} from=(${Math.floor(m.from.x)},${Math.floor(m.from.z)}) time=${bot.time.timeOfDay}`
      + ` dimension=${bot.game.dimension}${m.spanEnds ? ` span_s=${Math.round(T1_NIGHTLESS_SPAN_MS / 1000)}` : ''}`);
  }

  while (marching(bot, m)) {
    if (bot.food < cfg.HUNGER_EAT_THRESHOLD && breadLeft(bot) > 0) {
      const eaten = await require('@action/eat_executor').eatUntilFull(bot);
      watcher.summary(TAG, `T1_ATE ate=${eaten.ate} food=${eaten.foodBefore}->${eaten.foodAfter} bread_left=${breadLeft(bot)}`);
    }
    await require('@action/terminator_planner').refill(bot, TAG);
    if (m.diedAt) return { success: false, readable: endMarch(bot, 'down', 'died') };
    const prey = require('@action/terminator_planner').quarry(bot, m.skipped);
    if (prey) {
      const { e } = prey;
      const at = e.position.clone();
      watcher.summary(TAG, `T1_HUNT quarry=${e.name}#${e.id} d=${prey.d.toFixed(1)} at=(${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)})`
        + ` hp=${hp(bot)} time=${bot.time.timeOfDay}`);
      m.hunts++;
      const went = await finder.walkToward(bot, { x: at.x, z: at.z }, { survey: true });
      if (m.diedAt) return { success: false, readable: endMarch(bot, 'down', 'died') };
      tally(bot);
      // THE WALK CAME BACK, SO NO FIGHT TOOK THE BODY (a fight hands its caller to the judge and the march resumes through
      // T1_RESUME): the quarry is passed over for a while, near or far. walkToward returns at once inside its arrival
      // radius, so a near quarry kept would be picked again at once and the loop would never wait on anything: the
      // process spins on its own microtasks, deaf to its timers and the server, until the server times it out.
      m.skipped.set(e.id, Date.now() + T1_HUNT_SKIP_MS);
      const live = bot.entities[e.id];
      const me = bot.entity.position;
      const left = live && live.position ? Math.hypot(live.position.x - me.x, live.position.z - me.z).toFixed(1) : 'gone';
      watcher.summary(TAG, `T1_HUNT_PASS quarry=${e.name}#${e.id} left=${left} why=${went.arrived ? 'not_engaged' : went.reason}`);
      continue;
    }
    const p = bot.entity.position.clone();
    const rad = m.bearing * Math.PI / 180;
    const to = { x: p.x + Math.sin(rad) * T1_ROAM_STEP, z: p.z - Math.cos(rad) * T1_ROAM_STEP };
    const went = await finder.walkToward(bot, to, { survey: true });
    if (m.diedAt) return { success: false, readable: endMarch(bot, 'down', 'died') };
    const q = bot.entity.position;
    const step = Math.hypot(q.x - p.x, q.z - p.z);
    tally(bot);
    m.legs++;
    watcher.summary(TAG, `T1_LEG bearing=${m.bearing} walked=${Math.round(step)} arrived=${went.arrived}${went.arrived ? '' : ` reason=${went.reason}`}`
      + ` hp=${hp(bot)} food=${bot.food} at=(${Math.floor(q.x)},${Math.floor(q.z)}) time=${bot.time.timeOfDay}`);
    if (went.arrived || step >= T1_LEG_GAINED) { m.refusals = 0; continue; }
    m.refusals++;
    if (m.refusals >= T1_REFUSALS_TO_STOP) return { success: false, readable: endMarch(bot, 'stopped', `${m.refusals} legs refused in a row: ${went.reason}`) };
    m.bearing = (m.bearing + T1_TURN_DEG) % 360;
    m.turns++;
    watcher.summary(TAG, `T1_TURN bearing=${m.bearing} why=${went.reason}`);
  }
  return { success: true, readable: endMarch(bot, 'survived', m.spanEnds ? 'span' : 'dawn') };
}

// marching(bot, m) → whether the march is on now. In the Overworld it is night (architect_config.isNightTime). Since
// 26.1 every dimension keeps its own clock and the Nether and the End keep none, so a body there reads the time as 0
// for ever (mineflayer time plugin: clocks[dimension] absent): no night falls, and the march runs T1_NIGHTLESS_SPAN_MS
// from the first look, one Overworld night's length (architect_config NIGHT_STARTS_AT to NIGHT_ENDS_AT).
function marching(bot, m) {
  if (String(bot.game.dimension).endsWith('overworld')) return require('@thinking/architect_config').isNightTime();
  if (!m.spanEnds) m.spanEnds = Date.now() + T1_NIGHTLESS_SPAN_MS;
  return Date.now() < m.spanEnds;
}

// A DEATH ENDS THE RUN ONLY WHEN THE RUN'S `death` STOP IS ON (run_end_config). Off, the downed body's test is over but the
// run is not: it stands by where it respawned until the run ends, by another body's end or the clock, its death counted in
// the fight record. A fight that takes it while it stands by hands it back here, and it stands by again.
// downStandsBy() → true when this body's march ended in its death and the death stop is off.
function downStandsBy() {
  return !!(_march && _march.diedAt) && !require('../foreman_config').wake.includes('death');
}
async function standBy(name) {
  watcher.summary(TAG, `TEST_DOWN module=${name} — ${_done}; the death stop is off, so this body stands by until the run ends`);
  const { sleep } = require('@utils/fragment_utils');
  for (;;) await sleep(T1_STANDBY_POLL_MS);
}

module.exports = {
  plannerTarget,
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const name = moduleName();
    if (!name) throw new Error(`[${TAG}] CODING VIOLATION: a signal reached the test module with foreman_config.module 'off'.`);
    if (_done && downStandsBy()) return standBy(name);
    if (_done) {
      watcher.summary(TAG, `TEST_DONE module=${name} — the test has run on this body (${_done}); the chain ends here`);
      // A TEST BODY HAS NO TASK AFTER ITS TEST, and a body with no task is not a legal bot: it is never parked or guarded.
      // The test runs in isolation, so its end is the run's end: this throw is the error that wakes the watcher, and the
      // foreman ends the watched run on it.
      throw new Error(`[${TAG}] TEST_DONE module=${name}: the test chain has ended on this body (${_done}); the run ends here.`);
    }
    const result = name === 't1' ? await t1(global.bot) : await walk(global.bot);
    _done = result.readable;
    if (downStandsBy()) return standBy(name);
    return routeToJudge(TAG, { readable: result.readable, [TAG]: { success: result.success, module: name, ...result } });
  }),
};
