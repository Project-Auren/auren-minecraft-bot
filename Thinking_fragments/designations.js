// designations — WHY A BODY IS NOT PLANNING THROUGH THE JOB BOARD. Data, checked once at load.
//
// Every body is the same body. A body whose planning turn goes to the job board (recursive_judge's planner door) is a
// BOT, letter B: the default, carrying the standard kit and borrowing a job's tools as the job asks (SIGNED_OUT_ITEMS).
// It needs no designation. Any other letter names a body whose next move something other than the job board picks, and
// says why it differs from every other body. A body defending itself is not designated: battle stations, the run for
// life and eating hold under every letter, B included.
//
// A designation is written <letter>-<kit>[<engine>]:
//   letter  what picks the body's next move instead of the job board (LETTERS);
//   kit     the number of the kit that letter's body carries on top of the standard kit (the letter's kit table);
//   engine  the battle engine it fights by (ENGINES); no letter is the original engine.
// So T-1 is a terminator in kit T-1 fighting the original way, and T-1A the same body and kit fighting by the field ahead.
//
// THE PLANNER IS THE LETTER'S. Each letter names the fragment its body's planning turn goes to (`planner`); a bot's is the job
// board. recursive_judge reads it (plannerOf) and passes the turn on: the judge checks for loops and decides no route of its
// own. Which body carries which letter, and when it stops, is decided in planning: a terminator's own planner steps it down
// when its kit falls below the floor and the chests cannot lift it.
//
// LETTERS
//   T  TERMINATOR: it hunts threats instead of planning work. Its planner is action_fragments.js/terminator_planner: it
//      keeps its kit from the chests, past their minimums, kit and food only; goes to every help call it is summoned to;
//      hunts what it sees near the base; and holds a post. A bot takes it as a job, the crew's terminator seat
//      (assessors/terminator_duty, TERMINATOR_SEATS), and keeps it full time until its planner steps it down.
//      It never runs from a fight (self_preservation), and it takes the pack a worker leaves be (combat_utils
//      TERMINATOR_TAKES). Its kits are terminator_kits'.
//
// ENGINES
//   A  THE FIELD AHEAD (prediction_engine): FOR HUMAN PLAYERS. With a player in the field (combat_utils.fieldAheadOn), the
//      feet walk a mixed field by its price (driver) and the raised guard faces every shooter (gunner guardBearing);
//      against monsters it fights as the T-1 does. The fleet fights no player today. The alpha prototype: worn only
//      where a test names it (the march's --module-kits, colosseum --terminator), fielded only after much more testing.

'use strict';

const { TERMINATOR_KITS } = require('./terminator_kits');

const DEFAULT = 'B';
const DEFAULT_PLANNER = 'job_board';
const LETTERS = Object.freeze({
  T: Object.freeze({ name: 'terminator', kits: TERMINATOR_KITS, planner: 'terminator_planner' }),
});
const ENGINES = Object.freeze({ A: 'field_ahead' });

const FORM = /^([A-Z])-(\d+)([A-Z]?)$/;

// parse(designation) → { letter, kit, engine }: kit the kit's own name (`T-1`), engine an ENGINES letter or null. An unknown
// letter, kit or engine is a coding violation, never a body that quietly plans as a B (Law 13).
function parse(designation) {
  const m = FORM.exec(String(designation));
  if (!m) throw new Error(`[designations] CODING VIOLATION (Law 13): '${designation}' is not <letter>-<kit>[<engine>], as T-1 or T-1A.`);
  const [, letter, number, engine] = m;
  const row = LETTERS[letter];
  if (!row) throw new Error(`[designations] CODING VIOLATION (Law 13): '${designation}' names letter ${letter}. Known: ${Object.keys(LETTERS).join(' | ')} (B is no designation).`);
  const kit = `${letter}-${number}`;
  if (!row.kits[kit]) throw new Error(`[designations] CODING VIOLATION (Law 13): '${designation}' names kit ${kit}. Known: ${Object.keys(row.kits).join(' | ')}.`);
  if (engine && !ENGINES[engine]) throw new Error(`[designations] CODING VIOLATION (Law 13): '${designation}' names engine ${engine}. Known: ${Object.keys(ENGINES).join(' | ')}.`);
  return Object.freeze({ letter, kit, engine: engine || null });
}

// plannerOf(designation) → the fragment that designation's planning turn goes to: the job board for a bot (DEFAULT), else
// its letter's planner.
function plannerOf(designation) {
  return designation === DEFAULT ? DEFAULT_PLANNER : LETTERS[parse(designation).letter].planner;
}

for (const [letter, row] of Object.entries(LETTERS)) {
  if (letter === DEFAULT) throw new Error(`[designations] CODING VIOLATION (Law 13): ${DEFAULT} is the job board's body and carries no designation.`);
  if (typeof row.planner !== 'string' || !row.planner) throw new Error(`[designations] CODING VIOLATION (Law 13): letter ${letter} names no planner; every letter's body plans through one.`);
  for (const kit of Object.keys(row.kits)) {
    if (!kit.startsWith(`${letter}-`)) throw new Error(`[designations] CODING VIOLATION (Law 13): letter ${letter}'s kit '${kit}' is not named ${letter}-<number>.`);
  }
}

module.exports = { DEFAULT, DEFAULT_PLANNER, LETTERS, ENGINES, parse, plannerOf };
