'use strict';
// Where the foreman lands to site a base and raise its crew: the one definition. The harness that teleports
// its stand-in player (proxy_human `--stand=biome`) and voxel_snapshot, which captures the loaded area round
// such a landing, use the same rule (Law 16).
//
// A SPOT IS EXACTLY THESE, and the list stops there:
//   · at least `landingFloor` blocks from world spawn, Chebyshev — the protected region is a SQUARE, so a
//     Euclidean test passes cells inside its corners. The caller holds its ring sweep to that distance.
//   · the surface of the column is readable (`surfaceY`, the topmost ground — `floorNearest` would let a cave
//     floor at the reference height beat grass above it);
//   · the biome at the feet settles (architect_config.settles) — the list the foreman and find_buildingspot gate on;
//   · the feet are no higher than SEA_LEVEL + LANDING_MAX_ABOVE_SEA — the foreman's crew raise refuses a landing
//     above that;
//   · a 3×3 floor centred on the feet with 2 clear above every cell, read as it stands (`evaluateOpenBox`).
//
// THE CLEARANCE IS THE PROTECTED SQUARE PLUS ONE WHOLE LOADED AREA: inside the square the server refuses every
// break and placement by a non-op, and a body's own blockAt reads it as bedrock (spawn_protection.maskWorldReads),
// so ground there is never what it reads. A body standing on the landing loads the chunks within the server's view
// distance of its own chunk, and a loaded area is two view distances wide, so a landing that far beyond the square's
// edge loads no protected block (viewClearOfSpawn measures it), and a body on a base sited round it loads none in
// the direction of spawn either. BASE_CLEAR_OF_SPAWN and BASE_MARGIN stay floors for a small view distance.

const { settles, BASE_CLEAR_OF_SPAWN, SEA_LEVEL, LANDING_MAX_ABOVE_SEA } = require('@thinking/architect_config');
const { surfaceY, evaluateOpenBox, REASON } = require('@utils/site_geometry');

const BASE_MARGIN = 32;

const CHUNK = 16;

// landingFloor(protectionRadius, viewDistance) → the least Chebyshev distance from world spawn a landing may lie.
//   viewDistance: the server's view distance in chunks (bot.game.serverViewDistance), required — the rule is about it.
function landingFloor(protectionRadius, viewDistance) {
  if (!Number.isFinite(viewDistance) || viewDistance <= 0) {
    throw new Error(`[landing_spot] CODING VIOLATION: landingFloor needs the server's view distance; got ${viewDistance}.`);
  }
  return Math.max(BASE_CLEAR_OF_SPAWN, protectionRadius + BASE_MARGIN, protectionRadius + loadedArea(viewDistance));
}

// loadedArea(viewDistance) → the width in blocks of the square one body loads round itself.
function loadedArea(viewDistance) { return 2 * viewDistance * CHUNK; }

// viewClearOfSpawn(cell, box, viewDistance) → how many blocks the farthest chunk a body standing at cell loads stays
// clear of the protected square (negative: that many blocks of it are loaded). box: spawnProtectionBox.
function viewClearOfSpawn(cell, box, viewDistance) {
  const chunkEdge = (v, dir) => (Math.floor(v / CHUNK) + dir * viewDistance) * CHUNK + (dir > 0 ? CHUNK - 1 : 0);
  const gapX = Math.max(box.centerX - box.radius - chunkEdge(cell.x, 1), chunkEdge(cell.x, -1) - (box.centerX + box.radius));
  const gapZ = Math.max(box.centerZ - box.radius - chunkEdge(cell.z, 1), chunkEdge(cell.z, -1) - (box.centerZ + box.radius));
  return Math.max(gapX, gapZ) - 1;
}

// landingSpotTest(reader, biomeAt, refY) → (x, z) => verdict, the ring sweep's predicate.
//   biomeAt(x, y, z) → biome name or null; the caller supplies the one biome read it has (biome_scanner).
function landingSpotTest(reader, biomeAt, refY) {
  return (x, z) => {
    const top = surfaceY(reader, x, z, refY);
    if (!top) return { valid: false, reason: reader.blockAt(x, refY, z) === null ? REASON.UNLOADED : REASON.NO_FLOOR };
    const biome = biomeAt(x, top.y + 1, z);
    if (!settles(biome)) return { valid: false, reason: 'wrong_biome' };
    if (top.y + 1 > SEA_LEVEL + LANDING_MAX_ABOVE_SEA) return { valid: false, reason: 'too_high' };
    const standing = evaluateOpenBox(reader, x, z, top.y, { size: 3, height: 2, occupancy: 'as-is' });
    return standing.valid ? { ...standing, biome } : standing;
  };
}

module.exports = { landingSpotTest, landingFloor, loadedArea, viewClearOfSpawn, BASE_MARGIN };
