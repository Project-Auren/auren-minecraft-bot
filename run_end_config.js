// module: run_end_config
// purpose: HOW A RUN ENDS, on one page. Every way a crewed run can end is here and nowhere else: the clock, the goal, and
//          each stop as a toggle. foreman_config reads this page for the run's soak, ends, watch and wake.
//
// THE CLOCK ALWAYS ENDS A RUN. A run with no end records nothing useful for hours, so `minutes` is required and above
// zero; the foreman refuses to start a crew without it (foreman_plan.check). A goal or a stop may end it sooner.
// A test (`--test`) raises no crew and records no work: it ends itself, or the bench or person that opened it does.
//
// Each value has an environment variable named beside it, and start_auren's flags set them for one run:
//   --soak <minutes>   --ends soak|built|real|held:<item>:<count>   --watch true|false   --wake error,loop,crash,death,lost

'use strict';

// The stops a run can be ended by, in the order the foreman checks them (foreman/utils/run_watch.wakeReason).
const STOPS = Object.freeze(['error', 'loop', 'crash', 'death', 'lost']);

function minutes() {
  const raw = process.env.AUREN_SOAK;
  if (raw === undefined || raw === '') return 15;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;     // a malformed value is refused by name at start (foreman_plan.check)
}

// AUREN_WATCH 'false' turns every stop off; AUREN_WAKE names the stops that are on, and the rest are off.
function stops() {
  const on = process.env.AUREN_WATCH === 'false' ? []
    : process.env.AUREN_WAKE ? process.env.AUREN_WAKE.split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULT_ON;
  return Object.freeze(Object.fromEntries([...STOPS, ...on.filter(s => !STOPS.includes(s))].map(s => [s, on.includes(s)])));
}

// THE STOPS ON BY DEFAULT: every one, so a run ends at the first thing that goes wrong.
const DEFAULT_ON = Object.freeze(['error', 'loop', 'crash', 'death', 'lost']);

module.exports = {

  // 1. THE CLOCK — minutes the run lasts once the crew is working; then the foreman sends the bots home and stops a world
  //                it started. Required, above zero.                  environment: AUREN_SOAK
  minutes: minutes(),

  // 2. THE GOAL — what ends the run early because it was reached.
  //      'soak'   none: the clock alone.
  //      'built'  the moment a bot reads the main build (the large build, else the bot hive) standing whole.
  //      'real'   as 'built', and no cell still stands as its planks (architect_config.STAND_INS).
  //      'held:<item>:<count>'  the moment the fleet holds that many of the item, every pocket and chest together (the
  //               foreman's item book), e.g. 'held:diamond:64'.
  //                                                                   environment: AUREN_ENDS
  goal: process.env.AUREN_ENDS || 'soak',

  // 3. THE STOPS — each one on ends the run the moment it happens and says what it was; off, the run carries on and the
  //                verdict at the end still counts it.
  //      error  a body reports any other error
  //      loop   the judge catches a body repeating one job (INFINITE LOOP DETECTED)
  //      crash  a body reports a state the design makes impossible and ends itself (IMPOSSIBLE STATE, STUCK FOR,
  //             KEEPER_UNVERIFIED); off, that body alone stops and the crew works on
  //      death  a body dies
  //      lost   a body leaves the fleet and does not come back (a crashed body is one)
  //                                                                   environment: AUREN_WATCH, AUREN_WAKE
  stops: stops(),

  STOPS,
};
