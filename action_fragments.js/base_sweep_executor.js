// fragment: base_sweep_executor — one pass of the base sweep: break the litter lying on the home base's ground, nearest
// first, pick up what falls, bank the haul.
//
// ── THE GROUND IT SWEEPS ──────────────────────────────────────────────────────────────────────────
// The base is the ground of its parts joined (base_layout.baseGround), the one the spawn proofing lights where
// the crew's difficulty raises it (support_need); a peaceful crew's base is swept the same. Within it, a sited
// structure's footprint is its builder's and is skipped (harvestKeepoutBoxes(0): a pen, the farm, a building), and only
// the surface band round the home's floor is read,
// so a mushroom in a cave under the base is not litter. The harvest punch path keeps OUT of the base on purpose
// (HARVEST_KEEPOUT_RADIUS) — this is the one walk that works inside it.
//
// ── WHAT LITTER IS ────────────────────────────────────────────────────────────────────────────────
// The compostables group (leaf litter, flowers) and BASE_SWEEP.litter (grasses, ferns, bushes, mushrooms): every plant
// a hand breaks. The board's read and this walk's read are the same function (`litterIn`), so the job is offered only
// while the walk would find something (Law 16).
//
// ── THE PASS ──────────────────────────────────────────────────────────────────────────────────────
// At most BASE_SWEEP.punch_max breaks, nearest first, re-sensed before each one (Invariant B). A cell the walk could not
// reach or the dig refused is passed for the rest of the pass. The drops are swept up after each break and the haul is
// banked through dropOffHaul (inventory_swapper.dumpExcess decides what is kept), so the compostables reach the chests
// and compost_feed takes them to the bin.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { routeToJudge } = require('@utils/signal_utils');
const { groupToAllItems, harvestKeepoutBoxes, isInsideBlueprintKeepout } = require('@utils/fragment_utils');
const TAG = 'base_sweep_executor';

// How far above and below the home's floor a plant counts as lying on the base's ground.
const SURFACE_BAND = 6;
// The furthest a body's world view reaches for the read (the loaded radius; a farther cell is not in bot.blockAt).
const VIEW_LIMIT = 96;

// baseArea() → { rect, has, floorY, keepout } of the home base, or null while nothing is sited: the base's ground, its parts
// joined (base_layout.baseGround, the one the spawn proofing lights where it is raised), in its frame `rect`, its floor the crew's home's,
// and the footprints within it that are their builders'. The spawn proofing is a sited blueprint too, and its box is the
// whole rectangle: it is the ground swept, not a footprint kept out.
function baseArea() {
  const { SPAWN_PROOFING } = require('@thinking/architect_config');
  const { roomKeyName } = require('@foreman/message_schema');
  const keepout = harvestKeepoutBoxes(0).filter(b => roomKeyName(b.key) !== SPAWN_PROOFING);
  const home = hq.readBuildingChair(require('@kernel/bot_mandate').homeBlueprint(), 'set_buildspot');
  if (!keepout.length || !home?.transpose_origin) return null;
  const { rect, has } = require('@kernel/base_layout').baseGround(keepout);
  return { rect, has, floorY: home.transpose_origin.y, keepout };
}

// litterNames() → every block name that is litter.
function litterNames() {
  const { BASE_SWEEP } = require('@thinking/architect_config');
  const group = groupToAllItems('compostables');
  return [...new Set([...(Array.isArray(group) ? group : []), ...BASE_SWEEP.litter])];
}

