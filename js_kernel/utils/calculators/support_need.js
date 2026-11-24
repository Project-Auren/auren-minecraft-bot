// calculator: support_need — which support structures the crew raises, read off its planned buildings (the bot hive,
// and the large build when the run names one) and its difficulty.
//
// A SUPPORT IS RAISED ONLY WHERE SOMETHING NEEDS IT. The mine, the alpha structure and the waste pit always stand;
// every other support answers to a need, walked back from the planned build:
//   roots      the build's every block walked back to its roots (downloaded_plan_registry.blockCounts, the set-aside blocks
//              included, so a block that waits on its producer still counts; build_material_calculator.familyBalance)
//   a pen      the wool pen (`wool`): the LARGE BUILD needs wool. The hive's one bed is shorn off wild sheep near the hive
//              (assessors/wild_wool), so a hive alone raises no pen. The meat pen (`cull_keep` set): the LARGE BUILD needs
//              leather, since a support plans no book (a bookcase in a support is a coding violation: the hive's crafting
//              floor stays off). The two flags are the ones producer_hooks reads for the same producers. Shearing is apart
//              from penning: wool is shorn off wild sheep near the hive, pen or no pen
//   cane       the build needs sugar cane (its paper: books for bookshelves and lecterns)
//   wheat      monsters can spawn (difficulty other than peaceful: the crew eats), or a pen is raised (herding and
//              breeding feed on wheat), or the build needs wheat itself
//   pool       a wheat or cane field is raised: every pour is filled from it
//   proofing   monsters can spawn: the base's spawn proofing lights the ground they would spawn on
// Every number is read off the plan and the config, so the answer is the same before any site is chosen.

'use strict';

let _answer = null;   // the answer, read once

// supportNeed() → { hostile, pens, cane, wheat, pool, proofing, roots }: what the hive and the difficulty ask for.
function supportNeed() {
  if (_answer) return _answer;
  const { CREW_DIFFICULTY, FARM_PENS, HERDING } = require('@thinking/architect_config');
  const { LARGE_BUILD } = require('@thinking/architect_config');
  noSupportBooks();
  const { familyBalance } = require('@utils/calculators/build_material_calculator');
  const rootsOf = (counts) => {
    const out = {};
    for (const [root, row] of Object.entries(familyBalance(counts, {}))) if (row.need > 0) out[root] = row.need;
    return out;
  };
  const roots = rootsOf(plannedBlockCounts());
  const needs = (pattern) => Object.keys(roots).some(root => pattern.test(root));
  const largeRoots = LARGE_BUILD ? rootsOf(plannedBlockCounts([LARGE_BUILD])) : {};
  const largeNeeds = (pattern) => Object.keys(largeRoots).some(root => pattern.test(root));
  const hostile = CREW_DIFFICULTY !== 'peaceful';
  const pens = FARM_PENS.filter((pen) => {
    const row = HERDING.pens[pen];
    return (row.wool && largeNeeds(/_wool$/)) || (row.cull_keep !== null && largeNeeds(/^leather$/));
  });
  const cane = needs(/^sugar_cane$/);
  const wheat = hostile || pens.length > 0 || needs(/^wheat$/);
  _answer = Object.freeze({
    hostile, pens: Object.freeze(pens), cane, wheat, pool: wheat || cane, proofing: hostile, roots: Object.freeze(roots),
  });
  return _answer;
}

// raises(key) → whether the crew raises the structure `key`: a need-gated support only where supportNeed asks for it
// (a field only where critical mass sites it), a support switched off (SUPPORTS_OFF) never, every other structure always.
function raises(key) {
  const { FARM_PENS, FARM_FIELD, SPAWN_PROOFING, SUPPORTS_OFF } = require('@thinking/architect_config');
  if (SUPPORTS_OFF.includes(key)) return false;
  if (FARM_PENS.includes(key)) return supportNeed().pens.includes(key);
  if (key === SPAWN_PROOFING) return supportNeed().proofing;
  if (FARM_FIELD.keys.includes(key)) return require('@utils/calculators/wheat_critical_mass').fieldKeysSited().includes(key);
  return true;
}

// structuresRaised() → STRUCTURE_PRIORITY, in its order, less every support nothing needs.
function structuresRaised() {
  return require('@thinking/architect_config').STRUCTURE_PRIORITY.filter(key => raises(key));
}

// plannedBlockCounts() → { block: count } over every building on the column machine (architect_config.PLANNED_BUILDS:
// the bot hive, and the large build when the run names one), each plan loaded once: what the supports are sized for.
function plannedBlockCounts(names = require('@thinking/architect_config').PLANNED_BUILDS) {
  const plans = require('@kernel/downloaded_plan_registry');
  const counts = {};
  for (const name of names) {
    plans.load(name);
    for (const [block, n] of Object.entries(plans.of(name).blockCounts())) counts[block] = (counts[block] || 0) + n;
  }
  return counts;
}

// noSupportBooks() → throws when a support on the column machine (every planned building but the large build) plans a
// block the library makes (producer_hooks: a bookshelf, a lectern): a book is a culled cow's leather, and only a large
// build merits a pen. The hive builds its enchanting table and bookshelves as planks while its `enchanting` is false.
function noSupportBooks() {
  const { PLANNED_BUILDS, LARGE_BUILD, HIVES } = require('@thinking/architect_config');
  const { producerOf } = require('@kernel/producer_hooks');
  for (const name of PLANNED_BUILDS.filter(n => n !== LARGE_BUILD)) {
    const books = Object.entries(plannedBlockCounts([name])).filter(([block]) => producerOf(block) === 'library');
    if (books.length) {
      throw new Error(`[support_need] CODING VIOLATION (Law 13): the support '${name}' plans ${books.map(([b, n]) => `${n} ${b}`).join(', ')}. `
        + 'A support plans no book: books need leather from a cow pen, and only a large build merits a pen. '
        + (HIVES[name] ? `Keep this hive's crafting floor off (architect_config HIVES.${name}.enchanting false builds them as planks), `
          : 'Take them out of that support plan, ')
        + 'or build the supporting logic that lets a support raise a cow pen.');
    }
  }
}

module.exports = { supportNeed, raises, structuresRaised, plannedBlockCounts, noSupportBooks };
