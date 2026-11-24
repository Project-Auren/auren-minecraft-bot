// The tunable dials for the movement family, in one place. Nothing here decides anything; it holds the
// numbers the primitives read, so a re-tune is one edit (Law 16).
//
// Scaffold and structural fill invert priority on the same block group: pillars and bridges are
// throwaway and sit on the open path, so they read the scaffold order (cheapest-to-replace first: soil,
// sediment, then crafted goods); permanent fill reads structural_fill (cobblestone first). Re-tune the
// ORDER in fragment_utils, never here.

'use strict';

const { group_to_item } = require('@utils/fragment_utils');


// ── SECTION 3: Configuration Objects ──
const movementConfig = {
  faceDuration: 150,
  forwardDuration: 250,
  tapDuration: 100,
  postMoveDelay: 100,
  jumpPauseDuration: 150,
  jumpTapDuration: 400,
};

const escalationConfig = {
  enabled: true,
  maxEscalationAttempts: 1,
  tapAttemptsBeforeEscalation: 2,
  pulseDuration: 150
};

// How driveRun points the head while it walks. The head is the first-person camera: a spectating client
// renders the bot's own yaw, so every snap in it is a snap on screen.
//   carrotBlocks — the steering point sits this far along the route ahead of the body, so the bearing
//     never swings round a point the body is standing on, and an open staircase corner is walked as a
//     diagonal.
//   holdRadius — inside this flat distance of the steering point the yaw is held and the legs (WSAD
//     relative to the held yaw) close the gap; near the point its bearing is ill-conditioned and flips.
//   yawRateDegPerSec — the most the yaw turns per second while walking. Travel does not wait on it: the
//     keys are chosen against the yaw actually held, so the body's heading error stays under 22.5°.
//     null turns at once.
const travelSteerConfig = {
  carrotBlocks: 1.5,
  holdRadius: 0.6,
  yawRateDegPerSec: 360,
};

function setMovementConfig(partial) { Object.assign(movementConfig, partial || {}); }
function setEscalationConfig(partial) { Object.assign(escalationConfig, partial || {}); }
function getMovementConfig() { return movementConfig; }
function getEscalationConfig() { return escalationConfig; }

// defaultPriority: derived from the canonical throwaway order, one source of truth (Law 16); re-tune the
// order in fragment_utils, not here.
//
// pillar_block, not scaffold_block and not structural_fill:
//   · vs structural_fill — scaffolding is throwaway (spend the cheapest first); fill is permanent (spend
//     the most durable first). Same members, inverted priority.
//   · vs scaffold_block — gravel and sand are legal PILLAR blocks and illegal BRIDGE blocks: a pillar
//     block lands supported, a bridge block lands over air (Law 17). BRIDGE_PREFS below is the filtered
//     exposure of the same order; the two reads stay separate.
const pillarConfig = {
  jumpHoldMs: 350,
  postJumpSettleMs: 100,
  debug: false,
  defaultPriority: [...group_to_item.pillar_block]
};

// Bridging lays the same throwaway material as pillaring in the same order, minus the gravity blocks a
// bridge cannot carry (see pillarConfig above). Declared once here so tryBridgeStep and stepHorizontal
// read the same order (Law 16).
//
// No `|| [fallback]` on either read: both groups are module constants, so an absent one is a coding
// violation, not an environmental failure (Law 13: never default a missing field; Law 16: no fallback
// that silently does the primary's job).
const BRIDGE_PREFS = [...group_to_item.scaffold_block];

function setPillarConfig(partial) { if (partial && typeof partial === 'object') Object.assign(pillarConfig, partial); }
function getPillarConfig() { return pillarConfig; }

module.exports = {
  movementConfig,
  escalationConfig,
  setMovementConfig,
  setEscalationConfig,
  getMovementConfig,
  getEscalationConfig,
  pillarConfig,
  travelSteerConfig,
  BRIDGE_PREFS,
  setPillarConfig,
  getPillarConfig,
};