// litterIn(bot, skip) → { cells: [{x,y,z,name}] nearest first, area } — the litter on the base's ground this body can
// see, minus the `skip` set ('x,y,z'). Empty while the base is not sited or lies past this body's view.
function litterIn(bot, skip = null) {
  const area = baseArea();
  if (!area || !bot?.entity?.position || !bot.registry) return { cells: [], area };
  const { rect, floorY } = area;
  const p = bot.entity.position;
  const near = Math.hypot(Math.max(rect.minX - p.x, 0, p.x - rect.maxX), Math.max(rect.minZ - p.z, 0, p.z - rect.maxZ));
  if (near > VIEW_LIMIT) return { cells: [], area };
  // THE READ IS A COLUMN WALK OF THE RECTANGLE'S SURFACE BAND BY RAW STATE ID, never a findBlocks sphere: a sphere
  // wide enough to cover the base reads every cell for blocks round it and holds the body's board for seconds.
  const litter = new Map();   // state id → block name
  for (const n of litterNames()) {
    const def = bot.registry.blocksByName[n];
    if (!def) continue;
    for (let s = def.minStateId; s <= def.maxStateId; s++) litter.set(s, n);
  }
  if (!litter.size) return { cells: [], area };
  const { keepout } = area;
  // A masked column is never swept: the spawn square, where the server refuses the break and the body's own blockAt
  // reads bedrock (spawn_protection.isMasked).
  const { isMasked } = require('@perception/spawn_protection');
  const cells = [];
  const at = new Vec3(0, 0, 0);
  for (let x = rect.minX; x <= rect.maxX; x++) {
    for (let z = rect.minZ; z <= rect.maxZ; z++) {
      if (!area.has(x, z) || isInsideBlueprintKeepout({ x, z }, keepout) || isMasked(bot, x, z)) continue;
      for (let y = floorY - SURFACE_BAND; y <= floorY + SURFACE_BAND; y++) {
        at.set(x, y, z);
        const name = litter.get(bot.world.getBlockStateId(at));
        if (name === undefined) continue;
        // A two-block plant (tall grass, large fern, the tall flowers) is one plant: its upper half is not counted, and
        // breaking the lower half takes both.
        at.set(x, y - 1, z);
        if (litter.get(bot.world.getBlockStateId(at)) === name) continue;
        if (skip && skip.has(`${x},${y},${z}`)) continue;
        cells.push({ x, y, z, name });
      }
    }
  }
  cells.sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
  return { cells, area };
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the base sweep ran.`);
  const { BASE_SWEEP } = require('@thinking/architect_config');
  const { combatCheckpoint } = require('@api/battle_stations');
  const { performDig } = require('@utils/movement/dig_authority');
  const { collectNearby } = require('@api/drop_collector.js');
  const locomotion = require('@locomotion/locomotion_dispatcher');

  const passed = new Set();
  const broke = {};
  let breaks = 0, picked = 0, left = 0;
  while (breaks < BASE_SWEEP.punch_max) {
    await combatCheckpoint(bot, 'base_sweep');
    const { cells } = litterIn(bot, passed);
    left = cells.length;
    if (!cells.length) break;
    const t = cells[0];
    const key = `${t.x},${t.y},${t.z}`;
    const nav = await locomotion.goTo({ x: t.x, y: t.y, z: t.z, require_los: true, leg: 'work' });
    if (!nav || nav.arrived === false) {
      passed.add(key);
      watcher.summary(TAG, `SWEEP_PASSED ${t.name} at (${key}) — not reached (${nav?.reason || 'no route'})`);
      continue;
    }
    const block = bot.blockAt(new Vec3(t.x, t.y, t.z));
    // Broken by a peer or trampled since the read, or a cell the body's blockAt reads otherwise than the scan did: passed,
    // so the pass never asks for the same cell again.
    if (!block || block.name !== t.name) {
      passed.add(key);
      watcher.summary(TAG, `SWEEP_PASSED ${t.name} at (${key}) — the cell now reads ${block ? block.name : 'nothing'}`);
      continue;
    }
    const dug = await performDig(bot, block.position, block, TAG);
    breaks++;
    if (!dug) { passed.add(key); continue; }
    broke[t.name] = (broke[t.name] || 0) + 1;
    const r = await collectNearby(bot);
    picked += r?.picked_up || 0;
  }

  const tally = Object.entries(broke).map(([n, c]) => `${n}=${c}`).join(' ') || 'none';
  const readable = `${TAG}: broke ${Object.values(broke).reduce((n, c) => n + c, 0)} litter (${tally}), picked up ${picked}, `
    + `${left} left in sight, ${passed.size} passed`;
  watcher.summary(TAG, `SWEEP_DONE ${readable}`);
  const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
  if (drop?.abandoned) return;
  routeToJudge(TAG, { readable, [TAG]: { success: true, broke, picked, left, passed: passed.size } });
}

module.exports = {
  receive: watcher.track(TAG, receive),
  litterIn,
  baseArea,
};
