'use strict';
// calculator: bow_ballistics — where to point a bow so the arrow meets a target, moving or still.
//
// mineflayer can draw a bow (activateItem) and loose it (deactivateItem) and nothing more: no flight
// model, no aim, no lead. This file is the flight model and the aim. It reads no world and drives no
// body; `bow_shot.js` feeds it the shooter's eye, the target's tracked motion, and turns its answer into a
// look and a release.
//
// The arrow, per server tick (vanilla AbstractArrow): it moves by its velocity, then the velocity is
// multiplied by the drag (0.99 in air) and the gravity (0.05) is taken off its y. A bow at full draw
// (20 ticks) launches it at 3 blocks per tick from 0.1 below the shooter's eye, plus the shooter's own
// motion (its y only when airborne). Read from the 26.1 server's own classes: AbstractArrow.tick moves
// (stepMoveAndHit, setPos), then applyInertia(0.99), then applyGravity (0.05); BowItem shoots at power x
// 3.0 with inaccuracy 1.0; Projectile.getMovementToShoot adds triangle(0, 0.0172275 x inaccuracy) to each
// axis of the unit direction, the spread no aim can remove; shootFromRotation adds the shooter's known
// movement. A live probe hit still targets out to 70 blocks (Worklogs 820, 821).
//
// A skeleton aims by a cruder rule (AbstractSkeleton.performRangedAttack): straight at where the target
// is now, at a third of its height, raised by 0.2 x the horizontal distance to cover the drop, at 1.6
// blocks per tick with inaccuracy 14 - 4 x difficulty (6 on normal, six times a player's spread). It
// does not lead. It reads as accurate because it shoots only inside 15 blocks, where the spread is small
// and a walking target moves under a block during the flight. This file solves the drop exactly and
// leads, so the skeleton's rule has nothing to add.
//
// Coordinates are world blocks; velocities are blocks per tick; yaw and pitch are mineflayer's (yaw 0
// faces -Z, pitch positive is up), so the answer goes straight into bot.look.

const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;
const BOW_FULL_SPEED = 3.0;
const BOW_FULL_DRAW_TICKS = 20;
const ARROW_DROP_FROM_EYE = 0.1;
// An arrow still flying after this many ticks has fallen out of any fight a bow belongs in.
const MAX_FLIGHT_TICKS = 200;
// The solver stops correcting once the simulated arrow passes the target's centre this close.
const SOLVED_MISS = 0.02;
const SOLVER_ROUNDS = 16;

// bowPower(drawTicks) → 0..1, the vanilla bow's charge curve; below 0.1 the bow does not fire.
function bowPower(drawTicks) {
  const f = Math.max(0, drawTicks) / BOW_FULL_DRAW_TICKS;
  return Math.min(1, (f * f + f * 2) / 3);
}

// arrowSpeed(drawTicks) → launch speed in blocks per tick.
function arrowSpeed(drawTicks) {
  return bowPower(drawTicks) * BOW_FULL_SPEED;
}

// launchPoint(eye) → where the arrow appears, from the shooter's eye.
function launchPoint(eye) {
  return { x: eye.x, y: eye.y - ARROW_DROP_FROM_EYE, z: eye.z };
}

// directionOf(yaw, pitch) → unit vector, mineflayer convention.
function directionOf(yaw, pitch) {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

// yawPitchOf(dir) → { yaw, pitch } that bot.look takes to face dir.
function yawPitchOf(dir) {
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) };
}

// flightPath(start, velocity, ticks) → positions[0..ticks]; positions[t] is where the arrow is after t
// ticks of flight, positions[0] the launch point.
function flightPath(start, velocity, ticks) {
  const out = [{ x: start.x, y: start.y, z: start.z }];
  let px = start.x, py = start.y, pz = start.z;
  let vx = velocity.x, vy = velocity.y, vz = velocity.z;
  for (let t = 1; t <= ticks; t++) {
    px += vx; py += vy; pz += vz;
    vx *= ARROW_DRAG; vy *= ARROW_DRAG; vz *= ARROW_DRAG;
    vy -= ARROW_GRAVITY;
    out.push({ x: px, y: py, z: pz });
  }
  return out;
}

