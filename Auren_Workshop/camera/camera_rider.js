// camera_rider — a bot camera that travels WITH its bot. One headless mineflayer spectator per bot moves
// ITSELF along the bot's own track, a distance behind it, as high above that track as it can still see the
// bot from, and points its head along the route the bot posts ahead of itself. The Prism camera client
// /spectate's it.
//
// ── WHY IT IS SMOOTH ────────────────────────────────────────────────────────────────────────────────
// A client in-betweens every entity it watches (position and rotation) at its own frame rate, but never
// itself. So the camera window is never moved; the rider is, and the window watching it renders every one
// of the rider's 20 position updates a second as continuous motion. A rider moves the way a player walking
// does — its own position packets — never by a console teleport, except to be put back when it is far
// from its spot (the rig does that; `far()` asks for it).
//
// ── HOW IT FOLLOWS ──────────────────────────────────────────────────────────────────────────────────
// The bot's track is kept as distance travelled (`s`, blocks along it). The rider holds its own place `s`
// and its own speed `v` on that track. It never copies the bot's moment-to-moment speed: it wants the
// bot's average speed over `speedWindowSec`, plus a correction for how far it is from `followBlocks`
// behind, and its speed eases toward that with a time constant and an acceleration ceiling. A bot that
// lurches, pauses at a corner or arrives jitter-late in the packets moves the target; the rider's speed
// changes only gradually, so a rider a little fast slows down over seconds and lets the bot pull away.
// The point on the track is averaged over ± `cornerBlocks`, so corners are arcs.
//
// ── HOW HIGH ────────────────────────────────────────────────────────────────────────────────────────
// The ground height under the rider is the lowest the bot's feet stood within a block and a half of the
// rider's place, so the bot's jumps never lift the lens. Above it the rider rides as high as `highRise`;
// every `boomCheckMs` it tries heights top down and keeps the highest whose cell is open and whose line to
// the bot's chest is clear (./sightline, the same test the scout and the gimbal use). It drops quickly
// toward a lower height and climbs back slowly, so a canopy brings the lens down under it, and open sky
// lifts it gently. `lowRise` is ground the bot has just walked through.
//
// ── WHERE IT LOOKS ──────────────────────────────────────────────────────────────────────────────────
// At a point `lookAheadBlocks` along the route the bot last posted (navigator's `[ROUTE] ahead cells=…`),
// measured from the cell of that route the bot is nearest to now. A bot off its posted route (a fight, a
// swim, a walk the navigator did not plan) is steered by its own motion instead; a bot standing still
// holds the last look. The look point drifts toward its target with a time constant, and the head's turn
// rate is capped, so a re-posted or changed route is a pan, never a cut.
//
// ── HOW NEAR ────────────────────────────────────────────────────────────────────────────────────────
// The gap above is measured ALONG the track, which says nothing about how near the lens stands: a bot that
// turns back over its own track (a fight's strafe and knockback, a detour round a trunk) walks into a lens
// still "four blocks behind". So the lens also keeps a distance from the bot itself, never nearer than
// `standoffBlocks` across the ground. A bot that crowds the lens, or is in a fight (`engagedFor`), makes it
// HOLD OFF for `leashHoldSec`: it leaves the track and stays where it is, between `standoffBlocks` and
// `leashMaxBlocks` from the bot, backing straight away when the bot comes at it and following when the bot
// pulls away; when no height at that bearing sees the bot it swings round the bot to one that does. While it
// holds off it looks at the bot, not ahead along the route. The hand-over either way is eased
// (`leashBlendSec`); the floor itself is not, so a lunge moves the lens back at the bot's own speed.
//
// ── LOST SIGHT ──────────────────────────────────────────────────────────────────────────────────────
// A moving bot carries the lens out of a canopy by itself. A bot standing or fighting in place
// (`seekStillBlocks`) that the lens has not seen for `seekAfterMs` is looked for: the lens holds off and,
// every `seekSearchMs`, tries bearings outward from its own (both ways, round to the far side) at three
// distances and at heights from `seekHighRise` down to `seekLowRise`, and turns slowly (`seekDegPerSec`)
// to the first clear view. With none found it sweeps `seekSweepDeg` to each side and rises and falls
// (`seekBobSec`) until the bot's chest comes into view, and stays there until the bot moves on.
//
// ── THE CLOCK ───────────────────────────────────────────────────────────────────────────────────────
// The server takes the newest position it holds at each tick and passes it on every other tick. A client
// sending on its own 50 ms timer drifts in phase against those ticks: near the boundary one relayed step
// carries one of its moves and the next carries three, and the camera's client draws them as a short step
// then a long one — a pulse. So the rider writes its own position packet every STEP_MS, the spot computed
// for that moment, and mineflayer's own 50 ms movement packets are held back: whatever the server takes
// at a tick is at most one step old.
//
// It reads; it never acts in the world (Law 19). It decides nothing about cutting (the rig's).

