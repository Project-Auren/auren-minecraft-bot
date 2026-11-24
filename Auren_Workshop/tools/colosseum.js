// colosseum — many arenas at once. One fleet start, several bodies, each on its own ground with its own copy of the same
// wave, fought together and scored off the server together: a dozen fights in the time one lanista round with its fresh
// start took. ONE BODY, ONE FIGHT: more fights are more bodies (up to the seat's roster), never a body fought again, so
// every fight starts from a body no earlier fight has touched.
//
// Built on lanista's pieces, never a second copy of them (Law 16): the scout and the world (openArena), the siting
// (siteArena), the kit and the heal (kitBot, healBot), the placement (placeBot), the summon and the field count, each
// narrowed to one arena by a tag of its own (summonAt / readArenaMobs / clearArena with `tag`), and the watch gate
// (awaitStandingWatch). Outside the construct (Law 19, Law 26): it authors inputs and reads outputs; why a fight went as
// it did is the combat record's, read through `trace_monitor --fight-record --fight=<name>:1`.
//
// Every body is: respawned if dead, re-armed in sentry wearing the terminator kit (`verb sentry --kit`, so it
// fights as a terminator: it never runs), re-kitted, healed, fed, cleared of effects, and put back on its own arena's
// stand. When every watch is standing, every wave is summoned, and each fight is watched until the body dies, its field
// empties, or the ceiling. Arenas are sited once and reused: mob griefing is off while the bench runs (fleet_control's
// own bring-up rule), so a blast leaves the ground as it was and every run is fought on the same ground.
//
// THE ARENAS ARE KEPT. A rollback start puts back the same world every time, and a sweep for one arena costs minutes, so
// every arena sited is written to ARENA_BOOK, keyed by the world's name, the wave's size, the range and the origin, one per
// slot (the n-th body takes the n-th arena). The next run on that world reads its arenas back and sites only what the book
// lacks. `--resite` ignores the book and sites afresh.
//
// Usage (the fleet raised first with the same bodies, on this copy's seat):
//   node Auren_Bot/start_auren.js --start rollback --only VedaBot,CorinBot,MarnoBot,XylarBot,ThalonBot --soak 120 --landing usual --wake error
//   node Auren_Bot/Auren_Workshop/tools/colosseum.js --bots=VedaBot,CorinBot,MarnoBot,XylarBot,ThalonBot
//        --wave=witch:1,zombie:2,skeleton:2@bow,spider:1,creeper:1 --kit=<lanista kit> [--terminator=T-1]
//        [--ceiling=90] [--range=12] [--spacing=160] [--origin=400,400] [--resite]
// Exit codes: 0 every fight ran · 2 a fight could not be staged · 1 could not run at all.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/colosseum.js');

const path = require('path');
const { spawnSync } = require('child_process');
const { SCOUT_NAME, fmt, log, sleep } = require('./lanista_shared');
const lanista = require('./lanista');
const combatLens = require('../../monitoring/combat_lens');

