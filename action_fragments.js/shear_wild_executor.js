// fragment: shear_wild_executor — one pass: shear wild sheep of one color for the wool still owed, and bank it.
// purpose: The crew's shears come from the chest; with no wild sheep sensed in the hive's ring the body walks to the one
//          the server named (the job's `where`); the server is asked which wild sheep in the ring are woolly and their
//          colors (pen_gate.askWool); the woolly ones of the job's color are walked to and shorn, nearest first, until the
//          wool the job was posted for is picked up or WILD_WOOL.sheep_most sheep were tried. Then the wool and the shears are banked
//          (shear_manager.bankWool, bankShears). The job and the wool owed are assessors/wild_wool's.
//
// invariants:
//  - Every sheep is re-sensed by entity id before each walk and each shearing (Invariant B); one gone is passed by.
//  - Which sheep carry wool is the server's word, never guessed from what the body sees.
//  - A pass that found no woolly sheep of the color is said on the body's chair (`wild_wool_none`), so the color is not
//    posted again for WILD_WOOL.retry_ms.
//  - One-shot: routes to the judge once.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal } = require('@utils/external_library_guard');
const { HERDING, WILD_WOOL } = require('@thinking/architect_config');

const TAG = 'shear_wild_executor';
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const woolOf = (bot, color) => bot.inventory.items().filter(i => i.name === `${color}_wool`).reduce((n, i) => n + i.count, 0);
const hasShears = bot => bot.inventory.items().some(i => i.name === 'shears');

function _finish(success, readable, metrics = {}) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable: `${TAG}: ${readable}`, [TAG]: { success, readable, metrics } });
}

// shearOne(bot, id) → true once the sheep was shorn: walked to while it stands out of HERDING.shear_reach (up to
// HERDING.shear_walks walks, each re-aimed at where it stands now), then the shears used on it.
async function shearOne(bot, id) {
  const locomotion = require('@locomotion/locomotion_dispatcher');
  for (let walks = 0; ; walks++) {
    const e = bot.entities[id];
    if (!e || e.isValid === false || !e.position) return false;
    if (flat(e.position, bot.entity.position) <= HERDING.shear_reach) {
      const shears = bot.inventory.items().find(i => i.name === 'shears');
      if (!shears) return false;
      const inHand = await require('@utils/hand').hold(bot, shears, TAG);
      if (!inHand.ok) return false;
      const r = await guardExternal(TAG, `shear wild sheep ${id}`, () => bot.activateEntity(e));
      return r.ok;
    }
    if (walks >= HERDING.shear_walks) return false;
    const p = e.position.floored();
    await locomotion.goTo({ x: p.x, y: p.y, z: p.z, leg: 'work', purpose: 'shear_wild' });
  }
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the wild shearing ran.`);
  const botId = process.env.BOT_ID || 'default';
  const magnet = hq.readBoardroomChair(botId, {})?.magnet;
  const color = /^(\w+)_wool$/.exec(magnet?.what || '')?.[1];
  if (!color) return _finish(false, `the job names no wool color (what=${magnet?.what || '-'})`);
  const wanted = require('@api/flock_colors').wantedWool(bot)[color] || 0;
  if (wanted <= 0) return _finish(true, `no ${color} wool is owed any more`);

  const { retrieveItems } = require('@api/inventory_swapper');
  if (!hasShears(bot)) {
    if (await retrieveItems(bot, 'shears', 1) === undefined) return;   // abandoned to the judge
    if (!hasShears(bot)) return _finish(false, 'no shears in the chests to shear with');
    watcher.summary(TAG, 'SHEARS taken from the chest for the wild shearing');
  }

  const { askWool } = require('@api/pen_gate');
  const { wildSheep, nearHive } = require('@thinking/assessors/wild_wool');
  // THE SHEEP THE SERVER NAMED: with no wild sheep sensed in the hive's ring, the body first walks to where the job says
  // the server saw one (assessors/wild_wool askHerd); a place outside the ring is never walked to.
  const where = magnet && magnet.where;
  if (!wildSheep(bot).length && where && typeof where.x === 'number' && nearHive(where)) {
    await require('@locomotion/locomotion_dispatcher').goTo({ x: where.x, y: where.y, z: where.z, leg: 'work', purpose: 'shear_wild' });
  }
  const before = woolOf(bot, color);
  const tried = new Set();
  let shorn = 0, asked = 0, woollySeen = 0;
  while (tried.size < WILD_WOOL.sheep_most && woolOf(bot, color) - before < wanted) {
    const near = wildSheep(bot).filter(e => !tried.has(e.id)).slice(0, WILD_WOOL.ask_most);
    if (!near.length) break;
    const answer = await askWool(near);
    if (answer === null) break;
    asked += answer.length;
    const woolly = answer.filter(a => a.woolly && a.color === color);
    woollySeen = Math.max(woollySeen, woolly.length);
    const next = woolly[0];
    if (!next) break;
    tried.add(next.entity.id);
    if (await shearOne(bot, next.entity.id)) {
      shorn++;
      await new Promise(r => setTimeout(r, WILD_WOOL.settle_ms));
      await require('@api/drop_collector').collectNearby(bot);
    }
  }
  // A last sweep for wool that landed after its pick-up or bounced past it.
  if (shorn > 0) await require('@api/drop_collector').collectNearby(bot);
  const got = woolOf(bot, color) - before;
  if (shorn === 0) {
    const c = hq.readBoardroomChair(botId, {}) || {};
    c.wild_wool_none = { color, at: Date.now() };
    hq.writeBoardroomChair(botId, c);
  }

  const { bankWool, bankShears } = require('@action/shear_manager');
  const banked = await bankWool(bot);
  if (banked === null) return;   // the deposit abandoned to the judge
  const shearsBack = await bankShears(bot);
  if (shearsBack === null) return;   // the deposit abandoned to the judge
  const line = `WILD_WOOL color=${color} wanted=${wanted} asked=${asked} woolly_seen=${woollySeen} tried=${tried.size} shorn=${shorn} got=${got} banked=${banked}`;
  _finish(got > 0, got > 0 ? line : `${line} — no ${color} wool came of it`, { color, wanted, shorn, got, banked });
}

module.exports = {
  receive: watcher.track(TAG, receive),
};
