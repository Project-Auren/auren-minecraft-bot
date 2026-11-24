// Auren_Bot/monitoring/threat_board_lens.js
// --threats: the foreman's threat board over a run — every threat and call put on it, why each came off, the most on it at
// once, what the T-1s took and finished, and the T-1s' own target lines. Reads the foreman's THREAT_* lines
// (foreman/threat_board.js, from the foreman's own record) and the bodies' T_TARGET, T_TARGET_LEG and T_TARGET_DONE lines (terminator_planner).
// Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --threats [--all]

'use strict';

const out = require('./data_out');

const ON_RE = /THREAT_ON key=(\S+) source=(\S+) mob=(\S+?)#\d+/;
const OFF_RE = /THREAT_OFF key=(\S+) source=(\S+) mob=\S+ why=(.+?) on_s=(\d+)/;
const TAKEN_RE = /THREAT_TAKEN t1=(\S+) key=(\S+)/;
const FINISHED_RE = /THREAT_FINISHED t1=(\S+) key=(\S+) why=(\S+)/;
const T_TAKE_RE = /\bT_TARGET source=(\S+) target=(\S+) d=([\d.]+) board=(\d+)/;
const T_DONE_RE = /\bT_TARGET_DONE source=(\S+) target=(\S+) why=(\S+) legs=(\d+) held_s=(\d+)/;

const ROWS = 20;
const min = (sec) => (Number.isFinite(sec) ? +(sec / 60).toFixed(1) : null);
const count = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };

function reduceThreats({ seg = [], foreman = [] } = {}) {
  // The board's own lines are the foreman's (its record, not the trace): this run's span only, timed from the run's start.
  const from = seg.reduce((lo, l) => (l.atMs && l.atMs < lo ? l.atMs : lo), seg.length ? Infinity : -Infinity);
  const lines = [
    ...foreman.filter((l) => !l.atMs || l.atMs >= from).map((l) => ({ raw: l.raw, bot: null, atMs: l.atMs, relSec: l.atMs && Number.isFinite(from) ? (l.atMs - from) / 1000 : null })),
    ...seg,
  ].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  const on = new Map();          // key → row
  const rows = [];
  const taken = [];
  const finished = [];
  const t1Takes = [];
  const t1Dones = [];
  let live = 0, most = 0;
  const seen = new Set();
  for (const l of lines) {
    const raw = l.raw || '';
    if (!raw.includes('THREAT_') && !raw.includes('T_TARGET')) continue;
    const dedupe = `${l.bot || ''}|${raw}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const t = l.relSec;
    let m;
    if ((m = ON_RE.exec(raw))) {
      const r = { key: m[1], source: m[2], mob: m[3], at: t, off: null, why: null, onS: null };
      if (!on.has(m[1])) { live++; most = Math.max(most, live); }
      on.set(m[1], r);
      rows.push(r);
    } else if ((m = OFF_RE.exec(raw))) {
      const r = on.get(m[1]);
      if (r) { r.off = t; r.why = m[3].split(':')[0]; r.onS = +m[4]; on.delete(m[1]); live--; }
    } else if ((m = TAKEN_RE.exec(raw))) {
      taken.push({ t1: m[1], key: m[2], at: t });
    } else if ((m = FINISHED_RE.exec(raw))) {
      finished.push({ t1: m[1], key: m[2], why: m[3].split(':')[0], at: t });
    } else if (l.bot && (m = T_TAKE_RE.exec(raw))) {
      t1Takes.push({ bot: l.bot, source: m[1], target: m[2], d: +m[3], board: +m[4], at: t });
    } else if (l.bot && (m = T_DONE_RE.exec(raw))) {
      t1Dones.push({ bot: l.bot, source: m[1], target: m[2], why: m[3].split(':')[0], legs: +m[4], heldS: +m[5], at: t });
    }
  }
  return { rows, taken, finished, t1Takes, t1Dones, most, stillOn: on.size };
}

function runThreats({ seg = [], foreman = [], traceName = '?', verbose = false } = {}) {
  const r = reduceThreats({ seg, foreman });
  const rows = (xs) => (verbose ? xs : xs.slice(0, ROWS));
  out.kv('lens', 'threat_board');
  out.kv('record', traceName);

  out.section('board');
  out.kv('put_on', r.rows.length);
  out.kv('threats', r.rows.filter((x) => x.source === 'threat').length);
  out.kv('calls', r.rows.filter((x) => x.source === 'called').length);
  out.kv('most_on_at_once', r.most);
  out.kv('still_on_at_the_end', r.stillOn);
  out.kv('taken_by_t1', r.taken.length);
  out.kv('finished_by_t1', r.finished.length);

  out.section('by_mob');
  out.table(['mob', 'count'], count(r.rows, (x) => x.mob));

  out.section('off_why');
  out.table(['why', 'count'], count(r.rows.filter((x) => x.why), (x) => x.why));

  out.section('t1_finished_why');
  out.table(['why', 'count'], count(r.t1Dones, (x) => x.why));

  out.section('each_entry');
  out.table(['at_min', 'key', 'source', 'mob', 'off_min', 'why', 'on_s'],
    rows(r.rows).map((x) => [min(x.at), x.key, x.source, x.mob, min(x.off), x.why, x.onS]));

  out.section('each_t1_target');
  out.table(['at_min', 'bot', 'source', 'target', 'd', 'board'], rows(r.t1Takes).map((x) => [min(x.at), x.bot, x.source, x.target, x.d, x.board]));

  out.section('each_t1_finish');
  out.table(['at_min', 'bot', 'source', 'target', 'why', 'legs', 'held_s'], rows(r.t1Dones).map((x) => [min(x.at), x.bot, x.source, x.target, x.why, x.legs, x.heldS]));
}

module.exports = { reduceThreats, runThreats };