// heightAtRange(pitch, range, speed) → the arrow's height above launch when it has travelled `range`
// horizontally, or -Infinity when it never gets that far. The 2-D cut of flightPath the pitch solve
// searches over.
function heightAtRange(pitch, range, speed) {
  let x = 0, y = 0;
  let vx = Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed;
  for (let t = 1; t <= MAX_FLIGHT_TICKS; t++) {
    const nx = x + vx, ny = y + vy;
    if (nx >= range) {
      const s = vx > 0 ? (range - x) / vx : 0;
      return y + vy * s;
    }
    x = nx; y = ny;
    vx *= ARROW_DRAG; vy *= ARROW_DRAG; vy -= ARROW_GRAVITY;
    if (vx < 1e-6) return -Infinity;
  }
  return -Infinity;
}

// pitchFor(range, rise, speed) → { pitch, reachable }: the low (flat, fast) arc through a point `range`
// out and `rise` up. Height at a fixed range climbs with pitch to a peak and falls after it; the peak is
// found first, then the climb is bisected. Unreachable returns the peak pitch, the arc that comes
// closest.
function pitchFor(range, rise, speed) {
  if (range < 1e-6) return { pitch: rise >= 0 ? Math.PI / 2 - 1e-3 : -Math.PI / 2 + 1e-3, reachable: true };
  let lo = -Math.PI / 2 + 1e-3, hi = Math.PI / 2 - 1e-3;
  for (let i = 0; i < 60; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (heightAtRange(a, range, speed) < heightAtRange(b, range, speed)) lo = a; else hi = b;
  }
  const peak = (lo + hi) / 2;
  if (heightAtRange(peak, range, speed) < rise) return { pitch: peak, reachable: false };
  lo = -Math.PI / 2 + 1e-3; hi = peak;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (heightAtRange(mid, range, speed) < rise) lo = mid; else hi = mid;
  }
  return { pitch: (lo + hi) / 2, reachable: true };
}

// closestPass(path, targetAt) → { tick, distance, arrow, target }: where the arrow passes nearest the
// target, both moving straight between ticks, so a 3-block-per-tick arrow is not judged only at the
// points it happens to sit on.
function closestPass(path, targetAt) {
  let best = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const a0 = path[i], a1 = path[i + 1];
    const b0 = targetAt(i), b1 = targetAt(i + 1);
    const r0 = { x: a0.x - b0.x, y: a0.y - b0.y, z: a0.z - b0.z };
    const dr = { x: (a1.x - b1.x) - r0.x, y: (a1.y - b1.y) - r0.y, z: (a1.z - b1.z) - r0.z };
    const dd = dr.x * dr.x + dr.y * dr.y + dr.z * dr.z;
    let s = dd > 0 ? -(r0.x * dr.x + r0.y * dr.y + r0.z * dr.z) / dd : 0;
    s = Math.max(0, Math.min(1, s));
    const dx = r0.x + dr.x * s, dy = r0.y + dr.y * s, dz = r0.z + dr.z * s;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!best || distance < best.distance) {
      best = {
        tick: i + s, distance,
        arrow: { x: a0.x + (a1.x - a0.x) * s, y: a0.y + (a1.y - a0.y) * s, z: a0.z + (a1.z - a0.z) * s },
        target: { x: b0.x + (b1.x - b0.x) * s, y: b0.y + (b1.y - b0.y) * s, z: b0.z + (b1.z - b0.z) * s },
      };
    }
  }
  return best;
}

