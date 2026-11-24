// Auren_Bot/monitoring/keeper_structures_lens.js
// --keeper-structures: the integrity keeper's last structures verdict (foreman/integrity_keeper_worker readStructures),
// kept in the records as integrity_keeper_structures.json: per sited structure, held or not, built or not, and every
// step of its diff (blueprint_survey.scanBuilding: place or dig, the cell, the block wanted, the block standing, why).
// The file is a window (integrity_keeper keepOnDisk), so this is the keeper's reading as the run left it.
// Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --keeper-structures [--build=<name>] [--records=<dir>]

'use strict';

const fs = require('fs');
const path = require('path');
const out = require('./data_out');
const { readUnderClaim } = require('./record_read');

function runKeeperStructures({ root, build = null } = {}) {
  const file = path.join(root, 'integrity_keeper_structures.json');
  out.kv('lens', 'keeper_structures');
  out.kv('record', file);
  if (!fs.existsSync(file)) { out.kv('found', false); return null; }
  const v = readUnderClaim(file, () => JSON.parse(fs.readFileSync(file, 'utf8')));
  out.kv('found', true);
  out.kv('generated_at', v.generated_at || null);
  const rows = Object.entries(v.structures || {}).filter(([k, r]) => !build || k.startsWith(build) || r.blueprint === build);
  out.section('structures');
  out.table(['structure', 'blueprint', 'held', 'built', 'steps'],
    rows.map(([k, r]) => [k, r.blueprint, r.held, r.held ? r.all_complete : null, (r.steps || []).length]));
  for (const [k, r] of rows) {
    if (!r.steps || !r.steps.length) continue;
    out.section(`steps_${String(r.blueprint).toLowerCase().replace(/[^a-z0-9_.]/g, "_")}`);
    out.table(['action', 'cell', 'wanted', 'standing', 'reason', 'state'],
      r.steps.map(s => [s.action, s.place ? `${s.place.x},${s.place.y},${s.place.z}` : '—',
        s.action === 'place' ? s.type : (s.wanted || 'air'), s.action === 'place' ? (s.actual || '—') : s.type, s.reason || '—',
        s.state ? JSON.stringify(s.state) : '—']));
  }
  return v;
}

module.exports = { runKeeperStructures };
