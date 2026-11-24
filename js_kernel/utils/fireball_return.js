'use strict';
// module: fireball_return — punch a ghast's fireball back into the ghast. The fleet's ghast defence.
//
// The flight, the strike rule and the return aim are `calculators/fireball_calculator` (read from the
// 26.1 server). This file is the body: every physics tick it carries each fireball forward from the
// last thing the server said about it, and when one heading for the body comes within reach it looks
// at the ghast it came from and strikes it. The strike needs no weapon: a fist returns a fireball.
//
// The gunner calls serve(bot) first in its tick, engaged or not: the gunner owns the body's facing and
// its swing (Invariant D), and a fireball in reach outranks every other swing for the one tick the
// strike takes. guard(bot) runs serve on its own physicsTick for a body without a gunner (a probe).
//
// The server sends a fireball's position only every ten ticks, and mineflayer does not move it between
// updates, so the body never reads a fireball's position directly: it holds an anchor (the last position
// and velocity the server sent, with the time) and flies the model forward from it.
//
// The look reaches the server before the strike: the look is set inside the physicsTick handler,
// mineflayer sends the rotation right after the handlers, and the attack is written on the next
// microtask. The server returns the fireball along the look it holds when the attack arrives.
//
// Reach against blast: the fireball bursts at power 1, and ServerExplosion.hurtEntities hurts and shoves
// only what stands within 2 x power = 2 blocks of the burst. The server takes a strike out to 6 blocks
// from the eye. Every fireball that could hurt the body passes through the strike reach first, but at
// up to 1.9 blocks per tick it may spend only one or two ticks there, so the strike reach sits near the
// server's edge and a strike that did not take is tried again the next tick but one.

const { guardExternalSync } = require('./external_library_guard');
const fireball = require('./calculators/fireball_calculator');
const { targetTrack, centreOf, eyeOf } = require('./bow_shot');
const entityVelocity = require('./movement/entity_velocity');

const TAG = 'fireball_return';
// Strike once the fireball's box is this close to the eye. The server allows 6; the half block of margin
// covers the model's error between position updates (strikes landed at 2.0-4.3 blocks, 20/21 taken,
// with a 4.5 reach, Worklog 825).
const STRIKE_REACH = 5.5;
// Ticks from this answer to the server reading the strike.
const LEAD_TICKS = 1;
// A fireball still coming this many ticks after a strike is struck again. A strike that takes is
// answered at once (the deflect sends the new velocity), so two ticks tells a refused strike from a late
// packet.
const RESTRIKE_TICKS = 2;

function vlen(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

// The ghast a fireball came from: the one nearest the line traced back from the fireball.
function sourceOf(bot, p, v) {
  const n = vlen(v);
  if (n === 0) return null;
  const back = { x: -v.x / n, y: -v.y / n, z: -v.z / n };
  let best = null, bestOff = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'ghast' || !e.isValid) continue;
    const c = centreOf(e);
    const r = { x: c.x - p.x, y: c.y - p.y, z: c.z - p.z };
    const along = r.x * back.x + r.y * back.y + r.z * back.z;
    if (along <= 0) continue;
    const off = vlen({ x: r.x - back.x * along, y: r.y - back.y * along, z: r.z - back.z * along });
    if (off < bestOff) { bestOff = off; best = e; }
  }
  return best;
}

// Per-body watch: fireball anchors, strikes, and a track on every ghast in view.
const _watch = new WeakMap();
function watchOf(bot) {
  let w = _watch.get(bot);
  if (!w) {
    entityVelocity.install(bot);
    w = { anchors: new Map(), struck: new Map(), ghastTracks: new Map(), tick: 0, strikes: 0 };
    _watch.set(bot, w);
  }
  return w;
}

const same = (u, w) => !!u && !!w && u.x === w.x && u.y === w.y && u.z === w.z;

