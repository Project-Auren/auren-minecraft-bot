// What the fleet remembers about one world, on disk, in one statement (Law 16). A rollback start empties it
// (foreman_plan.emptyMemory); a save point copies it beside a world snapshot and puts it back with that world
// (Auren_Workshop/fleet_control.js `snapshot --memory`, `restore`). World and memory are one decision: the
// headquarters files hold cells of one particular world, so a world restored without its memory, or memory
// laid over another world, leaves bodies acting on terrain that is not there.
//
//   headquarters   js_kernel/corporate_headquarters.<bot>.json, each body's own record (sites, stations, chests)
//   crew memory    player_memory/, the hub's per-crew store (foreman/crew_memory)

'use strict';

const fs = require('fs');
const path = require('path');

const BOT_DIR = path.join(__dirname, '..');
const KERNEL = path.join(BOT_DIR, 'js_kernel');
const HQ_FILE = /^corporate_headquarters\..*\.json$/;
const CREW_MEMORY = path.join(BOT_DIR, 'player_memory');

// parts() → [{ name, abs }]: every piece of memory present on disk now, by the name a save point stores it under.
function parts() {
  const hq = fs.existsSync(KERNEL) ? fs.readdirSync(KERNEL).filter(f => HQ_FILE.test(f)) : [];
  return [
    ...hq.map(f => ({ name: f, abs: path.join(KERNEL, f) })),
    ...[CREW_MEMORY].filter(p => fs.existsSync(p)).map(p => ({ name: path.basename(p), abs: p })),
  ];
}
// home(name) → where a piece of that name lives in this bot folder, or null for a name that is not memory.
function home(name) {
  if (HQ_FILE.test(name)) return path.join(KERNEL, name);
  if (name === path.basename(CREW_MEMORY)) return CREW_MEMORY;
  return null;
}
// empty() → how many headquarters files went; the rest of memory goes with them.
function empty() {
  const all = parts();
  for (const p of all) fs.rmSync(p.abs, { recursive: true, force: true });
  return all.filter(p => HQ_FILE.test(p.name)).length;
}
// save(dir) → names copied into dir, which must not exist yet.
function save(dir) {
  if (fs.existsSync(dir)) throw new Error(`[fleet_memory] CODING VIOLATION (Law 13): ${dir} already holds a memory copy; a save point is never overwritten.`);
  fs.mkdirSync(dir, { recursive: true });
  const all = parts();
  for (const p of all) fs.cpSync(p.abs, path.join(dir, p.name), { recursive: true });
  return all.map(p => p.name);
}
// restore(dir) → names laid back. The memory on disk now is emptied first, so nothing of the last run survives.
function restore(dir) {
  if (!fs.existsSync(dir)) throw new Error(`[fleet_memory] CODING VIOLATION (Law 13): no memory copy at ${dir}.`);
  const names = fs.readdirSync(dir);
  const strangers = names.filter(n => !home(n));
  if (strangers.length) throw new Error(`[fleet_memory] CODING VIOLATION (Law 13): ${dir} holds ${strangers.join(', ')}, which is not fleet memory.`);
  empty();
  for (const n of names) fs.cpSync(path.join(dir, n), home(n), { recursive: true });
  return names;
}

module.exports = { parts, empty, save, restore, HQ_FILE };
