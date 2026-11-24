// arena_show — the filmed show in the colosseum (arena_set): the declared shows (the waves, in order), the emperor's
// controls read over the console, and the TNT from the ceiling. The crowd that answers the verdicts is not the bot's:
// it lives outside the shipped tree (lanista reaches it through workstation.findNpc).
//
// The emperor paces the show from his box. No redstone: each control is a block whose `powered` state is read by
// `execute if block` (Law 23 — the server's own answer). The release button lets the staged wave out; the thumbs-up and
// thumbs-down levers give the emperor's verdict, over the verdict the round itself gave.
//
// Used by `lanista --arena --show=<name> --emperor` (or `--board`). Holds no number about the bot (Law 25): every value
// here shapes the world or the show's own pace.

'use strict';

const { sleep } = require('./lanista_shared');

// ── THE SHOWS ───────────────────────────────────────────────────────────────────────────────────────
// A round is a wave (lanista's `--wave` form) and, for a trickle, `every`: the wave is staged whole behind the closed
// gates and let out one mob at a time, `every` seconds apart, through the gates in turn.
const SHOWS = {
  // The emperor's schedule: one; one every 3 s from alternating gates for 30 s; then 2, 4, 6, 12, 24 at
  // once. The run ends the round the body falls.
  emperor: [
    { wave: 'creeper:1' },
    { wave: 'creeper:10', every: 3 },
    { wave: 'creeper:2' },
    { wave: 'creeper:4' },
    { wave: 'creeper:6' },
    { wave: 'creeper:12' },
    { wave: 'creeper:24' },
  ],
};

// showRounds(name, penCells) → { ok, rounds } or { ok:false, why }. A round larger than the pens would stack mobs
// on one cell, so it is refused here, before anything is summoned.
function showRounds(name, penCells) {
  const rounds = SHOWS[name];
  if (!rounds) return { ok: false, why: `no show named '${name}' — declared: ${Object.keys(SHOWS).join(', ')}` };
  for (const [i, r] of rounds.entries()) {
    const count = r.wave.split(',').reduce((s, g) => s + (parseInt(g.split(':')[1], 10) || 1), 0);
    if (count > penCells) return { ok: false, why: `round ${i + 1} of '${name}' stages ${count} mobs and the pens hold ${penCells}` };
  }
  return { ok: true, rounds };
}

// ── THE TNT FROM THE CEILING ────────────────────────────────────────────────────────────────────────
// Lit TNT summoned just under the velarium over the sand, at scattered points; it falls on its own and goes off about a
// second after it lands. It wrecks the set and everything on the sand: place the set again (arena_set.js --place)
// before the next show. Mob griefing being off does not stop TNT.
const TNT_FALL = 22;               // blocks above the sand it is summoned at, under the awning's lanterns
const TNT_FUSE_TICKS = 80;         // the fall takes about 45 ticks; the rest is the beat on the ground
const TNT_SPREAD = 8;              // the farthest from the centre a block falls, inside the sand's radius

// dropTnt(rcon, center, count) → { summoned, read }: how many the server holds right after, read back (Law 23).
async function dropTnt(rcon, center, count) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * 2 * Math.PI, d = Math.sqrt(Math.random()) * TNT_SPREAD;
    const x = center.x + 0.5 + Math.cos(a) * d, z = center.z + 0.5 + Math.sin(a) * d;
    await rcon.command(`summon minecraft:tnt ${x.toFixed(2)} ${center.y + TNT_FALL} ${z.toFixed(2)} {fuse:${TNT_FUSE_TICKS + Math.floor(Math.random() * 20)}}`);
  }
  const said = (await rcon.command('execute if entity @e[type=minecraft:tnt]')) || '';
  const m = /count:?\s*(\d+)/i.exec(said);
  return { summoned: count, read: m ? Number(m[1]) : (/passed/i.test(said) ? null : 0) };
}

