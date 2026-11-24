// fragment: support_repair_executor (action / a standing support's upkeep)
// purpose: ONE verb — mend a few broken cells of a support that has stood (the bot hive): stock their blocks, then for
//          each cell, lowest first: walk to any stand that reaches it, place it, check it, go on to the next (Law 0).
//
// ── A SWARM, NOT A CLIMB ────────────────────────────────────────────────────────────────────────────────
// A support that has stood is never worked by the column pass again (downloaded_plan_registry.stood): a climb digs every
// shaft cell below its cube, the barrels in the shafts with them. Its damage is posted instead as repair jobs of a few
// cells each (assessors/downloaded_build SUPPORT UPKEEP, architect_config.SUPPORT_REPAIR), ranked first in the building
// band (job_ranking.measureSiteRank), so the crew comes from everywhere and each body carries a few blocks.
//
// ── NO ANCHOR ───────────────────────────────────────────────────────────────────────────────────────────
// place_authority places from wherever the body stands in reach, so a cell needs only a stand: the navigator's line-of-
// sight goal (require_los) takes the first stand within reach of the cell that sees it, and spare_builds keeps the walk
// from cutting the building it mends. A repair walk may enter the support's closed floors (setRepairing, a lease); no
// other walk may. The cell's work from that stand is the one stationary routine every builder uses (anchored_repair).
//
// ── THE MATERIAL IS THE OPEN CHESTS' ────────────────────────────────────────────────────────────────────────
// Stocked from the pool the board posted the job on (fragment_utils.buildPoolChests: the support's own chests and the
// headframe's), finished first, then raw and crafted. A chest on a closed floor is not in it (station_registry
// _openStations), and the lobby never closes.
//
// ── EACH CELL IS CLAIMED ────────────────────────────────────────────────────────────────────────────────────
// 'mend:<building>:x,y,z' (foreman_brain), held from before the walk until the cell is checked, so two bodies never
// mend one cell. A cell already right when the body gets to it (a peer, or the escape's trash dug out) is passed.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const planRegistry = require('@kernel/downloaded_plan_registry');
const inventorySwapper = require('@api/inventory_swapper');
const { craftBatch } = require('@api/craft_handler');
const { repairAtAnchor, reachFromStand, standInReachOf } = require('@api/anchored_repair');
const { performDig } = require('@utils/movement/dig_authority');
const { performPlace } = require('@utils/movement/place_authority');
const { isAir } = require('@utils/movement/terrain_predicates');
const { remainingRawInSpecies, isRawMaterial, isChainOwned } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { buildPoolChests, chestItemCounts, getBotInventory, BLOCK_REACH } = require('@utils/fragment_utils');
const { claimFirst, releaseTarget } = require('@utils/target_claims');
const { routeToJudge } = require('@utils/signal_utils');
const { withCleanup } = require('@utils/external_library_guard');

const TAG = 'support_repair_executor';

const isPlankOrStick = (item) => item === 'stick' || /_planks$/.test(item);

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before a support repair ran.`);

    // The leftovers are banked before the judge is routed to: routing dispatches, and anything awaited after it races
    // the judge's next dispatch (the gather and salvage sides' seam).
    const finish = async (readable, success = true) => {
      watcher.summary(TAG, readable);
      const drop = await inventorySwapper.dropOffHaul(bot);
      if (drop?.abandoned) return;
      return routeToJudge(TAG, { ...payload, success, readable });
    };

    const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
    const structure = magnet?.structure;
    const cells = magnet?.cells;
    if (!structure || !Array.isArray(cells) || !cells.length) return finish(`${TAG}: no cells on the magnet — nothing to mend`, false);

    const row = hq.readBuildingChair(structure, 'set_buildspot');
    const plans = planRegistry.of(structure);
    if (!row || !plans.isLoaded()) return finish(`${TAG}: "${structure}" is not sited or its plan is not loaded — nothing to mend`, false);
    const frame = plans.siteFrame(row);
    const build = require('@thinking/assessors/downloaded_build').of(structure);
    const { itemFor, correctAlready, placeState } = require('@action/build_column_executor');

    const targets = cells.map(b => build.cellAt(b)).filter(Boolean).sort((a, b) => a.b[1] - b.b[1]);
    if (targets.length !== cells.length) {
      throw new Error(`[${TAG}] CODING VIOLATION: the board posted ${cells.length} cell(s) of "${structure}" and the plan has ${targets.length} of them: ${JSON.stringify(cells)}.`);
    }

    // ── STOCK: the blocks for the cells still wrong, finished first, then raw and crafted ─────────────────────────
    const stillWrong = targets.filter(t => build.cellWrong(bot, frame, t) !== false);
    if (!stillWrong.length) return finish(`${TAG}: ${targets.length} cell(s) of "${structure}" already stand as the plan asks — mended by a peer`);
    const need = build.materialsOf(bot, frame, stillWrong.filter(t => t.v));
    const inChests = (item) => buildPoolChests(structure)
      .reduce((n, { station }) => n + countInInventory(item, chestItemCounts(station)), 0);
    const take = async (item, n) => {
      const there = Math.min(n, inChests(item));
      if (there <= 0) return true;
      const got = await inventorySwapper.retrieveItems(bot, item, there);
      return got !== undefined;   // undefined: abandoned to the judge (Law 15)
    };
    for (const [item, n] of Object.entries(need)) {
      const lack = n - countInInventory(item, getBotInventory());
      if (lack > 0 && !(await take(item, lack))) return;
    }
    const craftNeed = {};
    for (const [item, n] of Object.entries(need)) {
      if (isRawMaterial(item) || isChainOwned(item)) continue;
      if (n > countInInventory(item, getBotInventory())) craftNeed[item] = n;
    }
    if (Object.keys(craftNeed).length) {
      for (const [raw, n] of Object.entries(remainingRawInSpecies(craftNeed, getBotInventory(), frame.wood))) {
        if (!(await take(raw, n))) return;
      }
      const orders = Object.keys(craftNeed).sort((a, b) => (isPlankOrStick(a) ? 1 : 0) - (isPlankOrStick(b) ? 1 : 0))
        .map(item => ({ item, quantity: craftNeed[item] }));
      watcher.summary(TAG, `REPAIR_CRAFT build=${structure} ${orders.map(o => `${o.item} x${o.quantity}`).join(', ')}`);
      const book = await craftBatch(bot, orders, payload);
      if (!book || !book.success) return;   // abandoned to the judge (Law 15)
    }

    // ── MEND: lowest cell first — stand, place, check, next ───────────────────────────────────────────────────────
    const locomotion = require('@locomotion/locomotion_dispatcher');
    let mended = 0, already = 0;
    const left = [];
    // THE HOLES ARE NOT STANDS: a body standing in a broken cell blocks the peer that fills it, and its own next cell
    // beside it. Every cell of the support still missing its block is kept out of the stand's body (avoid_body).
    const holes = () => {
      const out = [];
      for (const c of build.allCells()) {
        if (!c.v || build.cellWrong(bot, frame, c) !== true) continue;
        const p = frame.worldOf(c.b[0], c.b[1], c.b[2]);
        out.push(`${p.x},${p.y},${p.z}`);
      }
      return out;
    };
    // mendOne(t, pos, where) → 'mended' | 'already' | a reason the cell is left. Run under the cell's claim.
    const mendOne = async (t, pos, where) => {
      plans.setRepairing(true);
      const nav = await locomotion.goTo({ x: pos.x, y: pos.y, z: pos.z, require_los: true, spare_builds: true, avoid_body: holes(), leg: 'work' });
      if (!nav || !nav.arrived) return `${where} no stand reaches it (${nav?.reason || 'not arrived'})`;
      if (build.cellWrong(bot, frame, t) === false) return 'already';
      // THE CELL IS WORKED FROM WHERE THE BODY STANDS NOW, measured as the place gate measures (stand_reach): a body
      // at the end of the walk is not always where the walk ended (a crew mending one wall shoulders a body a block
      // aside). Out of reach, it walks to the nearest stand with the cell in reach, as the miner and the surveyor do;
      // with none, or not reached, the cell is left for the next pass.
      if (reachFromStand(bot, bot.entity.position.floored(), pos) > BLOCK_REACH) {
        const stand = standInReachOf(bot, pos);
        const went = stand ? await locomotion.goTo({ ...stand, exact: true, leg: 'work' }) : null;
        if (!went?.arrived || reachFromStand(bot, bot.entity.position.floored(), pos) > BLOCK_REACH) {
          return `${where} out of reach (${stand ? 'the stand in reach was not reached' : 'no stand in reach'})`;
        }
      }

      const at = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      const block = t.v ? frame.voxelBlock(t.v) : 'air';
      const steps = [];
      // A wrong block standing in the cell (an escape's trash, a fallen block, the wrong piece) comes out first.
      if (at && at.name && !isAir(at.name)) steps.push({ action: 'dig', place: pos, type: block });
      if (t.v) steps.push({ action: 'place', place: pos, type: block, state: placeState(block, frame.voxelState(t.v)), block, v: t.v });
      const feet = bot.entity.position.floored();
      const ops = {
        tag: TAG,
        maxPlaceAttempts: 3,
        // A body that came to rest on the cell it must clear steps off it, works it from the side and steps back
        // (anchored_repair.sidestepFooting, the shared opt-in the builders, the farm and the mine use).
        footingSidestep: true,
        isOptional: () => false,
        resolveItem: (type) => {
          const name = itemFor(bot, type, null);
          return name && bot.inventory.items().some(i => i.name === name && i.count > 0) ? name : null;
        },
        digOne: async (s) => {
          const cell = new Vec3(s.place.x, s.place.y, s.place.z);
          const here = bot.blockAt(cell);
          if (here && here.boundingBox === 'empty' && isAir(here.name)) return true;
          return performDig(bot, cell, here, TAG, here && here.name !== s.type ? { misplacedStation: true } : {});
        },
        placeOne: async (s, ev) => {
          if (s.v && correctAlready(bot, frame, s.place, s.v)) return 'already';
          const item = itemFor(bot, s.type, s.state);
          if (!item) return 'skipped';   // the free half of a two-cell piece
          const res = await performPlace(bot, new Vec3(s.place.x, s.place.y, s.place.z), ev.anchor, ev.face, item, TAG,
            s.state ? { state: s.state, block: s.block } : {});
          return !!res.ok && !(res.state && res.state.ok === false);
        },
      };
      await repairAtAnchor(bot, { stand: { x: feet.x, y: feet.y, z: feet.z }, steps, label: `mend ${where}` }, ops);
      // CHECK: the world says whether the cell is mended, whatever the routine counted.
      return build.cellWrong(bot, frame, t) === false ? 'mended' : `${where} ${block} not standing after the place`;
    };
    // The repair lease ends with the job, however the job ends (withCleanup releases on every exit, catches nothing).
    await withCleanup(TAG, 'end the repair lease', async () => {
      for (const t of targets) {
        const pos = frame.worldOf(t.b[0], t.b[1], t.b[2]);
        const where = `(${pos.x},${pos.y},${pos.z})`;
        if (build.cellWrong(bot, frame, t) === false) { already++; continue; }
        const key = `mend:${structure}:${pos.x},${pos.y},${pos.z}`;
        const taken = await claimFirst([t], { keyOf: () => key });
        if (!taken.pick) { left.push(`${where} held by a peer`); continue; }
        const outcome = await withCleanup(TAG, `release ${key}`, () => mendOne(t, pos, where), () => releaseTarget(key));
        if (outcome === 'mended') mended++;
        else if (outcome === 'already') already++;
        else left.push(outcome);
      }
    }, () => plans.setRepairing(false));

    return finish(`${TAG}: "${structure}" mended=${mended} already=${already} left=${left.length} of ${targets.length} cell(s)`
      + (left.length ? ` — ${left.join('; ')}` : ''), mended + already > 0);
  }),
};
