'use strict';
// foreman_plan.js — the run as configured: foreman_config's fields, checked whole and said back in words.
//
// Read once, at the top of foreman.js, before the hub restores the fleet's memory: a 'rollback' start
// empties that memory, so this must check it before the hub loads it (Law 13). Every field names the
// values it permits (Law 29); anything else is refused by name and nothing starts.

const fs = require('fs');
const path = require('path');

const CONFIG = require('../foreman_config');
const { DIFFICULTIES, BOT_SENIORITY, CREW_DIFFICULTY, LARGE_BUILD, MAIN_BUILD, PLANNED_BUILDS } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');
const testModes = require('./utils/test_modes');

const PERMITTED = {
  where: ['local', 'remote'],
  start: ['rollback', 'continue'],
  difficulty: DIFFICULTIES,
  clock: ['dawn', 'day', 'held'],
  record: ['off', 'cameras', 'film'],
  go: ['now', 'held', 'operator'],
  landing: ['usual', 'random'],
  windowsPriority: ['normal', 'high'],
  memoryWorkspace: ['adaptive', 'off'],
};
const WAKES = require('../run_end_config').STOPS;

// check() → { ok, wrong: [sentence…] } — every fault at once, so one edit of the page fixes them all.
function check() {
  const wrong = [];
  for (const [key, allowed] of Object.entries(PERMITTED)) {
    if (!allowed.includes(CONFIG[key])) {
      wrong.push(`${key}: '${CONFIG[key]}' is not one of ${allowed.map(v => `'${v}'`).join(' | ')}.`);
    }
  }
  // THE CLOCK ALWAYS ENDS A RUN (run_end_config): a run with no end records nothing useful for hours. A test raises
  // no crew and keeps no soak: it ends itself, or the bench or person that opened it ends it (test_modes).
  if (typeof CONFIG.soak !== 'number' || !Number.isFinite(CONFIG.soak) || CONFIG.soak < 0 || (CONFIG.soak === 0 && !isTest())) {
    wrong.push(`soak: '${CONFIG.soak}' is not a number of minutes above zero; every run ends on its clock (run_end_config.js).`);
  }
  if (typeof CONFIG.watch !== 'boolean') wrong.push(`watch: '${CONFIG.watch}' is not true or false.`);
  if (!['crew', 'none', 'pair', 'rider'].includes(CONFIG.cameras)
      && !(Number.isInteger(CONFIG.cameras) && CONFIG.cameras > 0)) {
    wrong.push(`cameras: '${CONFIG.cameras}' is not 'crew', 'none', 'pair', 'rider', or a whole number of windows above zero.`);
  }
  const t = testModes.check(CONFIG.test);
  if (!t.ok) wrong.push(`test: ${t.why}`);
  const testStart = testModes.startFor(CONFIG.test);
  if (testStart && CONFIG.start !== testStart) {
    wrong.push(`start: test '${CONFIG.test}' looks at the world the last run left, so it needs start '${testStart}' — `
      + `'${CONFIG.start}' would put the world back to its clean copy and empty the fleet's memory first.`);
  }
  // ENDS is a word on the list, or `held:<item>:<count>` (run_end_config): a bad one stops the run by name.
  if (!['soak', 'built', 'real'].includes(CONFIG.ends) && !endsWhenHeld()) {
    wrong.push(`ends: '${CONFIG.ends}' is not one of 'soak' | 'built' | 'real' | 'held:<item>:<count above zero>'.`);
  }
  const wakes = Array.isArray(CONFIG.wake) ? CONFIG.wake : [];
  for (const w of wakes) if (!WAKES.includes(w)) wrong.push(`wake: '${w}' is not one of ${WAKES.map(v => `'${v}'`).join(' | ')}.`);
  if (!Array.isArray(CONFIG.wake)) wrong.push(`wake: must be a list, e.g. ['error', 'loop', 'crash', 'death', 'lost'].`);
  const count = CONFIG.count;
  const available = Object.keys(BOT_SENIORITY).length;
  if (CONFIG.only) {
    const unknown = CONFIG.only.filter(name => !BOT_SENIORITY[name]);
    if (unknown.length) wrong.push(`only: ${unknown.map(v => `'${v}'`).join(', ')} not in the roster (BOT_SENIORITY).`);
  } else if (!Number.isInteger(count) || count < 2 || count > available) {
    wrong.push(`count: '${count}' must be a whole number from 2 to ${available}, the available roster.`);
  }
  return { ok: wrong.length === 0, wrong };
}

