'use strict';
// calculator: fireball_calculator — where a ghast's fireball is, and where to look so a punch sends it
// back into the ghast.
//
// Read from the 26.1 server's own classes (Worklog 825):
// - AbstractHurtingProjectile.tick: applyInertia first, v = (v + unit(v) x accelerationPower) x 0.95
//   (0.8 in water), then the fireball moves by v. No gravity: it flies straight, only its speed changes.
// - A ghast's fireball leaves at unit(direction) x 0.1 with accelerationPower 0.1, so it starts slow and
//   tends to 1.9 blocks per tick.
// - Player.attack on a redirectable projectile calls deflect(AIM_DEFLECT): the fireball's velocity
//   becomes the striker's look vector (1 block per tick) and, struck by a player, its accelerationPower
//   is 0.1. Ghast.hurtServer takes 1000 from a LargeFireball whose owner is a player: a returned
//   fireball kills the ghast.
// - The server accepts the strike while the fireball's box is within 3.0 + 3.0 blocks of the eye
//   (ServerGamePacketListenerImpl.handleInteract, isWithinEntityInteractionRange(box, 3.0)).
//
// Coordinates are world blocks, velocities blocks per tick, yaw and pitch mineflayer's.

const FIREBALL_ACCEL = 0.1;
const FIREBALL_INERTIA = 0.95;
const RETURN_SPEED = 1.0;
const FIREBALL_HALF = 0.5;              // a ghast's fireball is a 1 x 1 x 1 box
const SERVER_STRIKE_RANGE = 6.0;
const MAX_TICKS = 200;

function norm(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

// stepFireball(p, v, accel?) → { p, v } one tick on: inertia, then the move.
function stepFireball(p, v, accel = FIREBALL_ACCEL) {
  const n = norm(v);
  const u = n > 0 ? { x: v.x / n, y: v.y / n, z: v.z / n } : { x: 0, y: 0, z: 0 };
  const nv = {
    x: (v.x + u.x * accel) * FIREBALL_INERTIA,
    y: (v.y + u.y * accel) * FIREBALL_INERTIA,
    z: (v.z + u.z * accel) * FIREBALL_INERTIA,
  };
  return { p: { x: p.x + nv.x, y: p.y + nv.y, z: p.z + nv.z }, v: nv };
}

// fireballAt(p, v, ticks) → { p, v } after a whole or fractional number of ticks (the last part
// linear inside its tick).
function fireballAt(p, v, ticks) {
  let s = { p, v };
  const whole = Math.max(0, Math.floor(ticks));
  for (let i = 0; i < whole && i < MAX_TICKS; i++) s = stepFireball(s.p, s.v);
  const frac = ticks - whole;
  if (frac > 0) {
    const n = stepFireball(s.p, s.v);
    s = { p: { x: s.p.x + (n.p.x - s.p.x) * frac, y: s.p.y + (n.p.y - s.p.y) * frac, z: s.p.z + (n.p.z - s.p.z) * frac }, v: s.v };
  }
  return s;
}

// boxDistance(eye, centre, half) → distance from the eye to the nearest point of a cube.
function boxDistance(eye, centre, half = FIREBALL_HALF) {
  const d = (a, c) => Math.max(0, Math.abs(a - c) - half);
  return Math.hypot(d(eye.x, centre.x), d(eye.y, centre.y), d(eye.z, centre.z));
}

// returnDistance(ticks) → how far a punched fireball has flown after `ticks`: it leaves at the look
// vector's unit speed and gathers speed by the same inertia step.
function returnDistance(ticks) {
  let v = RETURN_SPEED, d = 0;
  for (let t = 1; t <= ticks; t++) { v = (v + FIREBALL_ACCEL) * FIREBALL_INERTIA; d += v; }
  return d;
}

// returnTicksTo(dist) → ticks for a punched fireball to cover `dist` (fractional).
function returnTicksTo(dist) {
  let v = RETURN_SPEED, d = 0;
  for (let t = 1; t <= MAX_TICKS; t++) {
    v = (v + FIREBALL_ACCEL) * FIREBALL_INERTIA;
    if (d + v >= dist) return t - 1 + (dist - d) / v;
    d += v;
  }
  return MAX_TICKS;
}

// aimReturn(from, target, targetVel?) → { yaw, pitch, ticks, meet }: the look that sends a fireball
// struck at `from` into a target at `target` moving at `targetVel`. The direction is taken from the
// fireball, not from the eye: the punched fireball leaves from where it was struck.
function aimReturn(from, target, targetVel = { x: 0, y: 0, z: 0 }) {
  let meet = target, ticks = 0;
  for (let i = 0; i < 8; i++) {
    ticks = returnTicksTo(Math.hypot(meet.x - from.x, meet.y - from.y, meet.z - from.z));
    meet = { x: target.x + targetVel.x * ticks, y: target.y + targetVel.y * ticks, z: target.z + targetVel.z * ticks };
  }
  const dx = meet.x - from.x, dy = meet.y - from.y, dz = meet.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), ticks, meet };
}

module.exports = {
  FIREBALL_ACCEL, FIREBALL_INERTIA, RETURN_SPEED, FIREBALL_HALF, SERVER_STRIKE_RANGE,
  stepFireball, fireballAt, boxDistance, returnDistance, returnTicksTo, aimReturn,
};
