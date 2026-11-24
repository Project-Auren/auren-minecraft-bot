'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/base_scatter_bench.js');
// tool: base_scatter_bench — sites the crew's base on every saved snapshot, with no server, the way the foreman's
// survey does: the headframe from where the body stands, the bot hive nearest it, each support on its own ground, then
// the lights where the difficulty lights the base.
//
// Drives the REAL survey (lock_all_buildspots.run, dry) over every snapshot voxel_snapshot_store holds, from the person
// spot each snapshot was captured on and, with --around, from eight more origins that far from it (N, NE, E, SE, S, SW,
// W, NW). Prints the survey's own report line by line, then one row per snapshot and origin: whether the layout sited,
// the refusal when not, the headframe-to-hive gap (footprint edge to edge), the base's extent (the box round every
// footprint) and, for a lit base, its torch posts (base_layout.paintLights). A last line counts the origins that sited.
//
// Usage (developer mode, no server):
//   node Auren_Workshop/tools/base_scatter_bench.js [--around=<blocks>] [--snap=<name>,<name>] [--quiet]
// The difficulty is the run page's (AUREN_DIFFICULTY); set it to site a peaceful base, which lights nothing.

const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'base_scatter_bench';
const moduleHomes = require('@utils/node_module_homes');
for (const d of moduleHomes.bootstrapModulePath()) module.paths.unshift(d);

const store = require('./voxel_snapshot_store');

const args = process.argv.slice(2);
const valueOf = (k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const say = m => console.log(m);

// The eight compass steps --around adds to each snapshot's person spot.
const COMPASS = [['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1], ['S', 0, 1], ['SW', -1, 1], ['W', -1, 0], ['NW', -1, -1]];

async function main() {
  const cfg = require('@thinking/architect_config');
  const around = valueOf('around') === null ? 0 : Number(valueOf('around'));
  if (!Number.isInteger(around) || around < 0) { say(`base_scatter_bench: --around is a whole number of blocks, got '${valueOf('around')}'.`); return 1; }
  const only = valueOf('snap') ? valueOf('snap').split(',') : null;
  const snaps = store.listSnapshots().filter(s => !only || only.includes(s.name) || only.includes(s.header.label));
  if (!snaps.length) { say(`base_scatter_bench: no snapshots${only ? ` named ${only.join(', ')}` : ''} in ${store.SNAPSHOT_DIR} — capture some with voxel_snapshot.js capture.`); return 1; }
  const lock = require('../../action_fragments.js/lock_all_buildspots');
  const rows = [];
  for (const snap of snaps) {
    const bot = store.loadSnapshot(snap.name);
    global.bot = bot;
    const p = bot.snapshot.person || bot.snapshot.body;
    const person = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const name = snap.header.label || snap.name;
    const origins = [{ tag: 'person', at: person }, ...(around > 0 ? COMPASS.map(([tag, dx, dz]) => ({ tag, at: { x: person.x + dx * around, y: person.y, z: person.z + dz * around } })) : [])];
    for (const { tag, at } of origins) {
      bot.entity = { position: at };
      const t0 = Date.now();
      const r = await lock.run(bot, { dryRun: true, origin: at, unlockedWorld: true });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const pad = r.ok ? (r.site || []).find(row => row.candidate.lights) : null;
      const boxes = r.ok ? r.layout.footprints.map(f => f.box) : [];
      const extent = boxes.length ? {
        x: Math.max(...boxes.map(b => b.maxX)) - Math.min(...boxes.map(b => b.minX)) + 1,
        z: Math.max(...boxes.map(b => b.maxZ)) - Math.min(...boxes.map(b => b.minZ)) + 1,
      } : null;
      const why = r.ok ? '' : r.transient ? 'world not loaded' : (r.problems || []).join(' | ');
      rows.push({ snap: name, tag, at, ok: r.ok, why, gap: r.ok ? r.layout.hiveGap : null, extent, posts: pad ? pad.candidate.lights.posts.length : null, secs });
      say(`${name} ${tag} (${at.x},${at.z}) on ${cfg.CREW_DIFFICULTY}: ${r.ok ? 'SITED' : 'NOT SITED'} in ${secs}s${r.ok ? '' : ` · ${why}`}`);
      if (!args.includes('--quiet')) for (const line of r.report || []) say(`    ${line.split('\n')[0]}`);
    }
  }
  say('');
  say('snapshot              origin  sited  hive gap  extent    posts  refusal');
  for (const r of rows) {
    say(`${r.snap.padEnd(21)} ${r.tag.padEnd(7)} ${(r.ok ? 'yes' : 'no').padEnd(6)} ${(r.gap === null ? '-' : r.gap.toFixed(1)).padEnd(9)} `
      + `${(r.extent ? `${r.extent.x}x${r.extent.z}` : '-').padEnd(9)} ${String(r.posts ?? '-').padEnd(6)} ${r.why}`);
  }
  say('');
  say(`sited ${rows.filter(r => r.ok).length} of ${rows.length} origin(s) over ${snaps.length} snapshot(s) on ${cfg.CREW_DIFFICULTY}.`);
  return 0;
}

main().then(code => process.exit(code), (e) => { console.error(e); process.exit(1); });