// A test run raises no bots and has no soak. The one place that knows what 'off' means (Law 16).
function isTest() { return CONFIG.test !== 'off'; }
function testName() { return CONFIG.test; }

// A test that keeps the one camera window a person flies, with no bot window beside it.
function seatOnly() { return isTest() && testModes.keepsSeat(CONFIG.test); }

// The cameras this run really has. A test raises no bodies, so it has no camera on one; a seat-only test
// has its seat whatever the page says, since the seat is what it is run for.
function record() {
  if (!isTest()) return CONFIG.record;
  if (!seatOnly()) return 'off';
  return CONFIG.record === 'off' ? 'cameras' : CONFIG.record;
}

// A continued run carries on from the last one: the base is the one in memory and every body starts where
// the last run left it standing. The one place that knows what 'continue' means for the crew (Law 16).
function continues() { return CONFIG.start === 'continue'; }

// The build the run's `ends built` waits for (architect_config.MAIN_BUILD), and every building whose plan it loads
// (PLANNED_BUILDS: the bot hive, and the large build when one is named).
function build() { return MAIN_BUILD; }
function planned() { return PLANNED_BUILDS; }

// Does the run end the moment the building stands? The one place that knows what 'built' means for the run (Law 16).
function endsWhenBuilt() { return CONFIG.ends === 'built' || CONFIG.ends === 'real'; }
// 'real' waits further: no cell of the building still stands as its planks (architect_config.STAND_INS).
function endsWhenReal() { return CONFIG.ends === 'real'; }
// held:<item>:<count> → { item, count }: the run ends once the fleet holds that many of the item, pockets and chests together
// (the foreman's item book). Anything else → null.
function endsWhenHeld() {
  const m = /^held:([a-z0-9_]+):([0-9]+)$/.exec(String(CONFIG.ends || ''));
  return m && Number(m[2]) > 0 ? { item: m[1], count: Number(m[2]) } : null;
}
// A held crew is raised and placed, and waits before any body works: 'held' until the foreman releases it once every body
// stands, 'operator' until the operator's own verb (a bench arming its body, as lanista's gladiator is armed by `sentry`).
function heldForGo() { return CONFIG.go === 'held' || CONFIG.go === 'operator'; }
function foremanReleases() { return CONFIG.go === 'held'; }

// Does the foreman roll where a crew it raises lands? The one place that knows what 'random' means for the run (Law 16).
function landsAtRandom() { return CONFIG.landing === 'random'; }

// Builds the sentence from the fields; the sentence itself is never stored.
function sentence() {
  const bots = `${CONFIG.count} bots making a base${LARGE_BUILD ? ` and ${LARGE_BUILD.replace(/_/g, ' ')}` : ''} on ${CREW_DIFFICULTY}`;
  // The landing is said for a run that lands a crew: a rollback start of a crew the foreman raises itself.
  const crew = continues() ? bots : landsAtRandom() ? `${bots}, landing at random` : bots;
  // A test states its own name in place of a soak length: a test raises no bots and keeps no soak.
  if (isTest()) return `${CONFIG.where} world · ${CONFIG.start} start · TEST ${CONFIG.test}, no bots raised · for ${crew}`;
  const held = endsWhenHeld();
  const soak = held ? `until the fleet holds ${held.count} ${held.item.replace(/_/g, ' ')} (${CONFIG.soak} minutes at most)`
    : endsWhenBuilt() ? `until the ${build().replace(/_/g, " ")} stands${endsWhenReal() ? ' with no planks standing in' : ''} (${CONFIG.soak} minutes at most)` : `${CONFIG.soak} minutes`;
  return`${CONFIG.where} world · ${CONFIG.start} start · ${soak} · ${crew}`;
}
// The overlays, said after the sentence: the clock, the cameras, and whether the run is watched.
function overlays() {
  // A test has no bot cameras (no bodies to frame) and no watch (the watch reads a fleet). Both are stated
  // as absent, so the header never implies one is running.
  const eye = CONFIG.observer ? `watched by ${CONFIG.observer}` : null;
  if (isTest()) return [`clock ${CONFIG.clock}`, seatOnly() ? 'a seat to fly, no bot cameras' : 'no cameras', 'not watched', testModes.describe(CONFIG.test), eye].filter(Boolean).join(' · ');
  return [`clock ${CONFIG.clock}`, CONFIG.record === 'off' ? 'no cameras' : CONFIG.record,
    CONFIG.watch ? `watched (wakes on ${CONFIG.wake.join(', ')})` : 'not watched', heldForGo() ? (foremanReleases() ? 'crew held for start' : 'crew held for the operator') : null, eye].filter(Boolean).join(' · ');
}

