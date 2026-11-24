// terminator_kits — THE KITS A TERMINATOR CARRIES. Data, derived and checked once at load.
//
// A TERMINATOR is designation T (designations): a body that hunts threats instead of planning work through the job board.
// Its kits are numbered T-<n>. The battle engine it fights by is the designation's suffix (T-1A: kit T-1, engine A), never
// a kit of its own.
//
// Every body carries THE STANDARD KIT: every bot row of architect_config.STOCK_THRESHOLDS a body is kept at (`deficit_below`
// of at least 1): the pickaxes, axes and shovels, the crafting table, the walking reserve of planks, the sword and the
// shield. Derived from those rows, so the standard kit is the crew's own and never a second list (Law 16). A tool row names
// tiers, not an item: the standard kit carries its stone tier where the row offers one; planks are oak planks.
//
// A TERMINATOR KIT IS A RANGE, NOT A LIST. Each row names its tiers worst first: the first is the FLOOR, the least the body
// may carry and stay a terminator; the last is the CEILING, the best it takes from the chests. Between them the body wears
// the best it can have, and its planning (action_fragments.js/terminator_planner) takes a better piece whenever the chests
// hold one, up to the ceiling. A body below the floor that the chests cannot lift steps down to a bot (B).
//   armour   all four pieces (custom_api/armor SLOT_OF), each of these tiers (armor ranks them, architect_config.ARMOR)
//   sword    one sword of these tiers (SWORD_TIERS ranks them); the standard kit's sword is stone, the floor
//   shield   one, in the off-hand; the standard kit's
//   food     edible items carried (fragment_utils group `food`): under `least` the body is below the floor; it tops up to
//            `want` from the chests, and bakes bread from the chests' wheat when they hold no food
//   torches  carried for lighting, never a floor: topped up to `want` from the chests between targets, or made from banked coal
//            or charcoal (terminator_planner)
//   extra    carried when the kit is issued whole (kitFor), never a floor: the planks of TRAVEL_TRASH and a milk bucket
//            (gunner THE MILK, drunk the moment a witch dies while her poison is on the body)
//
//   T-1      THE BASE'S TERMINATOR (the number is the role: T-1 keeps the base): copper armour to iron, a stone sword to
//            iron, the shield, and 2 food, topped back up from the chests as soon as one is eaten, since it is never far from
//            them. Planks are its blast-wall blocks (gunner THE BLAST WALL sets one at a swelling creeper's feet before the
//            shield takes the blast).
//
// kitFor(name) is the kit at its ceiling, what the T-1 march (action_fragments.js/test_module) issues over the console:
// the standard kit plus the ceiling's pieces, `want` bread and the extras, counts of a shared item added.
//
// Read by designations (letter T's kits), terminator_planner and test_module.

'use strict';

const { STOCK_THRESHOLDS, ARMOR } = require('./architect_config');

// The item a standard-kit row is carried as.
const STANDARD_TIER = 'stone';
const STANDARD_PLANKS = 'oak_planks';
function standardItem(row) {
  if (row.kind === 'tool') return `${row.tiers.includes(STANDARD_TIER) ? STANDARD_TIER : row.tiers[0]}_${row.item}`;
  if (row.item === 'planks') return STANDARD_PLANKS;
  return row.item;
}
const STANDARD_KIT = Object.freeze(Object.fromEntries(STOCK_THRESHOLDS
  .filter((r) => r.holder === 'bot' && Number.isInteger(r.deficit_below) && r.deficit_below >= 1)
  .map((r) => [standardItem(r), r.deficit_below])));

// A BODY FAR FROM HOME RESTOCKS NOTHING: a terminator carries TRAVEL_TRASH planks in all (the standard kit's walking
// reserve plus the rest), for the blast wall, the pillar and the bridge; below TRAVEL_TRASH_LOW it digs dirt back up to
// TRAVEL_TRASH outside a fight (terminator_planner, test_module, navigator.gatherScaffold).
const TRAVEL_TRASH = 64;
const TRAVEL_TRASH_LOW = 16;

// The swords, worst first. A golden sword strikes as a wooden one and wears out first, so it is no rung.
const SWORD_TIERS = Object.freeze(['wooden', 'stone', 'copper', 'iron', 'diamond', 'netherite']);