// solveShot(shot) → the aim for one arrow.
//   shot.eye           shooter's eye position
//   shot.target        target's aim point now (a hitbox centre)
//   shot.targetVel     target's velocity, blocks per tick (default still)
//   shot.leadTicks     ticks between this answer and the arrow's first tick in the world (default 0)
//   shot.shooterVel    shooter's velocity, blocks per tick (default still)
//   shot.shooterOnGround  the shooter's vertical motion is not given to the arrow when true (default true)
//   shot.speed         launch speed (default full draw)
// → { yaw, pitch, reachable, flightTicks, miss, aimPoint, meet }
//
// The target is taken to keep its velocity. Each round aims a still-air pitch at an aim point, flies the
// arrow with the shooter's motion added, finds where it passes the moving target nearest, and moves the
// aim point by the miss. The same flight model judges every round, so the answer converges on the
// model's own hit, lead and shooter drift included.
function solveShot(shot) {
  const speed = shot.speed != null ? shot.speed : BOW_FULL_SPEED;
  const v = shot.targetVel || { x: 0, y: 0, z: 0 };
  const lead = shot.leadTicks || 0;
  const sv = shot.shooterVel || { x: 0, y: 0, z: 0 };
  const onGround = shot.shooterOnGround !== false;
  const carry = { x: sv.x, y: onGround ? 0 : sv.y, z: sv.z };
  const start = launchPoint(shot.eye);
  const targetAt = (t) => ({
    x: shot.target.x + v.x * (t + lead),
    y: shot.target.y + v.y * (t + lead),
    z: shot.target.z + v.z * (t + lead),
  });

  let aim = targetAt(0);
  let answer = null;
  for (let round = 0; round < SOLVER_ROUNDS; round++) {
    const dx = aim.x - start.x, dy = aim.y - start.y, dz = aim.z - start.z;
    const range = Math.hypot(dx, dz);
    const { pitch, reachable } = pitchFor(range, dy, speed);
    const yaw = range > 1e-6 ? Math.atan2(-dx, -dz) : 0;
    const dir = directionOf(yaw, pitch);
    const v0 = { x: dir.x * speed + carry.x, y: dir.y * speed + carry.y, z: dir.z * speed + carry.z };
    const pass = closestPass(flightPath(start, v0, MAX_FLIGHT_TICKS), targetAt);
    answer = {
      yaw, pitch, reachable, flightTicks: pass.tick, miss: pass.distance,
      aimPoint: aim, meet: pass.target,
    };
    if (!reachable || pass.distance < SOLVED_MISS) break;
    aim = {
      x: aim.x + (pass.target.x - pass.arrow.x),
      y: aim.y + (pass.target.y - pass.arrow.y),
      z: aim.z + (pass.target.z - pass.arrow.z),
    };
  }
  return answer;
}

// fitMotion(samples, now) → { position, velocity } | null.
//   samples: [{ t: ms, x, y, z }] in arrival order. Least-squares line per axis over the samples, read at
// `now`: the position is where the line says the target is at that moment, the velocity its slope in
// blocks per tick. The server sends a mob's position every few ticks, so the last sample is older than
// `now`; the line carries it forward. One sample gives a still target at that point.
function fitMotion(samples, now) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const last = samples[samples.length - 1];
  if (samples.length === 1) return { position: { x: last.x, y: last.y, z: last.z }, velocity: { x: 0, y: 0, z: 0 } };
  const n = samples.length;
  let mt = 0;
  for (const s of samples) mt += s.t;
  mt /= n;
  let stt = 0;
  for (const s of samples) stt += (s.t - mt) * (s.t - mt);
  const axis = (k) => {
    let m = 0;
    for (const s of samples) m += s[k];
    m /= n;
    let st = 0;
    for (const s of samples) st += (s.t - mt) * (s[k] - m);
    const slope = stt > 0 ? st / stt : 0;            // blocks per ms
    return { at: m + slope * (now - mt), perTick: slope * 50 };
  };
  const ax = axis('x'), az = axis('z');
  // Height that both rises and falls inside the window is a bounce (a jumping runner), not a climb: a line
  // through part of a hop extended over a 15-tick flight put the aim two blocks off. It is read as its
  // mean with no slope; a steady climb or fall (a ghast drifting, a mob dropping) keeps its line.
  const ay = bobs(samples) ? { at: samples.reduce((a, s) => a + s.y, 0) / n, perTick: 0 } : axis('y');
  return {
    position: { x: ax.at, y: ay.at, z: az.at },
    velocity: { x: ax.perTick, y: ay.perTick, z: az.perTick },
  };
}

// bobs(samples) → true when the height went up and came down (or down and up) by more than a small step.
const BOB_STEP = 0.1;
function bobs(samples) {
  let rose = false, fell = false;
  let lo = samples[0].y, hi = samples[0].y;
  for (const s of samples) {
    if (s.y - lo > BOB_STEP) rose = true;
    if (hi - s.y > BOB_STEP) fell = true;
    if (rose && fell) return true;
    lo = Math.min(lo, s.y); hi = Math.max(hi, s.y);
  }
  return false;
}

module.exports = {
  ARROW_GRAVITY, ARROW_DRAG, BOW_FULL_SPEED, BOW_FULL_DRAW_TICKS, ARROW_DROP_FROM_EYE, MAX_FLIGHT_TICKS,
  bowPower, arrowSpeed, launchPoint, directionOf, yawPitchOf,
  flightPath, heightAtRange, pitchFor, closestPass, solveShot, fitMotion,
};
