'use strict';
// bot_mandate.js — WHAT THIS PROCESS IS TOLD AT BIRTH, decided once and never again.
// Every body is the same crew (architect_config.CREW); what the crew fears and raises is the difficulty's and the
// config's, read here for the body.

const { CREW } = require('@thinking/architect_config');

// The separator every building room key is joined with, from the schema all three processes share (Law 16).
const { BUILDING_ROOM_SEPARATOR } = require('@foreman/message_schema');

// Read once and frozen, so a launch fact can never change mid-life.
let mandate = null;

// readMandate — the ONE place the launch environment is interpreted (Law 16). Never defaults: a missing BOT_ID is a
// fault, never a value (Law 13), and refuses to boot.
function readMandate(env = process.env) {
  if (mandate) return mandate;

  const botId = env.BOT_ID;
  if (!botId || String(botId).trim() === '') {
    throw new Error('CODING VIOLATION (Law 13): BOT_ID is not set, so this process has no name to hold a mandate under.');
  }

  // A launch fact, frozen here so a bot cannot decide mid-life whether it was told to work.
  const autostart = String(env.BOT_AUTOSTART === undefined ? '' : env.BOT_AUTOSTART).trim() === '1';

  // A birth fact like the rest: the cell the foreman placed this body on, or none.
  const rawCell = env.BOT_START_CELL;
  const startCell = rawCell === undefined || rawCell === null ? '' : String(rawCell).trim();

  // A continued body's home: the alpha structure's standing cell, where it is put only if it logs in at world spawn.
  const homeCell = String(env.BOT_HOME_CELL === undefined || env.BOT_HOME_CELL === null ? '' : env.BOT_HOME_CELL).trim();

  // No `site` field: the foreman writes the site into its own memory before spawning; the body reads
  // it from the first broadcast (`start_injector`).
  mandate = Object.freeze({ botId: String(botId).trim(), autostart, startCell: startCell || null, homeCell: homeCell || null });
  return mandate;
}

// fearsTheNight — does darkness close outdoor work? Exactly when the crew's difficulty (architect_config.CREW_DIFFICULTY)
// spawns monsters.
function fearsTheNight() {
  return require('@thinking/architect_config').CREW_DIFFICULTY !== 'peaceful';
}

// beginsWorkAtBirth — does this body inject its own start signal on spawn? Asked once by master_core.
// A body does only when the foreman stamped `BOT_AUTOSTART`.
function beginsWorkAtBirth() { return readMandate().autostart; }

// startCell — the cell ("x y z") this body must stand on before working, or null when unplaced (Law 13).
function startCell() { return readMandate().startCell; }

// homeCell — the alpha structure's cell ("x y z") a continued body is put on if it logs in at world spawn, or null.
function homeCell() { return readMandate().homeCell; }

// buildingRoomKey(name) — which base a structure belongs to: the crew half is architect_config.CREW, never passed in
// (Law 27).
function buildingRoomKey(name) {
  if (!name || typeof name !== 'string') {
    throw new Error(`CODING VIOLATION (Law 13): buildingRoomKey needs a room name, got '${name}'. `
      + 'A room key with no structure in it addresses nothing.');
  }
  return `${name}${BUILDING_ROOM_SEPARATOR}${CREW}`;
}

// homeBlueprint — the crew's home structure, read from architect_config.ALPHA_STRUCTURE (Law 16): the headframe.
// Required lazily since architect_config loads before this file finishes.
function homeBlueprint() { return require('@thinking/architect_config').ALPHA_STRUCTURE; }

// For the banner and the watcher trace — a run must be able to say what difficulty it works on.
function describeMandate() {
  const m = readMandate();
  const difficulty = require('@thinking/architect_config').CREW_DIFFICULTY;
  return `${m.botId}: works on ${difficulty}, ${fearsTheNight() ? 'fears the night' : 'works through the night'}`;
}

// Tests and the probe harness need a clean slate between simulated boots; not part of the running
// fleet's normal surface.
function _resetForTesting() { mandate = null; }

module.exports = {
  readMandate,
  buildingRoomKey,
  beginsWorkAtBirth,
  startCell,
  homeCell,
  fearsTheNight,
  homeBlueprint,
  describeMandate,
  _resetForTesting,
};
