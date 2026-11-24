// module: tools/lanista_striker — lanista's `--striker` body: a mineflayer client with no mind that never
// moves. It faces the nearest arena mob and swings the moment the mob is inside a player's reach and the
// held weapon is fully recharged, and nothing else.
//
// Answers one question the fleet's own fighter cannot: what a stationary body does to a mob by cooldown
// swings alone. The fleet bot walls, shields and steps; this one only stands and swings.
//
// Its account of the fight (swings, the mob's closest approach, the creeper's swell, an explosion packet)
// is the body's side, carried beside lanista's server reads and never in place of them (Law 26).

'use strict';

const paths = require('../workshop_paths');
paths.bootstrapModules();

const { weaponProfile } = require('@utils/calculators/attack_cadence_calculator');
const { BOT_STRIKE_REACH } = require('@utils/combat_utils');
const fuseMeter = require('@api/combat_counters/fuse_meter');

// Server tick; the swing is checked on every physics tick.
const MOB_SIGHT = 16;     // b — an arena mob farther than this is not faced
const EYE = 1.62;

// eyeToBox(eye, entity) → distance from the eye to the nearest point of the entity's box: the server's reach measure.
function eyeToBox(eye, e) {
  const half = (e.width || 0.6) / 2, h = e.height || 1.8, p = e.position;
  const cx = Math.max(p.x - half, Math.min(eye.x, p.x + half));
  const cy = Math.max(p.y, Math.min(eye.y, p.y + h));
  const cz = Math.max(p.z - half, Math.min(eye.z, p.z + half));
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
}

// ── WHERE THE MOB IS NOW, NOT WHERE IT WAS LAST SAID TO BE ──────────────────────────────────────────
// The server sends a walking mob's position only every few ticks, so between updates the client holds a stale
// position. A creeper lights its fuse 3.0 b from the body, centre to centre, and the body's 3.0 b reach to the
// box first touches it about 3.4 b out: a window about one update wide. `leadMs` (null = off) carries the last
// position forward along the speed measured between the last two updates, to `leadMs` past now, and the reach
// is judged there. The reach itself stays 3.0 b; only the stale position is corrected.
function predicted(track, e, now, leadMs) {
  if (leadMs == null || !track || !track.v) return e.position;
  const dt = Math.min(250, now - track.at + leadMs) / 1000;
  return e.position.offset(track.v.x * dt, 0, track.v.z * dt);
}

// createStriker({ host, port, version, username, mobs, leadMs }) → handle. `mobs` lists the species it swings at.
function createStriker({ host, port, version, username, mobs, leadMs = null }) {
  const mineflayer = require('mineflayer');
  const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
  let spawned = false, armed = false, lastSwingAt = 0, round = null;

  bot.once('spawn', () => { spawned = true; });
  bot.on('kicked', (why) => console.log(`[STRIKER] kicked — ${typeof why === 'string' ? why : JSON.stringify(why)}`));
  bot.on('error', (e) => console.log(`[STRIKER] error — ${e.message}`));

  // The server's own blast announcement.
  bot._client.on('explosion', (p) => { if (round) round.explosions.push({ at: Date.now() - round.t0, x: p.x, y: p.y, z: p.z }); });

  // id → { at, pos, v } off the last two position updates; and the gaps between updates, for the account.
  const tracks = {};
  bot.on('entityMoved', (e) => {
    if (!mobs.includes(e.name)) return;
    const now = Date.now(), t = tracks[e.id];
    if (t && now > t.at) {
      const dt = (now - t.at) / 1000;
      t.v = { x: (e.position.x - t.pos.x) / dt, z: (e.position.z - t.pos.z) / dt };
      if (round && round.mobs[e.id]) round.mobs[e.id].gaps.push(now - t.at);
    }
    tracks[e.id] = { at: now, pos: e.position.clone(), v: t ? t.v : null };
  });

  function heldCooldownMs() {
    const held = bot.heldItem;
    return weaponProfile(held ? held.name : null).cooldownMs;
  }

  function nearestMob() {
    const me = bot.entity && bot.entity.position;
    if (!me) return null;
    let best = null;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !mobs.includes(e.name)) continue;
      const d = e.position.distanceTo(me);
      if (d <= MOB_SIGHT && (!best || d < best.d)) best = { e, d };
    }
    return best;
  }

  function tick() {
    if (!armed || !round) return;
    bot.clearControlStates();
    const near = nearestMob();
    if (!near) return;
    const { e, d } = near;
    const me = bot.entity.position;
    const eye = { x: me.x, y: me.y + EYE, z: me.z };
    const at = predicted(tracks[e.id], e, Date.now(), leadMs);
    const reach = eyeToBox(eye, { position: at, width: e.width, height: e.height });
    const s = round.mobs[e.id] || (round.mobs[e.id] = {
      name: e.name, closest: Infinity, closestReach: Infinity, swellTicks: 0, everSwelled: false, firstSwellAt: null, gaps: [],
    });
    s.closest = Math.min(s.closest, d);
    s.closestReach = Math.min(s.closestReach, reach);
    const dir = e.name === 'creeper' ? fuseMeter.swellDir(bot, e) : null;
    if (dir === fuseMeter.UP) {
      s.swellTicks++;
      if (!s.everSwelled) { s.everSwelled = true; s.firstSwellAt = Date.now() - round.t0; }
    }
    bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.5, 0), true);
    const cooldownMs = heldCooldownMs();
    const ready = Date.now() - lastSwingAt >= cooldownMs;
    if (ready && reach <= BOT_STRIKE_REACH) {
      bot.attack(e);
      lastSwingAt = Date.now();
      round.swings.push({ at: lastSwingAt - round.t0, mob: `${e.name}#${e.id}`, centre: +d.toFixed(2), reach: +reach.toFixed(2),
        seen: +eyeToBox(eye, e).toFixed(2), swelling: dir === fuseMeter.UP, lit: s.everSwelled });
    }
  }
  bot.on('physicsTick', tick);

  return {
    bot,
    isReady: () => spawned,
    held: () => (bot.heldItem ? bot.heldItem.name : 'fist'),
    cooldownMs: heldCooldownMs,
    // Opens a round: the body starts swinging and its account starts fresh.
    begin() { round = { t0: Date.now(), swings: [], explosions: [], mobs: {} }; armed = true; },
    // Closes the round and hands back the body's account.
    finish() {
      armed = false;
      const r = round; round = null;
      if (!r) return null;
      const mobsSeen = Object.entries(r.mobs).map(([id, m]) => ({
        id, ...m, gapMs: m.gaps.length ? Math.round(m.gaps.reduce((a, b) => a + b, 0) / m.gaps.length) : null,
        litAfterSwings: r.swings.filter((w) => w.mob.endsWith(`#${id}`) && !w.lit).length, closest: Number.isFinite(m.closest) ? +m.closest.toFixed(2) : null,
        closestReach: Number.isFinite(m.closestReach) ? +m.closestReach.toFixed(2) : null,
      }));
      return { swings: r.swings, explosions: r.explosions, mobs: mobsSeen };
    },
    end() { try { bot.quit(); } catch (_) {} },
  };
}

module.exports = { createStriker, eyeToBox };