'use strict';

const { isOpaque, walkLine } = require('./sightline');

const RAD = Math.PI / 180;
const EYE = 1.62;
const CHEST = 1.2;
const STEP_MS = 10;
const HISTORY_MS = 8000;
const GROUND_HALF = 1.5;
// mineflayer's own movement packets, held back so the rider's are the only ones the server reads.
const MOVE_PACKETS = new Set(['position', 'look', 'position_look', 'flying']);
// An unchanged spot is re-sent this often, as a vanilla client does, so the server never reads it as gone.
const IDLE_SEND_MS = 1000;
// A sample arriving after a longer silence than this means the bot was standing still: a copy of the
// last sample is put just before it, so the in-between does not stretch one step over the whole pause.
const GAP_MS = 150;
const shortestDeg = a => ((a + 180) % 360 + 360) % 360 - 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
const lerp = (a, b, f) => ({ t: a.t + (b.t - a.t) * f, s: a.s + (b.s - a.s) * f,
  x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });

// trackStep(a, b) → distance along the track between two feet samples. Height counts half, so a jump in
// place barely advances the track while a climb still does. PURE.
const trackStep = (a, b) => Math.hypot(b.x - a.x, b.z - a.z, (b.y - a.y) * 0.5);

// sampleAt(hist, t) → the track sample at time t, in-betweened. PURE.
function sampleAt(hist, t) {
  if (!hist.length) return null;
  if (t <= hist[0].t) return hist[0];
  const last = hist[hist.length - 1];
  if (t >= last.t) return last;
  for (let i = hist.length - 2; i >= 0; i--) {
    const a = hist[i], b = hist[i + 1];
    if (a.t <= t) return lerp(a, b, (t - a.t) / (b.t - a.t));
  }
  return hist[0];
}

// pointAtS(hist, s) → the track point at distance s along it, in-betweened. PURE.
function pointAtS(hist, s) {
  if (!hist.length) return null;
  if (s <= hist[0].s) return hist[0];
  const last = hist[hist.length - 1];
  if (s >= last.s) return last;
  let lo = 0, hi = hist.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (hist[mid].s <= s) lo = mid; else hi = mid; }
  const a = hist[lo], b = hist[hi];
  return b.s > a.s ? lerp(a, b, (s - a.s) / (b.s - a.s)) : b;
}

// smoothPoint(hist, s, half) → the track point at s averaged over ± half, weighted toward s. PURE.
function smoothPoint(hist, s, half) {
  const offs = [-1, -0.5, 0, 0.5, 1], w = [1, 2, 3, 2, 1];
  let x = 0, z = 0, n = 0;
  for (let i = 0; i < offs.length; i++) {
    const p = pointAtS(hist, s + offs[i] * half);
    x += p.x * w[i]; z += p.z * w[i]; n += w[i];
  }
  return { x: x / n, z: z / n };
}

// groundAt(hist, s) → the lowest the bot's feet stood within GROUND_HALF of s along the track. PURE.
function groundAt(hist, s) {
  let y = pointAtS(hist, s).y;
  for (const h of hist) if (Math.abs(h.s - s) <= GROUND_HALF && h.y < y) y = h.y;
  return y;
}

// advance({s,v}, {sBot, botSpeed, dt}, cfg) → {s, v}: one step of the rider along the track. PURE.
function advance(st, { sBot, botSpeed, dt }, cfg) {
  const want = Math.max(0, botSpeed + (sBot - cfg.followBlocks - st.s) / cfg.catchUpSec);
  const eased = st.v + (want - st.v) * ease(dt, cfg.speedEaseSec);
  let v = Math.max(0, st.v + clamp(eased - st.v, -cfg.maxAccel * dt, cfg.maxAccel * dt));
  let s = st.s + v * dt;
  const ceiling = sBot - cfg.minGapBlocks;
  if (s > ceiling) { s = Math.max(st.s, ceiling); v = Math.min(v, botSpeed); }
  return { s, v };
}

// holdOff(lens, bot, minR, maxR, away) → {x,z}: the lens moved along the line from the bot only as far as it
// must to stand between minR and maxR of it across the ground. A lens on the bot's own column goes `away`
// (a unit {x,z}). PURE.
function holdOff(lens, bot, minR, maxR, away) {
  const dx = lens.x - bot.x, dz = lens.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return { x: bot.x + away.x * minR, z: bot.z + away.z * minR };
  const r = clamp(d, minR, maxR);
  return { x: bot.x + dx / d * r, z: bot.z + dz / d * r };
}