const FLEET_CONTROL = path.join(__dirname, '..', 'fleet_control.js');
const TAG_PREFIX = 'colosseum_';
const POLL_MS = 500;
const CLEAR_FLOOR_MS = 3000;     // a summoned mob takes a tick or two to exist: an empty field before this is not a clear
const RESPAWN_WAIT_MS = 20000;
const RESPAWN_SETTLE_MS = 3000;
const ARM_READ_MS = 15000;
const UNREACHED_MS = 10000;
const UNREACHED_READ_MS = 2000;
const SITE_TRIES = 5;
const SPREAD_WAIT_MS = 15000;
const SPREAD_RANGE_B = 30;         // the spread looks this far round the ask for dry ground: a range of 1 found only water off the coast
const SPREAD_NEAR_B = 45;          // so the body stands within the range's corner of the ask once it is there
// Two arenas nearer than this share a fight: a zombie follows its target up to 35 b, a skeleton shoots from 16.
const MIN_APART_B = 100;
const tooNear = (cell, taken) => taken.some((o) => Math.hypot(o.x - cell.x, o.z - cell.z) < MIN_APART_B);
const ARENA_BOOK = path.join(__dirname, 'colosseum_arenas.json');
const fs = require('fs');
function readBook() { try { return JSON.parse(fs.readFileSync(ARENA_BOOK, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
function bookKey(a, want) {
  const level = require('@utils/server_settings').levelName(require('@utils/workstation').needServerDir());
  return `${level}|mobs=${want}|range=${a.range}|origin=${a.origin.x},${a.origin.z}|spacing=${a.spacing}`;
}            // an origin whose ground holds no arena is moved one spacing along z and tried again

function parseArgs(argv) {
  const a = { resite: false, bots: [], wave: null, kit: null, terminator: 'T-1', ceiling: 90, range: 12, spacing: 160, origin: { x: 400, z: 400 } };
  for (const raw of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!m) throw new Error(`colosseum: '${raw}' is not an option (--name=value).`);
    const [, k, v] = m;
    if (k === 'resite') { a.resite = true; continue; }
    if (k === 'bots') a.bots = v.split(',').filter(Boolean);
    else if (k === 'wave') a.wave = lanista.parseWave(v);
    else if (k === 'kit') a.kit = v.split(',').filter(Boolean);
    else if (k === 'terminator') a.terminator = v === 'none' ? null : v;
    else if (k === 'ceiling' || k === 'range' || k === 'spacing') a[k] = Number(v);
    else if (k === 'origin') { const [x, z] = v.split(',').map(Number); a.origin = { x, z }; }
    else throw new Error(`colosseum: unknown option --${k}.`);
  }
  if (!a.bots.length || !a.wave) throw new Error('colosseum: --bots and --wave are required.');
  return a;
}

function verb(args) {
  const r = spawnSync(process.execPath, [FLEET_CONTROL, 'verb', ...args], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

// armSentry — the watch armed on a terminator, unless the record already shows it armed. A body that died since its
// watch last armed is armed again: the death ended its watch loop, and the armed mode alone never stands it back up
// (a body killed in one wave stalled the next for 90 s, "armed but never re-armed a watch loop").
function armSentry(a, bot) {
  const w = combatLens.watchState(bot);
  if (w && w.armed && !w.diedSinceArmed) return 'armed';
  verb(['sentry', `--bot=${bot}`, ...(a.terminator ? [`--kit=${a.terminator}`] : [])]);
  return 'sent';
}

// A BODY ITS OWN RECORD CALLS DEAD IS RESPAWNED whatever one console read says: the console has one reply buffer for every
// client, and a body dead since the last wave once read alive, was armed dead, and its watch ended at once on `died`
// (XylarBot, ZarekBot). The body's `respawn` is a no-op on a living body, so sending it costs nothing.
async function reviveIfDead(rcon, bot) {
  const w = combatLens.watchState(bot);
  const recordSaysDead = !!(w && w.diedSinceArmed);
  const v = await lanista.readBotVitals(rcon, bot);
  if (v.known && v.alive && !recordSaysDead) return true;
  verb(['respawn', `--bot=${bot}`]);
  // The respawn's arrival is read off the server, and one read is not trusted (the shared reply buffer): alive twice running,
  // and either moved off the place it lay (a respawn puts it at the world's spawn) or RESPAWN_SETTLE_MS gone (a body
  // already standing, whose respawn did nothing).
  const lay = v.position;
  const sentAt = Date.now();
  let aliveReads = 0;
  for (const end = Date.now() + RESPAWN_WAIT_MS; Date.now() < end;) {
    await sleep(500);
    const r = await lanista.readBotVitals(rcon, bot);
    aliveReads = r.known && r.alive ? aliveReads + 1 : 0;
    const moved = !!(lay && r.position && Math.hypot(r.position.x - lay.x, r.position.z - lay.z) > 2);
    if (aliveReads >= 2 && (moved || Date.now() - sentAt >= RESPAWN_SETTLE_MS)) return true;
  }
  return false;
}

// siteFor — one arena per body: the body is set on the surface at its origin (spreadplayers finds the top block), the
// scout is moved over it, and lanista's sweep sites the stand and the mob cells from there.
async function siteFor(scout, rcon, a, bot, i, want, taken) {
  for (let t = 0; t < SITE_TRIES; t++) {
    const x = a.origin.x + i * a.spacing, z = a.origin.z + t * a.spacing;
    const spread = String(await rcon.command(`spreadplayers ${x} ${z} 0 ${SPREAD_RANGE_B} false ${bot}`) || '');
    // A refused spread leaves the body where it stood: its reply is read, and the body is never sited where it already was.
    // The reply is searched, not read from its start: the server console has ONE output buffer for every rcon client, so
    // a reply can carry the foreman's answer to its own question glued in front of this one.
    if (!/Spread \d+ entit/.test(spread)) { log('site', `${bot}: no spread at (${x},${z}) — ${spread.trim() || 'no reply'}`); continue; }
    // The server answers the spread before the body is there: its place is read until it stands within SPREAD_NEAR_B of
    // the ask, so an arena is never sited where the body stood before.
    let v = null;
    for (const end = Date.now() + SPREAD_WAIT_MS; Date.now() < end;) {
      await sleep(500);
      const r = await lanista.readBotVitals(rcon, bot);
      if (r.known && r.position && Math.hypot(r.position.x - x, r.position.z - z) < SPREAD_NEAR_B) { v = r; break; }
    }
    if (!v) { log('site', `${bot}: never stood at (${x},${z}) after its spread.`); continue; }
    const cell = { x: Math.floor(v.position.x), y: Math.floor(v.position.y), z: Math.floor(v.position.z) };
    if (!await lanista.awaitScoutSees(scout, rcon, cell)) continue;
    const sited = await lanista.siteArena(scout, cell, want, a.range, 0, false);
    if (sited.cells.length && tooNear(sited.botCell, taken)) { log('site', `${bot}: stand ${fmt(sited.botCell)} is within ${MIN_APART_B} b of another arena — tried further on.`); continue; }
    if (sited.cells.length) return { ok: true, bot, tag: `${TAG_PREFIX}${bot}`, botCell: sited.botCell, cells: sited.cells };
    log('site', `${bot}: no arena near ${fmt(cell)} — ${sited.detail}`);
  }
  return { ok: false, bot };
}

// stage — the body made ready for its fight: alive, armed, kitted, whole, fed, clean, on its stand.
async function stage(rcon, a, arena) {
  const { bot } = arena;
  if (!await reviveIfDead(rcon, bot)) return { ok: false, why: 'would not respawn' };
  armSentry(a, bot);
  if (a.kit) {
    const k = await lanista.kitBot(rcon, bot, a.kit);
    if (!k.ok) return { ok: false, why: `kit missing ${k.missing.join(', ')}` };
  }
  await rcon.command(`effect clear ${bot}`);
  await rcon.command(`effect give ${bot} minecraft:saturation 1 20 true`);
  const put = await lanista.placeBot(rcon, bot, arena.botCell);
  if (!put.ok) return { ok: false, why: put.why };
  const healed = await lanista.healBot(rcon, bot);
  if (!healed.ok) return { ok: false, why: `would not heal (hp ${healed.health})` };
  return { ok: true };
}

async function summonWave(rcon, a, arena) {
  const cells = arena.cells.slice().sort((p, q) => (p.distance || 0) - (q.distance || 0));
  let next = 0, placed = 0;
  for (const g of a.wave) {
    for (let i = 0; i < g.count; i++) {
      const c = cells[next++ % cells.length];
      const r = await lanista.summonAt(rcon, g.mob, c, g.hand, '', arena.tag);
      if (r.ok) placed++;
    }
  }
  return placed;
}

// watchFight — the server's word only: the body's health and death count, the arena's own tagged field.
async function watchFight(rcon, a, arena) {
  const { bot, tag } = arena;
  const t0 = Date.now();
  let minHp = Infinity, hpEnd = null, mobsStart = null, mobsEnd = null, lastRead = 0;
  while (Date.now() - t0 < a.ceiling * 1000) {
    const v = await lanista.readBotVitals(rcon, bot);
    const f = await lanista.readArenaMobs(rcon, tag);
    const deaths = (await lanista.readDeaths(rcon, bot)) || 0;
    if (mobsStart === null) mobsStart = f.count;
    mobsEnd = f.count;
    if (v.known) { hpEnd = v.health; minHp = Math.min(minHp, v.health); }
    const done = (outcome) => ({ bot, outcome, ms: Date.now() - t0, minHp: minHp === Infinity ? null : Math.round(minHp * 10) / 10, hpEnd, mobsStart, mobsEnd });
    if (deaths >= 1 || (v.known && !v.alive)) return done('died');
    if (f.count === 0 && Date.now() - t0 > CLEAR_FLOOR_MS) return done('cleared');
    // A MOB THAT NEVER CAME: the body's watch stands again, nothing engaged, for UNREACHED_MS with the field not empty. The
    // body has beaten all that came to it; the ceiling would only wait on a mob stuck out of its reach. Read off the
    // body's own record (the server cannot see a disengage), every UNREACHED_READ_MS, not every poll.
    if (f.count > 0 && Date.now() - lastRead >= UNREACHED_READ_MS) {
      lastRead = Date.now();
      const w = combatLens.watchState(bot);
      if (w && w.standing && !w.engaged && w.standingAt > t0 && Date.now() - w.standingAt >= UNREACHED_MS) return done('unreached');
    }
    await sleep(POLL_MS);
  }
  return { bot, outcome: 'timeout', ms: Date.now() - t0, minHp: minHp === Infinity ? null : Math.round(minHp * 10) / 10, hpEnd, mobsStart, mobsEnd };
}

// ONE COMMAND ON THE WIRE AT A TIME. The server's rcon reads one packet per read and closed the link the moment five
// watched fights sent their reads together (server log: summons, then 'RCON Client shutting down'). Every command of the
// bench goes through this queue, so the fights are watched together and asked one at a time.
function queued(rcon) {
  let tail = Promise.resolve();
  return {
    command(cmd) {
      const p = tail.then(() => rcon.command(cmd));
      tail = p.then(() => undefined, () => undefined);
      return p;
    },
    close: () => rcon.close(),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const want = a.wave.reduce((s, g) => s + g.count, 0);
  const link = await lanista.openArena();
  if (!link.ok) { console.error(`Cannot run: ${link.why}`); return 1; }
  const scout = link.scout;
  const rcon = queued(link.rcon);
  const griefBefore = ((await rcon.command('gamerule mob_griefing')) || '').trim();
  await rcon.command('gamerule mob_griefing false');
  let exit = 0;
  try {
    await lanista.ensureDeathCounter(rcon);
    // A BODY IS ALIVE BEFORE IT IS ARMED: a dead body armed here ends its watch on `died` at once, and the revive after
    // brings it back with no watch at all (the last wave's dead stood unarmed and were killed without a swing).
    for (const bot of a.bots) {
      if (!await reviveIfDead(rcon, bot)) { console.error(`Cannot run: ${bot} — dead and would not respawn`); return 1; }
    }
    // Every body off its work before any is moved: a body carried away mid-walk strands its walk.
    for (const bot of a.bots) armSentry(a, bot);
    for (const bot of a.bots) {
      // The record is written a beat after the verb lands: the arm is read back, given ARM_READ_MS to appear.
      for (const end = Date.now() + ARM_READ_MS; Date.now() < end && !(combatLens.watchState(bot) || {}).armed;) await sleep(500);
      const w = await lanista.awaitStandingWatch(bot);
      if (!w.ok) { console.error(`Cannot run: ${bot} — ${w.reason}`); return 1; }
    }

    // ── THE ARENAS, SITED ONCE ──
    const arenas = [];
    const book = readBook();
    const key = bookKey(a, want);
    const slots = a.resite ? [] : (book[key] || []);
    for (const [i, bot] of a.bots.entries()) {
      if (!await reviveIfDead(rcon, bot)) { log('site', `${bot}: dead and would not respawn — left out.`); exit = 2; continue; }
      const kept = slots[i] && !tooNear(slots[i].botCell, arenas.map((r) => r.botCell)) ? slots[i] : null;
      const s = kept ? { ok: true, bot, tag: `${TAG_PREFIX}${bot}`, botCell: kept.botCell, cells: kept.cells } : await siteFor(scout, rcon, a, bot, i, want, arenas.map((r) => r.botCell));
      if (!s.ok) { log('site', `${bot}: no arena found — left out.`); exit = 2; continue; }
      if (!kept) { slots[i] = { botCell: s.botCell, cells: s.cells }; book[key] = slots; fs.writeFileSync(ARENA_BOOK, `${JSON.stringify(book, null, 1)}
`); }
      arenas.push(s);
      log('site', `${bot}: stand ${fmt(s.botCell)}, ${s.cells.length} mob cell(s), tag ${s.tag}${kept ? ' (from the arena book)' : ''}.`);
    }
    await rcon.command(`tp ${SCOUT_NAME} ${a.origin.x} 200 ${a.origin.z}`);
    if (!arenas.length) { log('done', 'no arena could be sited — nothing fought.'); return 2; }

    // ── STAGE EVERY BODY, THEN WAIT FOR EVERY WATCH ──
    const ready = [];
    for (const ar of arenas) {
      const st = await stage(rcon, a, ar);
      if (st.ok) ready.push(ar); else { log('stage', `${ar.bot} not staged — ${st.why}.`); exit = 2; }
    }
    const standing = [];
    for (const ar of ready) {
      const w = await lanista.awaitStandingWatch(ar.bot);
      if (w.ok) standing.push(ar); else { log('stage', `${ar.bot} — ${w.reason}`); exit = 2; }
    }
    for (const ar of standing) {
      await lanista.purgeAmbientHostiles(rcon, ar.botCell);
      await rcon.command(`scoreboard players set ${ar.bot} ${lanista.DEATH_OBJECTIVE} 0`);
    }
    // ── EVERY WAVE AT ONCE, EVERY FIGHT WATCHED TOGETHER ──
    for (const ar of standing) await summonWave(rcon, a, ar);
    const all = await Promise.all(standing.map((ar) => watchFight(rcon, a, ar)));
    for (const ar of standing) await lanista.clearArena(rcon, ar.tag);
    for (const r of all) {
      log('fight', `${r.bot}: ${r.outcome.toUpperCase()} in ${(r.ms / 1000).toFixed(1)}s · low hp ${r.minHp} · end hp ${r.hpEnd} · mobs ${r.mobsStart}→${r.mobsEnd}`);
    }

    const by = (o) => all.filter((r) => r.outcome === o).length;
    log('verdict', `${all.length} fight(s) vs ${lanista.waveLabel(a.wave)}${a.terminator ? ` as ${a.terminator} terminators` : ''}: `
      + `${by('cleared')} cleared · ${by('unreached')} alive with a mob that never came · ${by('died')} died · ${by('timeout')} timed out.`);
    log('done', 'Why each went that way: node Auren_Bot/monitoring/trace_monitor.js --fight-record --fight=<name>:1');
    return exit;
  } catch (e) {
    console.error(`colosseum failed: ${e.stack || e.message}`);
    return 1;
  } finally {
    const was = /true/.test(griefBefore) ? 'true' : /false/.test(griefBefore) ? 'false' : null;
    if (was) { try { await rcon.command(`gamerule mob_griefing ${was}`); } catch (_) { /* the link is going down with the bench */ } }
    await link.close();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs };
