'use strict';
// module: bow_shot — draw a bow, hold the aim on a target while it charges, loose it where the target
// will be.
//
// mineflayer gives draw (activateItem) and release (deactivateItem); the flight model and the lead are
// `calculators/bow_ballistics`. This file is the body around them: it equips the bow, watches the
// target every physics tick, re-aims every tick of the draw, and lets go at full charge.
//
// The release is timed against mineflayer's own tick. Inside a physicsTick handler the look is set;
// mineflayer sends the rotation right after the handler returns, and the release is written on the next
// microtask, so the server reads the new rotation before the release that fires the arrow.
//
// Nothing in the construct calls this yet. It is a tool for any bow target; the ghast is the one it was
// built for.

const { guardExternal, guardExternalSync } = require('./external_library_guard');
const ballistics = require('./calculators/bow_ballistics');

const TAG = 'bow_shot';
// Client ticks drawn before release. The server counts the draw from when the use packet arrives, so
// two ticks over the 20 of a full charge keep a late packet from loosing a weak arrow.
const DRAW_TICKS = ballistics.BOW_FULL_DRAW_TICKS + 2;
// Ticks from the answer to the arrow's first tick in the world: the release reaches the server inside
// the next server tick, and the arrow moves on the tick after it is made.
const LEAD_TICKS = 1;
// How much of the target's recent track the motion fit reads.
const TRACK_WINDOW_MS = 600;
// A draw that cannot find a reachable shot for this long gives up rather than hold the bow forever.
const MAX_HOLD_TICKS = 100;
const PLAYER_EYE = 1.62;
const ARROW_NAMES = new Set(['arrow', 'spectral_arrow', 'tipped_arrow']);

function findBow(bot) {
  return bot.inventory.items().find((it) => it.name === 'bow') || null;
}

function hasArrows(bot) {
  if (bot.game && bot.game.gameMode === 'creative') return true;
  return bot.inventory.items().some((it) => ARROW_NAMES.has(it.name));
}

function eyeOf(bot) {
  const p = bot.entity.position;
  const h = typeof bot.entity.eyeHeight === 'number' ? bot.entity.eyeHeight : PLAYER_EYE;
  return { x: p.x, y: p.y + h, z: p.z };
}

// centreOf(entity) → the middle of its hitbox, the point the arrow is aimed through.
//
// A rider's own position is never updated by mineflayer: the server sends the vehicle's moves and the
// client is left to carry the passenger, so a jockey or a mob in a minecart reads frozen where it
// mounted. A rider is aimed off its vehicle instead, at the part of it showing above the mount. The
// arrow tests every hitbox grown by ARROW_HIT_GROW and takes the first it meets, so a shot at the
// rider's middle strikes the mount: a husk in a minecart sits with its feet half a block below the
// cart's (read off the server: cart y 200.0625, husk y 199.55), its middle inside the cart's grown box.
// The aim is the middle of the band between the mount's grown top and the rider's top, the rider taken
// to sink half its height into the seat (husk in a minecart, skeleton on a spider).
const ARROW_HIT_GROW = 0.3;
function centreOf(entity) {
  const h = typeof entity.height === 'number' ? entity.height : 0;
  const mount = entity.vehicle && entity.vehicle.position ? entity.vehicle : null;
  if (!mount) return { x: entity.position.x, y: entity.position.y + h / 2, z: entity.position.z };
  let base = mount;
  for (let i = 0; i < 4 && base.vehicle && base.vehicle.position; i++) base = base.vehicle;
  const mountTop = mount.position.y + (typeof mount.height === 'number' ? mount.height : 0);
  const band = Math.max(0, h / 2 - ARROW_HIT_GROW);
  return { x: base.position.x, y: mountTop + ARROW_HIT_GROW + band / 2, z: base.position.z };
}

// targetTrack(entity) → a tracker fed once per physics tick. Samples are kept only when the position
// changed, so the fit sees each server update once at its arrival time.
function targetTrack(entity) {
  const samples = [];
  return {
    sample(now) {
      const c = centreOf(entity);
      const last = samples[samples.length - 1];
      if (!last || last.x !== c.x || last.y !== c.y || last.z !== c.z) samples.push({ t: now, ...c });
      while (samples.length > 2 && now - samples[0].t > TRACK_WINDOW_MS) samples.shift();
      // A target that has not moved for the whole window keeps one sample: a still target.
      if (samples.length === 1 || now - samples[samples.length - 1].t > TRACK_WINDOW_MS) {
        samples.splice(0, samples.length - 1);
      }
    },
    motion(now) {
      return ballistics.fitMotion(samples, now);
    },
  };
}