// strikeOrder(bot, opts?) → { target, aim, ghast, distance } | null: this tick's fireball to strike back,
// with the look that sends it into its ghast. Advances the watch one tick; call it once per tick.
function strikeOrder(bot, opts = {}) {
  const w = watchOf(bot);
  const reach = opts.reach || STRIKE_REACH;
  w.tick++;
  const now = Date.now();
  let anyFireball = false;
  for (const e of Object.values(bot.entities)) {
    if (e.name === 'fireball') anyFireball = true;
    if (e.name !== 'ghast' || !e.isValid) continue;
    if (!w.ghastTracks.has(e.id)) w.ghastTracks.set(e.id, targetTrack(e));
    w.ghastTracks.get(e.id).sample(now);
  }
  for (const id of w.ghastTracks.keys()) if (!bot.entities[id]) w.ghastTracks.delete(id);
  for (const id of w.anchors.keys()) if (!bot.entities[id]) { w.anchors.delete(id); w.struck.delete(id); }
  if (!anyFireball) return null;

  const eye = eyeOf(bot);
  let pick = null;
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'fireball' || !e.isValid) continue;
    const pos = { x: e.position.x, y: e.position.y + fireball.FIREBALL_HALF, z: e.position.z };
    const vel = e.velocity && vlen(e.velocity) > 1e-4 ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null;
    // A new word from the server (a position, a velocity, or both) re-anchors the flight; whatever it
    // did not send is carried forward by the model from the last anchor.
    // A fireball's spawn carries no velocity, and the server does not always send one in flight: one came
    // 38 blocks to burst 0.9 blocks from the eye with its velocity read as zero the whole way, so it was
    // never "coming" and never struck. Until a velocity arrives, two of its positions give it: the flight is
    // straight, so the line through them is its line, and the mean speed between them its speed.
    const a = w.anchors.get(e.id);
    if (!a) {
      w.anchors.set(e.id, { p: pos, v: vel || { x: 0, y: 0, z: 0 }, t: now, seen: pos, seenAt: now, raw: vel, velKnown: !!vel });
    } else {
      const freshPos = !same(pos, a.seen);
      const freshVel = !!vel && !same(vel, a.raw);
      if (freshPos || freshVel) {
        const carried = fireball.fireballAt(a.p, a.v, (now - a.t) / 50);
        let v = freshVel ? vel : carried.v;
        const velKnown = a.velKnown || freshVel;
        if (!velKnown && freshPos) {
          const ticks = (now - a.seenAt) / 50;
          if (ticks > 0) v = { x: (pos.x - a.seen.x) / ticks, y: (pos.y - a.seen.y) / ticks, z: (pos.z - a.seen.z) / ticks };
        }
        w.anchors.set(e.id, { p: freshPos ? pos : carried.p, v, t: now, seen: pos, seenAt: freshPos ? now : a.seenAt, raw: vel, velKnown });
      }
    }
    const an = w.anchors.get(e.id);
    const s = fireball.fireballAt(an.p, an.v, (now - an.t) / 50 + LEAD_TICKS);
    const toEye = { x: eye.x - s.p.x, y: eye.y - s.p.y, z: eye.z - s.p.z };
    if (s.v.x * toEye.x + s.v.y * toEye.y + s.v.z * toEye.z <= 0) continue;     // not coming
    const last = w.struck.get(e.id);
    if (last != null && w.tick - last < RESTRIKE_TICKS) continue;
    const distance = fireball.boxDistance(eye, s.p);
    if (distance > reach) continue;
    if (!pick || distance < pick.distance) pick = { e, s, distance };
  }
  if (!pick) return null;

  const ghast = sourceOf(bot, pick.s.p, pick.s.v);
  let aim;
  if (ghast) {
    const m = w.ghastTracks.get(ghast.id).motion(now);
    aim = fireball.aimReturn(pick.s.p, m.position, m.velocity);
  } else {
    const back = { x: -pick.s.v.x, y: -pick.s.v.y, z: -pick.s.v.z };
    aim = { yaw: Math.atan2(-back.x, -back.z), pitch: Math.atan2(back.y, Math.hypot(back.x, back.z)) };
  }
  return { target: pick.e, aim, ghast, distance: pick.distance };
}

// serve(bot, opts?) → the strike made this tick ({ fireballId, ghastId, distance, aim }) or null.
// Call from inside a physicsTick handler: the look goes out with this tick's rotation, the attack after.
function serve(bot, opts = {}) {
  const order = strikeOrder(bot, opts);
  if (!order) return null;
  if (!guardExternalSync(TAG, 'look along the return', () => bot.look(order.aim.yaw, order.aim.pitch, true)).ok) return null;
  const w = watchOf(bot);
  w.struck.set(order.target.id, w.tick);
  w.strikes++;
  const target = order.target;
  const info = { fireballId: target.id, ghastId: order.ghast ? order.ghast.id : null, distance: order.distance, aim: order.aim };
  process.nextTick(() => {
    if (!guardExternalSync(TAG, 'attack the fireball', () => bot.attack(target)).ok) return;
    if (opts.onStrike) opts.onStrike(info);
  });
  return info;
}

// guard(bot, opts?) → stop(): serve on the body's own physicsTick, for a body with no gunner.
//   opts.onStrike(info)  called after each strike
//   opts.reach           strike distance, eye to the fireball's box (default STRIKE_REACH)
function guard(bot, opts = {}) {
  const onTick = () => { serve(bot, opts); };
  bot.on('physicsTick', onTick);
  return () => bot.removeListener('physicsTick', onTick);
}

module.exports = { STRIKE_REACH, LEAD_TICKS, RESTRIKE_TICKS, sourceOf, strikeOrder, serve, guard };
