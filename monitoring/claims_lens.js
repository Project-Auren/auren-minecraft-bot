// Auren_Bot/monitoring/claims_lens.js
// --claims: the record claims standing in a record folder (js_kernel/utils/record_claims): every writer's
// `.writing` mark and every reader's `.reading.<pid>` mark, its record, and its age against STALE_MS. A
// mark is a file's NAME and modification time; no record is read. This answers why a read or an archive
// (Cutting_room/recorder: the take's wrap) refused a record as "an append still in flight".
// Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --claims [--records=<dir>]

'use strict';

const fs = require('fs');
const path = require('path');
const out = require('./data_out');
const lensPaths = require('./lens_paths');

const MARK_RE = /^(.*)\.(writing|reading\.(\d+))$/;

// reduceClaims(root, now) → [{ record, kind, pid, age_s, stale }] for every mark under root.
function reduceClaims(root, now = Date.now()) {
  const { STALE_MS } = require(lensPaths.bot('js_kernel/utils/record_claims'));
  const marks = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = MARK_RE.exec(e.name);
      if (!m) continue;
      const age = now - fs.statSync(p).mtimeMs;
      marks.push({
        record: path.relative(root, path.join(dir, m[1])).split(path.sep).join('/'),
        kind: m[2] === 'writing' ? 'writer' : 'reader', pid: m[3] || null,
        age_s: Math.round(age / 1000), stale: age >= STALE_MS,
      });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return marks.sort((a, b) => a.record.localeCompare(b.record));
}

function runClaims({ root } = {}) {
  const marks = reduceClaims(root);
  out.kv('lens', 'claims');
  out.kv('records', root);
  out.section('claims');
  out.kv('marks', marks.length);
  out.kv('writer_marks', marks.filter(m => m.kind === 'writer').length);
  out.kv('reader_marks', marks.filter(m => m.kind === 'reader').length);
  out.kv('stale_marks', marks.filter(m => m.stale).length);
  out.section('marks');
  out.table(['record', 'kind', 'pid', 'age_s', 'stale'], marks.map(m => [m.record, m.kind, m.pid || '—', m.age_s, m.stale]));
  return marks;
}

module.exports = { reduceClaims, runClaims };