// aimAt(bot, motion, leadTicks?, step?) → the solveShot answer for the bot's eye and the target's fitted
// motion, carrying the motion it was solved for.
//
// `step` is the body's own move over its last tick. The server gives the arrow the shooter's last known
// movement: ServerPlayer.getKnownMovement returns lastKnownClientMovement, the change of position in
// the last movement packet (zero when a tick sends none). mineflayer's entity.velocity is read after
// ground friction and holds about half of that move, so a strafing archer read it and loosed an arrow a
// block wide at 30 blocks (Worklog 821). With no step given, the body is taken as standing.
function aimAt(bot, motion, leadTicks = LEAD_TICKS, step = null) {
  const v = step || { x: 0, y: 0, z: 0 };
  const answer = ballistics.solveShot({
    eye: eyeOf(bot),
    target: motion.position,
    targetVel: motion.velocity,
    leadTicks,
    shooterVel: { x: v.x, y: v.y, z: v.z },
    shooterOnGround: bot.entity.onGround !== false,
  });
  answer.motion = motion;
  return answer;
}

// equipBow(bot) → { ok, reason? }.
async function equipBow(bot) {
  const bow = findBow(bot);
  if (!bow) return { ok: false, reason: 'no_bow' };
  if (!hasArrows(bot)) return { ok: false, reason: 'no_arrows' };
  if (bot.heldItem && bot.heldItem.name === 'bow') return { ok: true };
  const r = await guardExternal(TAG, 'equip bow to hand', () => bot.equip(bow, 'hand'));
  return r.ok ? { ok: true } : { ok: false, reason: 'equip_failed' };
}

// shootAt(bot, entity, opts?) → { fired, reason?, aim?, drawTicks? }.
//   opts.drawTicks  ticks to draw before loosing (default a full charge)
//   opts.leadTicks  ticks from the release decision to the arrow's first move (default LEAD_TICKS)
//   opts.onTick     called each draw tick with the current answer (for a probe or a camera)
// Resolves when the arrow is loosed or the draw is abandoned. Abandoning stops the draw by changing the
// hotbar slot, which drops the use without firing.
async function shootAt(bot, entity, opts = {}) {
  const ready = await equipBow(bot);
  if (!ready.ok) return { fired: false, reason: ready.reason };
  const drawTicks = opts.drawTicks || DRAW_TICKS;
  const track = targetTrack(entity);
  track.sample(Date.now());
  if (!guardExternalSync(TAG, 'activateItem to draw the bow', () => bot.activateItem()).ok) {
    return { fired: false, reason: 'draw_failed' };
  }
  return new Promise((resolve) => {
    let ticks = 0;
    let lastPos = bot.entity.position.clone();
    const finish = (result) => {
      bot.removeListener('physicsTick', onTick);
      resolve(result);
    };
    const abandon = (reason) => {
      const other = (bot.quickBarSlot + 1) % 9;
      guardExternalSync(TAG, 'setQuickBarSlot to drop the draw', () => bot.setQuickBarSlot(other));
      finish({ fired: false, reason, drawTicks: ticks });
    };
    const onTick = () => {
      ticks++;
      if (!bot.entities[entity.id] || !entity.isValid) { abandon('target_gone'); return; }
      if (!bot.heldItem || bot.heldItem.name !== 'bow') { abandon('bow_lost'); return; }
      const now = Date.now();
      track.sample(now);
      const pos = bot.entity.position;
      const step = { x: pos.x - lastPos.x, y: pos.y - lastPos.y, z: pos.z - lastPos.z };
      lastPos = pos.clone();
      const aim = aimAt(bot, track.motion(now), opts.leadTicks != null ? opts.leadTicks : LEAD_TICKS, step);
      if (opts.onTick) opts.onTick(aim, ticks);
      if (!guardExternalSync(TAG, 'look along the shot', () => bot.look(aim.yaw, aim.pitch, true)).ok) {
        abandon('look_failed');
        return;
      }
      if (ticks < drawTicks) return;
      if (!aim.reachable) {
        if (ticks >= MAX_HOLD_TICKS) abandon('out_of_range');
        return;
      }
      bot.removeListener('physicsTick', onTick);
      process.nextTick(() => {
        const r = guardExternalSync(TAG, 'deactivateItem to loose the arrow', () => bot.deactivateItem());
        resolve(r.ok ? { fired: true, aim, drawTicks: ticks } : { fired: false, reason: 'release_failed', aim, drawTicks: ticks });
      });
    };
    bot.on('physicsTick', onTick);
  });
}

module.exports = { DRAW_TICKS, LEAD_TICKS, findBow, hasArrows, eyeOf, centreOf, targetTrack, aimAt, equipBow, shootAt };