// ── A ROLLBACK START EMPTIES THE FLEET'S MEMORY ──────────────────────────────────────────────────────
// Everything the bots know about the world, together (foreman/fleet_memory names the parts). 'continue' touches none.
function emptyMemory(log) {
  if (CONFIG.start !== 'rollback') { log('start: continue — the bots carry on with what they knew.'); return; }
  let files = 0;
  const r = guardExternalSync('foreman', 'empty the fleet memory', () => { files = require('./fleet_memory').empty(); });
  log(r.ok
    ? `start: rollback — the bots start knowing nothing (${files} headquarters file(s) and the fleet's memory emptied).`
    : `WARNING start: rollback, but the fleet's memory could not be emptied — ${r.reason}. The bots may remember the last run.`);
}

// ── A ROLLBACK START PUTS A LOCAL WORLD BACK TO ITS CLEAN COPY, IF IT HAS ONE ─────────────────────────
// The copy is `world_snapshots/<world>/<world>_fresh_start` in the server folder. The current world is
// deleted and the copy is laid in its place: the foreman saves no world, and a world worth keeping is saved
// by a person before the run. Called by foreman_world with the server down: a world copied under a running
// server is files mid-write.
// freshWorld(serverDir) → { worldName, snapshot }: the world a rollback start puts back and the copy it uses —
// the one statement of the naming rule, which the workshop's benches read too (Law 16).
function freshWorld(serverDir) {
  const worldName = require('@utils/server_settings').levelName(serverDir);
  return { worldName, snapshot: `${worldName}_fresh_start` };
}
function restoreFreshWorld(serverDir, level, log) {
  if (CONFIG.start !== 'rollback') return { restored: false };
  // The world is put back only on a seat whose clearing is authorized (start_auren refuses first; this is the
  // last door before the world is deleted).
  const clear = require('@utils/record_homes').clearAuthorized();
  if (!clear.authorized) return { restored: false, error: `the world was not put back: ${clear.why}` };
  const snaps = path.join(serverDir, 'world_snapshots');
  const fresh = path.join(snaps, level, freshWorld(serverDir).snapshot);
  if (!fs.existsSync(fresh)) {
    log(`start: rollback — this server has no clean copy of '${level}' (looked for ${fresh}), so the world is used as it is.`);
    return { restored: false };
  }
  const world = path.join(serverDir, level);
  const r = guardExternalSync('foreman', `restore '${level}' from its clean copy`, () => {
    fs.rmSync(world, { recursive: true, force: true });
    fs.cpSync(fresh, world, { recursive: true });
  });
  if (!r.ok) return { restored: false, error: `the world '${level}' could not be put back to its clean copy: ${r.reason}` };
  log(`start: rollback — the world '${level}' was put back to its clean copy; the world it replaced is deleted.`);
  return { restored: true };
}

// ── WHERE THE RUN HAS GOT TO, for anybody who asks the door (bench_world waits on it) ─────────────────
//   crew      'waiting' (nothing raised yet, or a test) · 'raising' · 'working' · 'failed'
//   soakEndsAt  when the soak ends, ISO, or null (not started, or 0 = until stopped)
//   closing   why the foreman is shutting down, once it is — the watch reads this as "the run is over"
const progress = { sentence: null, crew: 'waiting', soakEndsAt: null, closing: null };
function note(fields) { Object.assign(progress, fields); }
function progressNow() { return { ...progress, sentence: sentence() }; }

module.exports = { CONFIG, check, sentence, overlays, isTest, testName, seatOnly, record, continues, build, planned, endsWhenBuilt, endsWhenReal, endsWhenHeld, heldForGo, foremanReleases, landsAtRandom, emptyMemory, freshWorld, restoreFreshWorld, note, progressNow };
