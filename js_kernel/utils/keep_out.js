'use strict';
// keep_out — the ground no base takes: the one answer the base's siting and its surface survey ask (Law 16).
//
// THE SITING LIST, and it stops there (keptOut):
//   · near_world_spawn  within BASE_CLEAR_OF_SPAWN (Chebyshev) of world spawn, where the server refuses a non-op's
//                       every block and the body reads bedrock (spawn_protection).

const { BASE_CLEAR_OF_SPAWN } = require('@thinking/architect_config');

// keptOut(bot) → (minX, maxX, minZ, maxZ) => reason or null, for a footprint box (a single column is minX===maxX).
function keptOut(bot) {
  const spawnAt = require('@perception/spawn_protection').worldSpawnPoint(bot);
  return (minX, maxX, minZ, maxZ) => {
    if (spawnAt && Math.max(Math.max(minX - spawnAt.x, spawnAt.x - maxX, 0),
      Math.max(minZ - spawnAt.z, spawnAt.z - maxZ, 0)) < BASE_CLEAR_OF_SPAWN) return 'near_world_spawn';
    return null;
  };
}

module.exports = { keptOut };
