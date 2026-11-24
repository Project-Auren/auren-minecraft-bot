// hand — THE ONE PLACE THE MAIN HAND IS CHANGED.
//
// Every interaction picks what it uses right before it uses it (a swing its weapon, a dig its tool, a place its block,
// a feed its wheat) and hands the pick here. The gate is the whole rule: the hand already holds the pick, nothing is
// done; otherwise the pick is taken in hand, or the hand emptied when the pick is the bare hand. Picking again before
// every use is therefore free when nothing changed, and a hand some other step left wrong (a dig, a broken weapon, a
// block placed) is corrected by the next use's own pick, with no check anywhere else.
//
// hold(bot, item, scope) → { ok, changed, reason }: the gate, with the equip guarded and named under `scope`. `item`
//   is an inventory item, or null for the bare hand. `ok` false is the equip refused by the client or server; the hand
//   is then whatever it was.
// take(bot, item) → changed: the same gate for a caller already inside its own guardExternal block, where a refused
//   equip throws to that guard with the rest of its act.
// The off-hand is not this module's: the shield and the herder's wheat keep their own helpers.
//
// ── EVERY TOOL OR WEAPON TAKEN IS RECORDED ─────────────────────────────────────────────────────────────
// A change of hand to or from an item that wears (a tool, a weapon) writes one `hand` row on the combat record: what
// was taken and its durability left, what it replaced, who asked (`by`), and every wearing item the pocket held at that
// moment with its durability left (`pocket`), so a reader sees what was chosen and from what. A block or a food
// taken is not a tool and writes nothing.

'use strict';

const { guardExternal } = require('@utils/external_library_guard');

// holds(bot, item) → true when the hand already holds the pick (null: the hand is empty).
function holds(bot, item) {
  const held = bot.heldItem || null;
  return item ? !!held && held.name === item.name : !held;
}

// left(item) → the durability an item has left, or null for one that does not wear.
function left(item) {
  return item && item.maxDurability ? item.maxDurability - (item.durabilityUsed || 0) : null;
}
// wearing(bot) → every item in the pocket that wears, as 'name:left'.
function wearing(bot) {
  return bot.inventory.items().filter((i) => i.maxDurability).map((i) => `${i.name}:${left(i)}`);
}
function noteHand(bot, from, item, by) {
  if (left(from) === null && left(item) === null) return;
  require('@api/combat_record').record('hand', {
    took: item ? item.name : 'empty', took_left: left(item), from: from ? from.name : 'empty', from_left: left(from),
    by, pocket: wearing(bot),
  });
}

async function hold(bot, item, scope) {
  if (!scope) throw new Error('[hand] CODING VIOLATION (Law 13): hold needs the caller\'s scope, so a refused equip is attributed.');
  if (holds(bot, item)) return { ok: true, changed: false, reason: null };
  const from = bot.heldItem || null;
  const r = item
    ? await guardExternal(scope, `take ${item.name} in hand`, () => bot.equip(item, 'hand'))
    : await guardExternal(scope, `empty the hand (${bot.heldItem.name})`, () => bot.unequip('hand'));
  if (r.ok) noteHand(bot, from, item, scope);
  return { ok: r.ok, changed: r.ok, reason: r.ok ? null : r.reason };
}

async function take(bot, item, by = 'take') {
  if (holds(bot, item)) return false;
  const from = bot.heldItem || null;
  if (item) await bot.equip(item, 'hand');
  else await bot.unequip('hand');
  noteHand(bot, from, item, by);
  return true;
}

module.exports = { hold, take, holds };
