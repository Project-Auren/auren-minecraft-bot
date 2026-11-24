'use strict';
// item_use_slowdown — a body using an item walks at a fifth of its speed and does not sprint, and a body sprints only
// walking forward, as a vanilla client does.
//
// Minecraft's client multiplies its walking input by 0.2 while an item is in use (a raised shield, a drawn bow, food
// being eaten) and the server takes the client's word for the movement. prismarine-physics has no such step, so a bot
// with its shield raised walks backwards at full walking speed (4.27 b/s on 26.1), where a player walks at about
// 0.86 b/s. The bot plays by the same mechanics as a player, so this step is added here.
//
// install(bot) wraps the physics engine mineflayer exposes as bot.physics: each tick the bot is using an item, the
// simulated player is handed a copy of its controls with every walking key scaled to USE_ITEM_INPUT and sprint off.
// The engine reads the keys as numbers (strafe = right - left, forward = forward - back), so a scaled key moves the body
// at the scaled rate. The real control state, and what is sent to the server, are untouched.
//
// WHEN AN ITEM IS IN USE is read from the bot's own raise and lower. mineflayer's `usingHeldItem` drops on any status
// packet about the body while a shield stays raised, so the raise is recorded here: bot.activateItem starts a use in the
// hand it names, bot.deactivateItem ends it, and a held-item change ends a main-hand use as the server does. Eating goes
// through mineflayer's own consume, which only `usingHeldItem` sees, so either reading slows the body.
const USE_ITEM_INPUT = 0.2;
const WALK_KEYS = ['forward', 'back', 'left', 'right'];

function install(bot) {
  const physics = bot.physics;
  if (!physics || typeof physics.simulatePlayer !== 'function') {
    throw new Error('[item_use_slowdown] bot.physics.simulatePlayer is missing: the item-use slowdown cannot be applied');
  }
  if (physics.simulatePlayer.itemUseSlowdown) return;
  let raisedHand = null;   // 'off' | 'main' while a raise this module saw is held, else null
  const activate = bot.activateItem.bind(bot);
  const deactivate = bot.deactivateItem.bind(bot);
  bot.activateItem = (offHand = false, ...rest) => { const r = activate(offHand, ...rest); raisedHand = offHand ? 'off' : 'main'; return r; };
  bot.deactivateItem = (...args) => { raisedHand = null; return deactivate(...args); };
  bot.on('heldItemChanged', () => { if (raisedHand === 'main') raisedHand = null; });
  bot.on('death', () => { raisedHand = null; });
  const simulate = physics.simulatePlayer.bind(physics);
  const slowed = (state, world) => {
    if ((raisedHand !== null || bot.usingHeldItem) && state && state.control) {
      const control = { ...state.control, sprint: false };
      for (const k of WALK_KEYS) control[k] = state.control[k] ? USE_ITEM_INPUT : 0;
      state.control = control;
    } else if (state && state.control && state.control.sprint && !state.control.forward) {
      // A player sprints only while walking forward: sideways or backwards, the sprint key does nothing.
      state.control = { ...state.control, sprint: false };
    }
    return simulate(state, world);
  };
  slowed.itemUseSlowdown = true;
  physics.simulatePlayer = slowed;
}

module.exports = { install, USE_ITEM_INPUT };