const TERMINATOR_KITS = Object.freeze({
  'T-1': Object.freeze({
    armour: Object.freeze(['copper', 'iron']),
    sword: Object.freeze(['stone', 'copper', 'iron']),
    shield: 1,
    food: Object.freeze({ least: 1, want: 2 }),
    torches: Object.freeze({ want: 16 }),
    extra: Object.freeze({ [STANDARD_PLANKS]: Math.max(1, TRAVEL_TRASH - (STANDARD_KIT[STANDARD_PLANKS] || 0)), milk_bucket: 1 }),
  }),
});

// A range read out of order would let a body take a worse piece as an upgrade: each row's tiers must climb the ladder it
// is ranked on.
const climbs = (tiers, ladder) => tiers.every((t, i) => ladder.includes(t) && (i === 0 || ladder.indexOf(t) > ladder.indexOf(tiers[i - 1])));
for (const [name, kit] of Object.entries(TERMINATOR_KITS)) {
  if (!climbs(kit.armour, ARMOR.tiers)) {
    throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): kit '${name}' armour ${JSON.stringify(kit.armour)} does not climb architect_config.ARMOR.tiers ${JSON.stringify(ARMOR.tiers)}.`);
  }
  if (!climbs(kit.sword, SWORD_TIERS)) {
    throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): kit '${name}' sword ${JSON.stringify(kit.sword)} does not climb SWORD_TIERS ${JSON.stringify(SWORD_TIERS)}.`);
  }
  if (!(Number.isInteger(kit.food.least) && kit.food.least >= 1 && kit.food.want >= kit.food.least)) {
    throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): kit '${name}' food ${JSON.stringify(kit.food)}; least is a whole count of at least 1 and want is no less.`);
  }
  if (!(kit.torches && Number.isInteger(kit.torches.want) && kit.torches.want >= 1)) {
    throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): kit '${name}' torches ${JSON.stringify(kit.torches)}; want is a whole count of at least 1.`);
  }
}
for (const [name, items] of Object.entries({ standard: STANDARD_KIT, ...Object.fromEntries(Object.entries(TERMINATOR_KITS).map(([k, v]) => [`${k} extra`, v.extra])) })) {
  const bad = Object.entries(items).find(([item, n]) => !/^[a-z_]+$/.test(item) || !Number.isInteger(n) || n < 1);
  if (bad) {
    throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): kit '${name}' carries ${JSON.stringify(bad)}; a kit row is an item id and a whole count of at least 1.`);
  }
}
if (!STANDARD_KIT.shield) {
  throw new Error('[terminator_kits] CODING VIOLATION (Law 13): the standard kit carries no shield; every terminator kit relies on one.');
}

// kitNamed(name) → the terminator kit's range. An unknown name is a coding violation.
function kitNamed(name) {
  const kit = TERMINATOR_KITS[name];
  if (!kit) throw new Error(`[terminator_kits] CODING VIOLATION (Law 13): no kit named '${name}'. Known: ${Object.keys(TERMINATOR_KITS).join(' | ')}.`);
  return kit;
}

// kitFor(name) → { item: count }: the kit at its ceiling, the standard kit's sword replaced by the ceiling's.
function kitFor(name) {
  const kit = kitNamed(name);
  const out = { ...STANDARD_KIT };
  for (const item of Object.keys(out)) if (/_sword$/.test(item)) delete out[item];
  const add = (item, n) => { out[item] = (out[item] || 0) + n; };
  add(`${kit.sword[kit.sword.length - 1]}_sword`, 1);
  for (const kind of Object.keys(require('@api/armor').SLOT_OF)) add(`${kit.armour[kit.armour.length - 1]}_${kind}`, 1);
  add('bread', kit.food.want);
  add('torch', kit.torches.want);
  for (const [item, n] of Object.entries(kit.extra)) add(item, n);
  return out;
}

module.exports = { STANDARD_KIT, TERMINATOR_KITS, SWORD_TIERS, kitNamed, kitFor, TRAVEL_TRASH, TRAVEL_TRASH_LOW };
