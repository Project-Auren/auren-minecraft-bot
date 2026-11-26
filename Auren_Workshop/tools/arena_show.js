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
// A round is a wave (lanista's `--wave` form) and `every`: the wave is staged whole behind the closed gates, spread one
// mob per gate in turn, and the gates open `every` seconds apart (0: all at once).
const SHOWS = {
  // The emperor's first schedule, and the wave book's start: one; ten with the gates every 3 s; then 2, 4, 6, 12, 24 at
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

// ── THE WAVE BOOK: the emperor's own rounds, edited on the When Board and kept between shows ─────────────────
// WAVE_BOOK holds { rounds: [ { groups: [ { mob, count, gate } ], every } ] }. A group's `gate` is one of GATE_NAMES, or
// 'spread' (one mob per gate in turn). `every` is the seconds between one gate opening and the next; 0 opens every gate
// at once. Gates open in RELEASE_ORDER among those holding mobs. `--show=book` runs it, read again before every round,
// so a round edited between rounds is the round that runs. A missing book starts as the emperor's schedule.
const path = require('path');
const fs = require('fs');
const WAVE_BOOK = path.join(__dirname, 'arena_set_waves.json');
const GATE_NAMES = ['north', 'south', 'west', 'east'];          // arena_set GATES, in its order
const RELEASE_ORDER = ['north', 'east', 'south', 'west'];
// The mobs the board offers: every hostile that is not a boss and fits a pen (3 wide, 3 high), the ghast excepted (too
// big). The velarium closes the bowl overhead, so the sun burns none of them at noon. Each names what a summon does not
// give it: `id` the entity when it differs from the name, `hand` the item it fights with, `nbt` its own fields, and
// `mount` the mob it rides. A mount that does not fight (a horse, a chicken) is tagged MOUNT_TAG: it wakes and is cleared
// with the wave and is not counted in the field, so a round ends when its riders are dead. Left out: the neutrals that
// start no fight (enderman, piglin, zombified piglin), the water mobs (guardians), the shulker (it never leaves its pen),
// the creaking (it needs a heart), the bosses and the ghast.
const BOOK_MOBS = {
  creeper: {}, zombie: {}, husk: {}, drowned: { hand: 'trident' }, zombie_villager: {},
  skeleton: { hand: 'bow' }, stray: { hand: 'bow' }, bogged: { hand: 'bow' }, wither_skeleton: { hand: 'stone_sword' },
  spider: {}, cave_spider: {}, witch: {}, slime: { nbt: 'Size:1' }, magma_cube: { nbt: 'Size:1' },
  blaze: {}, breeze: {}, silverfish: {}, endermite: {}, phantom: {},
  vindicator: { hand: 'iron_axe' }, pillager: { hand: 'crossbow' }, evoker: {}, vex: { hand: 'iron_sword' }, ravager: {},
  piglin_brute: { hand: 'golden_axe', nbt: 'IsImmuneToZombification:1b' }, hoglin: { nbt: 'IsImmuneToZombification:1b' }, zoglin: {},
  warden: {},
  zombie_horseman: { id: 'zombie', hand: 'iron_spear', mount: { id: 'zombie_horse', nbt: 'equipment:{saddle:{id:"minecraft:saddle",count:1}}' } },
  spider_jockey: { id: 'skeleton', hand: 'bow', mount: { id: 'spider', fights: true } },
  chicken_jockey: { id: 'zombie', nbt: 'IsBaby:1b', mount: { id: 'chicken' } },
};
const MOUNT_TAG = 'arena_mount';
const MAX_EVERY = 120;

const fromShow = (rounds) => ({ rounds: rounds.map(r => ({
  groups: r.wave.split(',').map(g => { const [mob, n] = g.split(':'); return { mob, count: parseInt(n, 10) || 1, gate: 'spread' }; }),
  every: r.every || 0,
})) });
// checkBook(book, penPerGate) → { ok, book } | { ok:false, why }: every round fits its pens and names known mobs and gates.
function checkBook(book, penPerGate) {
  if (!book || !Array.isArray(book.rounds) || !book.rounds.length) return { ok: false, why: 'the book holds no round' };
  for (const [i, r] of book.rounds.entries()) {
    const at = `round ${i + 1}`;
    if (!r || typeof r !== 'object' || !Array.isArray(r.groups) || !r.groups.length) return { ok: false, why: `${at} holds no monster` };
    if (!Number.isFinite(r.every) || r.every < 0 || r.every > MAX_EVERY) return { ok: false, why: `${at}: gates every ${r.every}s is not 0–${MAX_EVERY}` };
    const load = Object.fromEntries(GATE_NAMES.map(g => [g, 0]));
    let spread = 0;
    for (const g of r.groups) {
      if (!g || typeof g !== 'object') return { ok: false, why: `${at}: a monster line is empty` };
      if (!Object.prototype.hasOwnProperty.call(BOOK_MOBS, g.mob)) return { ok: false, why: `${at}: '${g.mob}' is not offered (${Object.keys(BOOK_MOBS).join(', ')})` };
      if (!Number.isInteger(g.count) || g.count < 1) return { ok: false, why: `${at}: ${g.mob} count ${g.count} is not a whole number of 1 or more` };
      if (g.gate !== 'spread' && !GATE_NAMES.includes(g.gate)) return { ok: false, why: `${at}: gate '${g.gate}' is not ${GATE_NAMES.join(', ')} or spread` };
      if (g.gate === 'spread') for (let k = 0; k < g.count; k++) load[GATE_NAMES[(spread++) % GATE_NAMES.length]]++;
      else load[g.gate] += g.count;
    }
    const over = GATE_NAMES.filter(g => load[g] > penPerGate);
    if (over.length) return { ok: false, why: `${at}: the ${over.join(' and ')} pen holds ${penPerGate} and is asked for ${over.map(g => load[g]).join(' and ')}` };
  }
  return { ok: true, book };
}
// readBook() → the book on disk, or the emperor's schedule when none is saved.
function readBook() { return fs.existsSync(WAVE_BOOK) ? JSON.parse(fs.readFileSync(WAVE_BOOK, 'utf8')) : fromShow(SHOWS.emperor); }
// writeBook(book, penPerGate) → the check's answer; written only when it passes.
function writeBook(book, penPerGate) {
  const c = checkBook(book, penPerGate);
  if (c.ok) fs.writeFileSync(WAVE_BOOK, `${JSON.stringify(book, null, 1)}\n`);
  return c;
}
// bookRound(round) → lanista's form of one book round: the wave groups (with each mob's hand) and each group's gate.
function bookRound(round) {
  return {
    wave: round.groups.map(g => ({ mob: g.mob, count: g.count, hand: (BOOK_MOBS[g.mob] || {}).hand || null, gate: g.gate })),
    every: round.every || 0,
  };
}

// showRounds(name, penCells) → { ok, rounds } or { ok:false, why }. A round larger than the pens would stack mobs
// on one cell, so it is refused here, before anything is summoned.
function showRounds(name, penCells) {
  const rounds = SHOWS[name];
  if (!rounds) return { ok: false, why: `no show named '${name}' — declared: ${Object.keys(SHOWS).join(', ')}, or 'book'` };
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
  let waiting = null;              // what awaitRelease is holding for ('stage' | 'wave' | 'dismiss'), or null
  let boardRelease = false;        // a board release press, taken by the waiting awaitRelease
  let restaged = false;            // a committed wave book, taken by a staged round's awaitRelease as 'restage'
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
    // never pressed it; 'restage' when the book was committed while it waited (restage()).
    // `why` is what the board shows while it waits.
    async awaitRelease(why = 'wave') {
      const until = Date.now() + RELEASE_WAIT_MS;
      waiting = why;
      boardRelease = false;
      restaged = false;
      while (Date.now() < until) {
        if (restaged) { waiting = null; return 'restage'; }
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
    // restage() → what the release was waiting for ('wave': the staged round is staged again from the committed book;
    // 'dismiss': the show reads the book for a further round), or false when nothing waits.
    // While the crowd waits to be dismissed, a commit wakes the wait too, so a round added to the book is staged at once.
    restage() { if (waiting !== 'wave' && waiting !== 'dismiss') return false; restaged = true; return waiting; },
    // press(k) → words. The board's press on control k: 'release' lets the waiting wave out (or dismisses the crowd);
    // 'up' | 'down' gives the emperor's verdict, as the lever does.
    async press(k) {
      if (k === 'release') {
        if (!waiting) return 'nothing is waiting on release';
        boardRelease = true;
        return waiting === 'wave' ? 'released' : waiting === 'stage' ? 'wave 0: staging round 1' : 'crowd dismissed';
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

module.exports = { SHOWS, showRounds, dropTnt, createEmperor, RELEASE_WAIT_MS, WAVE_BOOK, GATE_NAMES, RELEASE_ORDER, BOOK_MOBS, MOUNT_TAG, MAX_EVERY, checkBook, readBook, writeBook, bookRound };