// ── THE EMPEROR'S CONTROLS ──────────────────────────────────────────────────────────────────────────
const POLL_MS = 200;               // a stone-type button stays pressed 20 ticks (1 s); five reads land inside it
const RELEASE_WAIT_MS = 30 * 60 * 1000;  // the longest the show waits on the emperor before it ends itself (Law 8)

// createEmperor(rcon, set) → the console. `set` is arena_set; `center` the placed set's centre sand cell.
function createEmperor(rcon, set, center) {
  const d = set.design();
  const cell = k => { const q = d.points.controls[k]; return { ...set.toWorld(center, q.at), block: q.block }; };
  const controls = { release: cell('release'), up: cell('up'), down: cell('down') };
  const powered = async (c) => /passed/i.test((await rcon.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:${c.block}[powered=true]`)) || '');
  let watching = false, last = { up: null, down: null };
  const heard = [];
  // THE WHEN BOARD is a second hand on the same controls: a press there counts exactly as the block in the box does.
  let waiting = null;              // what awaitRelease is holding for ('wave' | 'dismiss'), or null
  let boardRelease = false;        // a board release press, taken by the waiting awaitRelease
  let verdict = null;              // startLevers' onVerdict, so a board thumbs press reaches the same banners

  // The verdict levers, watched for the whole show: a lever thrown ON puts its banner up, whatever the round said.
  async function watchLevers(onVerdict) {
    watching = true;
    verdict = onVerdict;
    while (watching) {
      for (const k of ['up', 'down']) {
        const on = await powered(controls[k]);
        if (last[k] === false && on) { heard.push({ at: Date.now(), control: k }); await onVerdict(k); }
        last[k] = on;
      }
      await sleep(POLL_MS);
    }
  }

  return {
    controls,
    heard,
    // Whether every control is standing where the design put it (Law 23): false names the first missing one.
    async check() {
      for (const [k, c] of Object.entries(controls)) {
        if (!/passed/i.test((await rcon.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:${c.block}`)) || '')) return { ok: false, why: `the ${k} ${c.block} is not at ${c.x} ${c.y} ${c.z} — place the set again with arena_set.js --place` };
      }
      return { ok: true };
    },
    // Resolves true the moment the release button reads pressed (in the box or on the board); false if the emperor
    // never pressed it. `why` is what the board shows while it waits.
    async awaitRelease(why = 'wave') {
      const until = Date.now() + RELEASE_WAIT_MS;
      waiting = why;
      boardRelease = false;
      while (Date.now() < until) {
        if (boardRelease || await powered(controls.release)) {
          heard.push({ at: Date.now(), control: 'release', from: boardRelease ? 'board' : 'box' });
          waiting = null;
          return true;
        }
        await sleep(POLL_MS);
      }
      waiting = null;
      return false;
    },
    // What the release is waiting for, or null.
    waiting: () => waiting,
    // press(k) → words. The board's press on control k: 'release' lets the waiting wave out (or dismisses the crowd);
    // 'up' | 'down' gives the emperor's verdict, as the lever does.
    async press(k) {
      if (k === 'release') {
        if (!waiting) return 'nothing is waiting on release';
        boardRelease = true;
        return waiting === 'wave' ? 'released' : 'crowd dismissed';
      }
      if (!verdict) return 'the verdict watch is not running';
      heard.push({ at: Date.now(), control: k, from: 'board' });
      await verdict(k);
      return `thumbs ${k}`;
    },
    // Runs until stop(). A console read that fails once the run is closing ends the watch and is said, never thrown.
    startLevers(onVerdict) {
      return watchLevers(onVerdict).then(() => null, (e) => { watching = false; console.log(`[emperor] the lever watch ended: ${e.message}`); });
    },
    stop() { watching = false; },
  };
}

module.exports = { SHOWS, showRounds, dropTnt, createEmperor, RELEASE_WAIT_MS };
