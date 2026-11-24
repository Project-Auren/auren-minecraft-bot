'use strict';
// entity_velocity — every entity's velocity reads in blocks per tick, as the server sent it.
//
// On protocols that carry velocity as an lpVec3 (26.1), node-minecraft-protocol already decodes it to blocks per tick.
// mineflayer still divides it by 8000, the scale of the older short-integer velocity, so every velocity it stores from
// spawn_entity and entity_velocity is 8000 times too small. For the body itself that drops the knockback the server
// sends: a player's client applies it and moves, so a bot that does not is immune to a mechanic every player meets.
// For other entities it reads every arrow, mob and item as standing still.
//
// install(bot) listens after mineflayer, on the same two packets, and sets the entity's velocity to the decoded value
// whenever the packet's velocity field is an lpVec3. On protocols with the older field it does nothing.

function velocityIsDecoded(bot, packetName) {
  const types = bot.registry && bot.registry.protocol && bot.registry.protocol.play
    && bot.registry.protocol.play.toClient && bot.registry.protocol.play.toClient.types;
  const shape = types && types[packetName];
  const fields = Array.isArray(shape) && Array.isArray(shape[1]) ? shape[1] : [];
  const field = fields.find((f) => f && f.name === 'velocity');
  return !!field && field.type === 'lpVec3';
}

function install(bot) {
  if (!bot || !bot._client || bot._aurenEntityVelocity) return;
  bot._aurenEntityVelocity = true;
  const set = (packet) => {
    const v = packet && packet.velocity;
    const entity = bot.entities && bot.entities[packet.entityId];
    if (!v || !entity || !entity.velocity) return;
    entity.velocity.set(v.x, v.y, v.z);
  };
  if (velocityIsDecoded(bot, 'packet_entity_velocity')) bot._client.on('entity_velocity', set);
  if (velocityIsDecoded(bot, 'packet_spawn_entity')) bot._client.on('spawn_entity', set);
}

module.exports = { install };