// routePoint(cells, at, ahead, offRoute, rise) → {x,y,z} point `rise` above the route, `ahead` blocks
// along `cells` (feet cells) from the one nearest `at`, or null when `at` is further than `offRoute` from
// every cell or stands on the last one. PURE.
function routePoint(cells, at, ahead, offRoute, rise = EYE) {
  if (!cells || !cells.length || !at) return null;
  const c = cells.map(k => ({ x: k.x + 0.5, y: k.y, z: k.z + 0.5 }));
  let best = 0, bestD = Infinity;
  for (let i = 0; i < c.length; i++) {
    const d = Math.hypot(c[i].x - at.x, c[i].y - at.y, c[i].z - at.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (bestD > offRoute || best === c.length - 1) return null;
  let from = { x: at.x, y: at.y, z: at.z }, left = ahead;
  for (let i = best + 1; i < c.length; i++) {
    const seg = Math.hypot(c[i].x - from.x, c[i].y - from.y, c[i].z - from.z);
    if (seg >= left) {
      const f = left / seg;
      return { x: from.x + (c[i].x - from.x) * f, y: from.y + (c[i].y - from.y) * f + rise, z: from.z + (c[i].z - from.z) * f };
    }
    left -= seg;
    from = c[i];
  }
  return { x: from.x, y: from.y + rise, z: from.z };
}

// parseCells('x,y,z/x,y,z/…') → [{x,y,z}]. The navigator's `ahead cells=` value.
function parseCells(text) {
  return String(text || '').split('/').map(s => s.split(',').map(Number))
    .filter(a => a.length === 3 && a.every(Number.isFinite)).map(([x, y, z]) => ({ x, y, z }));
}

// createRiders({ bots, targets, host, port, version, cfg, log, routeFor, engagedFor, visualBlockers })
//   → { available, isReady, nameFor, targetOf, retarget, far, sees, distances, endAll }
// `bots` are rider KEYS: each rider joins as cfg.prefix + key and rides targets[key], or the bot of that name.
// A seat that changes bot (the rider cam) is a key that is not a bot's name, moved on with retarget(key, bot).
// routeFor(bot) → [{x,y,z}] the route that bot last posted, or null.
// engagedFor(bot) → whether that bot has a fight open; the rider holds off for the whole of one.
function createRiders({ bots, targets = {}, host, port, version, cfg, log, routeFor, engagedFor, visualBlockers }) {
  let mineflayer, Vec3 = null;
  try {
    require('../workshop_paths').bootstrapModules();
    mineflayer = require('mineflayer');
  } catch (e) {
    return { available: false, reason: e.message, isReady: () => false, nameFor: b => `${cfg.prefix}${b}`, targetOf: () => null, retarget: () => false, far: () => null, sees: () => false, distances: () => null, endAll: () => {} };
  }
  const engaged = typeof engagedFor === 'function' ? engagedFor : () => false;
  // vec3 addresses a cell for the height test only: without it the rider rides at lowRise.
  try { Vec3 = require('vec3'); } catch (e) { Vec3 = null; }
  const BLOCKERS = visualBlockers || null;

  const riders = new Map();

  const fresh = g => {
    g.hist = []; g.track = null; g.ground = null; g.boom = cfg.lowRise; g.boomWant = cfg.lowRise;
    g.onTrack = 0; g.onTrackWant = 0;
    g.look = null; g.yaw = null; g.pitch = null; g.lastBoomMs = 0;
    g.botE = null; g.spot = null; g.holdUntil = 0; g.blend = 0; g.swingTo = null; g.seek = null; g.blindSince = null; g.lastBlindCheck = 0;
  };
  // The distances the lens kept since the last read, for the rig's record: the nearest the lens stood to the
  // bot, the nearest the plain track spot would have stood (the rider before HOW NEAR), and time holding off.
  const freshStats = () => ({ n: 0, lensMin: Infinity, trackMin: Infinity, trackUnder: 0, lensUnder: 0, holdMs: 0, seeks: 0, found: 0, blindMs: 0, sinceMs: Date.now() });

  for (const botName of bots) {
    const g = {
      username: `${cfg.prefix}${botName}`, target: targets[botName] || botName,
      ready: false, ended: false, bot: null, timer: null, reconnect: null,
      hist: [],          // the bot's feet as this client received them: {t, s, x, y, z}
      track: null,       // the rider's own place and speed on the track: {s, v}
      ground: null,      // eased ground height under the rider
      boom: 0, boomWant: 0,   // eased and wanted height of the lens above the bot's eye level
      look: null,        // the eased look point
      yaw: null, pitch: null,   // degrees, mineflayer's convention (yaw = atan2(-dx,-dz), pitch + = up)
      lastT: 0, lastBoomMs: 0,
      wantFar: null,     // the spot to be put back at, while the rider is too far from it to fly there
      botE: null,        // the bot's feet, eased by botEaseSec: what the hold-off measures from
      spot: null,        // the lens's last place across the ground {x,z}
      holdUntil: 0, blend: 0,   // holding off until this time; eased 0 (track) → 1 (holding off)
      swingTo: null,     // bearing (radians, round the bot) the lens is swinging to for a clear view
      stats: freshStats(),
    };
    fresh(g);

    const connect = () => {
      if (g.ended) return;
      const bot = mineflayer.createBot({ host, port, username: g.username, version, auth: 'offline' });
      g.bot = bot;
      g.ready = false;
      bot.once('spawn', () => {
        // mineflayer simulates gravity for a spectator too; with physics off it still sends whatever
        // position and rotation this file writes (physics.js updatePosition is gated on its own flag).
        bot.physicsEnabled = false;
        // The rider is the only writer of its movement packets (THE CLOCK above). mineflayer's still go
        // until the rider has a spot of its own, so the server hears it from the moment it spawns.
        const write = bot._client.write.bind(bot._client);
        g.sendMove = pkt => write('position_look', pkt);
        bot._client.write = (name, params) => (MOVE_PACKETS.has(name) && g.sentAny ? undefined : write(name, params));
        g.sentAny = false; g.lastSent = null;
        g.ready = true;
        fresh(g); g.lastT = 0;
        if (log) log(`${g.username} online — riding ${g.target} ${cfg.followBlocks} blocks behind, up to ${cfg.highRise} above, looking ${cfg.lookAheadBlocks} blocks along its route.`);
        if (g.timer) clearInterval(g.timer);
        g.timer = setInterval(() => step(g), STEP_MS);
      });
      const down = () => {
        g.ready = false;
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
        if (!g.ended && !g.reconnect) g.reconnect = setTimeout(() => { g.reconnect = null; connect(); }, 5000);
      };
      bot.on('end', down);
      bot.on('error', () => {});   // 'end' always follows; this only stops an unhandled throw
      bot.on('kicked', () => {});
    };

    connect();
    riders.set(botName, g);
  }

  // boomHeight(g, at, raw, groundY, chest) → { rise, onTrack }: the highest rise from highRise down to lowRise
  // whose lens cell is open and whose line to the bot's chest is clear, at the rounded track point `at`. When
  // none is, the lens comes down to the bot's own eye height, inside the head cell the bot has just walked
  // through: at `at` when that cell is open, else on the bot's exact track (`raw`, onTrack), because rounding
  // a corner round a tree can put `at` in its trunk. With no readable world it rides at lowRise.
  function boomHeight(g, at, raw, groundY, chest) {
    if (!Vec3) return { rise: cfg.lowRise, onTrack: false };
    const { top, floor } = riseRange(g, at, chest, groundY, cfg.highRise, cfg.lowRise);
    for (let rise = top; rise >= floor - 1e-6; rise -= cfg.riseStep) {
      if (clearAt(g, at, groundY, rise, chest)) return { rise, onTrack: false };
    }
    const blockAt = (x, y, z) => g.bot.blockAt(new Vec3(x, y, z));
    return { rise: 0, onTrack: isOpaque(blockAt(at.x, groundY + EYE, at.z), BLOCKERS) };
  }

  // UNDER THE CANOPY: a chest line clear through a gap in the leaves still leaves a lens up in the canopy filming leaves,
  // and under trees the clear view is lower. riseRange(g, p, chest, groundY, high, low) → { top, floor }: the heights to
  // try, top down. With a leaf over the lens or over the bot within canopyLookAbove of the top, the top is capped
  // canopyMargin under the lowest such leaf, and the floor may drop to canopyLowRise.
  function riseRange(g, p, chest, groundY, high, low) {
    const eyeY = groundY + EYE;
    let lowest = Infinity;
    for (const c of [p, chest, { x: (p.x + chest.x) / 2, z: (p.z + chest.z) / 2 }]) {
      const x = Math.floor(c.x), z = Math.floor(c.z);
      for (let y = Math.floor(eyeY); y <= Math.floor(eyeY + high + cfg.canopyLookAbove); y++) {
        const b = g.bot.blockAt(new Vec3(x, y, z));
        if (b && /leaves$/.test(b.name)) { lowest = Math.min(lowest, y); break; }
      }
    }
    if (lowest === Infinity) return { top: high, floor: low };
    const cap = lowest - eyeY - cfg.canopyMargin;
    return { top: Math.max(Math.min(high, cap), cfg.canopyLowRise), floor: Math.min(low, cfg.canopyLowRise) };
  }

  // clearAt(g, p, groundY, rise, chest) → true when a lens at p, `rise` above the bot's eye level, stands in an open
  // cell and sees the bot's chest (./sightline).
  function clearAt(g, p, groundY, rise, chest) {
    const blockAt = (x, y, z) => g.bot.blockAt(new Vec3(x, y, z));
    const y = groundY + EYE + rise;
    if (isOpaque(blockAt(p.x, y, p.z), BLOCKERS) || isOpaque(blockAt(p.x, y + 0.4, p.z), BLOCKERS)) return false;
    const los = walkLine(blockAt, { x: p.x, y, z: p.z }, chest, BLOCKERS);
    return !!(los.known && los.clear);
  }

  // seekSpot(g, bot, spot, groundY, chest) → { a, r, rise } the nearest clear view round a still bot (LOST SIGHT), or
  // null: bearings outward from the lens's own, at each of three distances, heights from seekHighRise down to seekLowRise.
  function seekSpot(g, bot, spot, groundY, chest) {
    const cur = Math.atan2(spot.z - bot.z, spot.x - bot.x);
    const radii = [cfg.standoffBlocks + 0.3, (cfg.standoffBlocks + cfg.leashMaxBlocks) / 2, cfg.leashMaxBlocks];
    for (let deg = 0; deg <= 180; deg += cfg.seekBearingStepDeg) {
      for (const sign of deg === 0 || deg === 180 ? [1] : [1, -1]) {
        const a = cur + sign * deg * RAD;
        for (const r of radii) {
          const p = { x: bot.x + Math.cos(a) * r, z: bot.z + Math.sin(a) * r };
          const { top, floor } = riseRange(g, p, chest, groundY, cfg.seekHighRise, cfg.seekLowRise);
          for (let rise = top; rise >= floor - 1e-6; rise -= cfg.riseStep) {
            if (clearAt(g, p, groundY, rise, chest)) return { a, r, rise };
          }
        }
      }
    }
    return null;
  }

  function step(g) {
    if (!g.ready || !g.bot || !g.bot.entity || !g.bot.entity.position) return;
    try {
      const now = Date.now();
      const dt = g.lastT ? Math.min(0.1, (now - g.lastT) / 1000) : 0;
      g.lastT = now;

      // The bot, as this client hears it, kept as a track.
      const other = g.bot.players[g.target];
      const p = other && other.entity && other.entity.position;
      if (p) {
        const last = g.hist[g.hist.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) {
          // A jump no walk makes (a teleport, a respawn) starts the track over: the old one leads nowhere.
          if (last && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > cfg.regrabBlocks) fresh(g);
          const prev = g.hist[g.hist.length - 1];
          if (prev && now - prev.t > GAP_MS) g.hist.push({ ...prev, t: now - 100 });
          const tail = g.hist[g.hist.length - 1];
          const s = tail ? tail.s + trackStep(tail, p) : 0;
          g.hist.push({ t: now, s, x: p.x, y: p.y, z: p.z });
        }
        // Old track goes, but never the stretch the rider is still on.
        const keepFrom = g.track ? g.track.s - cfg.cornerBlocks - GROUND_HALF - 1 : -Infinity;
        while (g.hist.length > 2 && now - g.hist[1].t > HISTORY_MS && g.hist[1].s < keepFrom) g.hist.shift();
      }
      if (!g.hist.length) return;

      // ── where on the track ──
      const head = g.hist[g.hist.length - 1];
      const before = sampleAt(g.hist, now - cfg.speedWindowSec * 1000);
      const botSpeed = Math.max(0, (head.s - before.s) / cfg.speedWindowSec);
      if (!g.track) g.track = { s: Math.max(g.hist[0].s, head.s - cfg.followBlocks), v: botSpeed };
      if (g.track.s < g.hist[0].s) g.track.s = g.hist[0].s;
      g.track = advance(g.track, { sBot: head.s, botSpeed, dt }, cfg);

      const rounded = smoothPoint(g.hist, g.track.s, cfg.cornerBlocks);
      const raw = pointAtS(g.hist, g.track.s);
      // Onto the exact track quickly when the rounded point is inside a block, off it slowly once it is clear.
      g.onTrack += (g.onTrackWant - g.onTrack) * ease(dt, g.onTrackWant > g.onTrack ? cfg.boomDownSec : cfg.boomUpSec);
      const at = { x: rounded.x + (raw.x - rounded.x) * g.onTrack, z: rounded.z + (raw.z - rounded.z) * g.onTrack };

      // ── how near (HOW NEAR above) ──
      if (!g.botE) g.botE = { x: head.x, y: head.y, z: head.z };
      const kb = ease(dt, cfg.botEaseSec);
      g.botE.x += (head.x - g.botE.x) * kb; g.botE.y += (head.y - g.botE.y) * kb; g.botE.z += (head.z - g.botE.z) * kb;
      const bot = g.botE;
      const trackNear = Math.hypot(at.x - bot.x, at.z - bot.z);
      const fighting = !!engaged(g.target);
      if (fighting || trackNear < cfg.crowdBlocks || g.seek) g.holdUntil = now + cfg.leashHoldSec * 1000;
      const holding = now < g.holdUntil;
      g.blend += ((holding ? 1 : 0) - g.blend) * ease(dt, cfg.leashBlendSec);
      // Straight back from the bot along its own direction of travel, for a lens standing on the bot's column.
      const was1 = sampleAt(g.hist, now - 1000);
      const mv = Math.hypot(head.x - was1.x, head.z - was1.z);
      const away = mv > 0.3 ? { x: -(head.x - was1.x) / mv, z: -(head.z - was1.z) / mv } : { x: 0, z: 1 };
      const from = g.spot || at;
      let hold = holdOff(from, bot, cfg.standoffBlocks, cfg.leashMaxBlocks, away);
      // LOST SIGHT: the bot has moved, so the ordinary rider finds its view again by itself.
      const still = mv < cfg.seekStillBlocks;
      if (!still && g.seek) g.seek = null;
      if (holding && g.seek) {
        // Round the bot slowly: to the clear view the search found, or, with none found, a sweep to each side of where
        // the seek began. The distance eases to the found one.
        g.swingTo = null;
        const r0 = Math.hypot(hold.x - bot.x, hold.z - bot.z);
        const cur = Math.atan2(hold.z - bot.z, hold.x - bot.x);
        const cap = cfg.seekDegPerSec * RAD * dt;
        let nb;
        if (g.seek.to != null) {
          nb = cur + clamp(shortestDeg((g.seek.to - cur) / RAD) * RAD, -cap, cap);
        } else {
          const off = shortestDeg((cur - g.seek.center) / RAD);
          if (off > cfg.seekSweepDeg) g.seek.dir = -1; else if (off < -cfg.seekSweepDeg) g.seek.dir = 1;
          nb = cur + g.seek.dir * cap;
          // …and up and down with it, between seekLowRise and seekHighRise.
          g.seek.phase += dt * 2 * Math.PI / cfg.seekBobSec;
          g.boomWant = (cfg.seekHighRise + cfg.seekLowRise) / 2 + (cfg.seekHighRise - cfg.seekLowRise) / 2 * Math.sin(g.seek.phase);
        }
        const r = r0 + (g.seek.r - r0) * ease(dt, cfg.seekRadiusSec);
        hold = { x: bot.x + Math.cos(nb) * r, z: bot.z + Math.sin(nb) * r };
      }
      if (holding && g.swingTo != null) {
        // Round the bot toward the clear bearing the height test found, at the orbit's own rate.
        const r = Math.hypot(hold.x - bot.x, hold.z - bot.z);
        const cur = Math.atan2(hold.z - bot.z, hold.x - bot.x);
        const diff = shortestDeg((g.swingTo - cur) / RAD) * RAD;
        const cap = cfg.leashOrbitDegPerSec * RAD * dt;
        const nb = cur + clamp(diff, -cap, cap);
        if (Math.abs(diff) <= cap) g.swingTo = null;
        hold = { x: bot.x + Math.cos(nb) * r, z: bot.z + Math.sin(nb) * r };
      }
      if (!holding) g.swingTo = null;
      // The track spot handed over to the held spot, eased; then the floor, measured from the bot as last heard
      // (not the eased one), and never eased.
      const mixed = { x: at.x + (hold.x - at.x) * g.blend, z: at.z + (hold.z - at.z) * g.blend };
      const spot = holdOff(mixed, head, cfg.standoffBlocks, Infinity, away);

      const groundTrack = groundAt(g.hist, g.track.s);
      const groundY = groundTrack + (Math.min(groundTrack, bot.y) - groundTrack) * g.blend;
      if (g.ground == null) g.ground = groundY;
      g.ground += (groundY - g.ground) * ease(dt, cfg.groundEaseSec);

      // ── how high ── tried at the lens's own spot. Holding off with no clear height, it looks round the bot.
      if (now - g.lastBoomMs >= cfg.boomCheckMs) {
        g.lastBoomMs = now;
        const chest = { x: head.x, y: head.y + CHEST, z: head.z };
        let b = boomHeight(g, spot, raw, g.ground, chest);
        // A seek's own height (it may stand outside highRise..lowRise) is tried at the lens's spot first.
        const seekRise = g.seek && g.seek.rise != null ? g.seek.rise : g.seek && g.seek.to == null ? g.boom : null;
        if (b.rise === 0 && seekRise != null && Vec3 && clearAt(g, spot, g.ground, seekRise, chest)) b = { rise: seekRise, onTrack: false };
        const blind = !!Vec3 && b.rise === 0;
        if (!(g.seek && g.seek.to == null && blind)) g.boomWant = b.rise;   // a sweep's bob holds the height while blind
        g.onTrackWant = b.onTrack && g.blend < 0.5 ? 1 : 0;
        // ── LOST SIGHT ── a still bot the lens has not seen for seekAfterMs: search wider (seekSpot) every
        // seekSearchMs and go to what it finds; with nothing found, sweep (above). Seen again, the lens stays put.
        if (!blind) {
          g.blindSince = null;
          if (g.seek && g.seek.to == null) { g.seek.rise = b.rise; g.seek.to = Math.atan2(spot.z - bot.z, spot.x - bot.x); g.seek.r = Math.hypot(spot.x - bot.x, spot.z - bot.z); }
        } else if (g.blindSince == null) {
          g.blindSince = now;
        }
        if (blind && still && now - g.blindSince >= cfg.seekAfterMs && (!g.seek || now - g.seek.searchedAt >= cfg.seekSearchMs)) {
          if (!g.seek) {
            g.seek = { center: Math.atan2(spot.z - bot.z, spot.x - bot.x), dir: 1, phase: 0, r: Math.hypot(spot.x - bot.x, spot.z - bot.z), to: null, rise: null, searchedAt: 0 };
            g.stats.seeks++;
          }
          g.seek.searchedAt = now;
          const found = seekSpot(g, bot, spot, g.ground, chest);
          if (found) { g.seek.to = found.a; g.seek.r = found.r; g.seek.rise = found.rise; g.boomWant = found.rise; g.stats.found++; }
          else { g.seek.to = null; g.seek.rise = null; }
        }
        if (blind) g.stats.blindMs += now - (g.lastBlindCheck || now);
        g.lastBlindCheck = now;
        if (holding && b.rise === 0 && g.swingTo == null && !g.seek && Vec3) {
          const r = Math.hypot(spot.x - bot.x, spot.z - bot.z);
          const cur = Math.atan2(spot.z - bot.z, spot.x - bot.x);
          for (const deg of [30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
            const a = cur + deg * RAD;
            const c = { x: bot.x + Math.cos(a) * r, z: bot.z + Math.sin(a) * r };
            if (boomHeight(g, c, c, g.ground, chest).rise > 0) { g.swingTo = a; break; }
          }
        }
      }
      g.boom += (g.boomWant - g.boom) * ease(dt, g.boomWant < g.boom ? cfg.boomDownSec : cfg.boomUpSec);

      const want = { x: spot.x, y: g.ground + g.boom, z: spot.z };
      g.spot = { x: spot.x, z: spot.z };
      const st = g.stats;
      st.n++;
      const lensNear = Math.hypot(spot.x - head.x, spot.z - head.z);
      const trackNearRaw = Math.hypot(at.x - head.x, at.z - head.z);
      if (lensNear < st.lensMin) st.lensMin = lensNear;
      if (trackNearRaw < st.trackMin) st.trackMin = trackNearRaw;
      if (lensNear < cfg.standoffBlocks - 0.5) st.lensUnder++;
      if (trackNearRaw < cfg.standoffBlocks - 0.5) st.trackUnder++;
      if (holding) st.holdMs += dt * 1000;
      const me = g.bot.entity.position;
      if (Math.hypot(me.x - want.x, me.y - want.y, me.z - want.z) > cfg.regrabBlocks) {
        g.wantFar = want;          // the rig puts it back by console; flying there would be refused
        return;
      }
      g.wantFar = null;

      // ── where the lens looks ──
      let aim = routePoint(routeFor(g.target), head, cfg.lookAheadBlocks, cfg.offRouteBlocks, cfg.aimRise);
      if (!aim) {
        const was = sampleAt(g.hist, now - 1000);
        const vx = head.x - was.x, vz = head.z - was.z;
        const sp = Math.hypot(vx, vz);
        if (sp > 0.8) aim = { x: head.x + vx / sp * cfg.lookAheadBlocks, y: head.y + cfg.aimRise, z: head.z + vz / sp * cfg.lookAheadBlocks };
      }
      // Holding off, the lens looks at the bot itself: ahead along a route the bot is walking back over points
      // behind the lens.
      const atBot = { x: head.x, y: head.y + CHEST, z: head.z };
      if (g.blend > 0.01) aim = aim
        ? { x: aim.x + (atBot.x - aim.x) * g.blend, y: aim.y + (atBot.y - aim.y) * g.blend, z: aim.z + (atBot.z - aim.z) * g.blend }
        : atBot;
      if (aim) {
        if (!g.look) g.look = { ...aim };
        const k = ease(dt, cfg.lookEaseSec + (cfg.leashLookEaseSec - cfg.lookEaseSec) * g.blend);
        g.look.x += (aim.x - g.look.x) * k; g.look.y += (aim.y - g.look.y) * k; g.look.z += (aim.z - g.look.z) * k;
      }

      const eyeY = want.y + EYE;
      if (g.look) {
        const dx = g.look.x - want.x, dy = g.look.y - eyeY, dz = g.look.z - want.z;
        const flat = Math.hypot(dx, dz);
        if (flat > 1) {
          const wantYaw = Math.atan2(-dx, -dz) / RAD;
          const wantPitch = clamp(Math.atan2(dy, flat) / RAD, -cfg.pitchMaxDeg, cfg.pitchMaxDeg);
          if (g.yaw == null) { g.yaw = wantYaw; g.pitch = wantPitch; }
          const cap = (cfg.maxTurnDegPerSec + (cfg.leashTurnDegPerSec - cfg.maxTurnDegPerSec) * g.blend) * dt;
          g.yaw += clamp(shortestDeg(wantYaw - g.yaw), -cap, cap);
          g.pitch += clamp(wantPitch - g.pitch, -cap, cap);
        }
      }

      me.x = want.x; me.y = want.y; me.z = want.z;
      if (g.yaw != null) {
        g.bot.look(g.yaw * RAD, g.pitch * RAD, true);
        // On the wire, yaw and pitch are the game's degrees: yaw measured the other way round from
        // mineflayer's, pitch positive downward.
        const pkt = { x: want.x, y: want.y, z: want.z, yaw: Math.fround(180 - g.yaw), pitch: Math.fround(-g.pitch),
          onGround: false, flags: { onGround: false, hasHorizontalCollision: false } };
        const ls = g.lastSent;
        if (!ls || ls.x !== pkt.x || ls.y !== pkt.y || ls.z !== pkt.z || ls.yaw !== pkt.yaw || ls.pitch !== pkt.pitch
            || now - ls.at >= IDLE_SEND_MS) {
          g.sendMove(pkt);
          g.lastSent = { ...pkt, at: now };
          g.sentAny = true;
        }
      }
    } catch (e) {
      // A world or entity read can throw while chunks stream; holding still for one step is right, and
      // killing the interval would freeze the camera for the rest of the run.
    }
  }

  return {
    available: true,
    isReady: b => { const g = riders.get(b); return !!(g && g.ready); },
    nameFor: b => `${cfg.prefix}${b}`,
    targetOf: b => { const g = riders.get(b); return g ? g.target : null; },
    // retarget(key, bot): the rider rides another bot from now. Its track starts over, so it is far from its
    // new spot at once and the rig carries it there by console (far / sees below).
    retarget: (b, bot) => {
      const g = riders.get(b);
      if (!g || g.target === bot) return false;
      g.target = bot;
      fresh(g);
      if (log) log(`${g.username} now riding ${bot}.`);
      return true;
    },
    // far(bot) → {x,y,z} feet spot the rider must be put back at by the console, or null when it can fly.
    far: b => { const g = riders.get(b); return g && g.ready ? g.wantFar : null; },
    // sees(bot) → whether the rider has heard the bot move; a rider that has not is out of tracking range,
    // and only the console can bring it to the bot.
    sees: b => {
      const g = riders.get(b);
      if (!g || !g.ready || !g.bot) return false;
      const other = g.bot.players[g.target];
      return !!(other && other.entity && other.entity.position && g.hist.length);
    },
    // distances(key) → what the lens kept since the last call, then starts counting again: lensMin / trackMin
    // (nearest across the ground, blocks), the share of steps more than half a block inside standoffBlocks for the
    // lens and for the plain track spot, and seconds held off. Null with no steps counted.
    distances: b => {
      const g = riders.get(b);
      if (!g || !g.stats.n) return null;
      const s = g.stats;
      g.stats = freshStats();
      return {
        bot: g.target, secs: Math.round((Date.now() - s.sinceMs) / 1000),
        lensMin: +s.lensMin.toFixed(2), trackMin: +s.trackMin.toFixed(2),
        lensUnderPct: +(100 * s.lensUnder / s.n).toFixed(1), trackUnderPct: +(100 * s.trackUnder / s.n).toFixed(1),
        holdSec: Math.round(s.holdMs / 1000),
        // LOST SIGHT: seconds the lens could not see the bot, seeks begun, and clear views a seek's search found.
        blindSec: Math.round(s.blindMs / 1000), seeks: s.seeks, seekFound: s.found,
      };
    },
    endAll: () => {
      for (const g of riders.values()) {
        g.ended = true;
        if (g.timer) clearInterval(g.timer);
        if (g.reconnect) clearTimeout(g.reconnect);
        try { g.bot && g.bot.quit(); } catch (e) { /* already gone */ }
      }
    },
  };
}

module.exports = { createRiders, parseCells, routePoint, sampleAt, pointAtS, advance, groundAt, holdOff };
