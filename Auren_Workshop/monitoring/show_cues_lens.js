// show_cues_lens — reads the show-cue journal lanista writes during an emperor's show and lays out the crowd's sound
// against the take: when each wave starts, each gate opens, each battle ends, each banner goes up, and the end.
//
// THE PAIRING RULE: the record is `show_cues/show_<start>.jsonl` under the run's records, one row per cue, written only
// by lanista (openShowCues, showCue); nothing else opens it. A person asks `trace_monitor --show-cues`; a caller that
// wants the sheet as data calls `reduceShowCues()`.
//
// THE CROWD'S SOUND, in two layers:
//   the LEVEL under everything   `dull` while no battle is on (the show's opening, staging, between rounds); `medium` from
//                                a round's first gate to its battle's end. The general bed sits under both, always.
//   the MOMENTS over it          `wave_start` at a release; `roar_to_medium` at each gate opening (a loud roar falling to
//                                the battle's medium); `roar` on green banners, `boo` on red, whoever raised them;
//                                `giant_roar` when the champion has passed every round. The TNT and the fall are marked as
//                                `tnt` and `fall`; their sound is his to choose.
// Not per monster: a kill is not a cue.
//
// TIMES ARE FROM THE TAKE. A take runs from the board's Start recording to its Stop recording, so each time lines up
// with that take's footage. A show with no recording is one take from the show's opening, and `origin` says so.

'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('../workshop_paths');
const out = require(paths.bot('monitoring/data_out'));

// This fleet's records, or another's under trace_monitor's --records=<dir> (record_homes reads it).
const RECORD_DIR = path.join(require(paths.bot('js_kernel/utils/record_homes')).RECORDS_DIR, 'show_cues');

// What each cue means for the crowd: the moment over the level (or null), and the level it leaves behind (or null).
const SOUND = {
  show_open: { moment: null, level: 'dull' },
  release: { moment: 'wave_start', level: null },
  gate_open: { moment: 'roar_to_medium', level: 'medium' },
  battle_end: { moment: null, level: 'dull' },
  champion: { moment: 'giant_roar', level: null },
  fallen: { moment: 'fall', level: null },
  tnt: { moment: 'tnt', level: null },
  banner_lower: { moment: null, level: null },
  dismissed: { moment: null, level: null },
  shutdown: { moment: null, level: null },
};
const bannerSound = (row) => (row.kind === 'up' ? 'roar' : row.kind === 'down' ? 'boo' : null);

function listShows() {
  try {
    return fs.readdirSync(RECORD_DIR).filter(f => /^show_.*\.jsonl$/.test(f)).sort();
  } catch (e) { return []; }
}

function readRows(file) {
  const rows = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return rows; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // A torn final row (the show was killed mid-append) is skipped, never patched.
    try { rows.push(JSON.parse(line)); } catch (e) { /* torn row */ }
  }
  return rows.filter(r => Number.isFinite(r.t) && typeof r.cue === 'string');
}

// clock(ms) → m:ss.s
function clock(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

// takes(rows) → [{ origin, from, to, rows }]: one per Start recording … Stop recording, or the whole show when none.
function takes(rows) {
  const found = [];
  let open = null;
  for (const r of rows) {
    if (r.cue === 'recording_start') open = { origin: 'recording_start', from: r.t, to: null };
    else if (r.cue === 'recording_stop' && open) { open.to = r.t; found.push(open); open = null; }
  }
  if (open) found.push(open);
  if (!found.length && rows.length) found.push({ origin: 'show_open', from: rows[0].t, to: null });
  return found.map(k => ({ ...k, rows: rows.filter(r => r.t >= k.from && (k.to === null || r.t <= k.to)) }));
}

// The level standing when a take begins: the last level any earlier cue left.
function levelBefore(rows, t) {
  let level = null;
  for (const r of rows) {
    if (r.t >= t) break;
    const s = SOUND[r.cue];
    if (s && s.level) level = s.level;
  }
  return level || 'dull';
}

// sheet(rows, take) → { cues, levels }
function sheet(rows, take) {
  const cues = [];
  const levels = [];
  let level = levelBefore(rows, take.from);
  let since = take.from;
  for (const r of take.rows) {
    if (r.cue === 'recording_start' || r.cue === 'recording_stop') continue;
    const s = SOUND[r.cue] || { moment: null, level: null };
    const moment = r.cue === 'banner' ? bannerSound(r) : s.moment;
    if (moment) {
      cues.push({ at: clock(r.t - take.from), cue: r.cue, round: r.round ?? null,
        detail: r.gate || (r.kind ? `${r.kind}_${r.by || ''}`.replace(/_$/, '') : null), crowd: moment });
    }
    if (s.level && s.level !== level) {
      levels.push({ from: clock(since - take.from), to: clock(r.t - take.from), level });
      level = s.level;
      since = r.t;
    }
  }
  const end = take.to ?? (take.rows.length ? take.rows[take.rows.length - 1].t : take.from);
  levels.push({ from: clock(since - take.from), to: clock(end - take.from), level });
  return { cues, levels, length: clock(end - take.from) };
}

// ── The machine-facing lens: returns, prints nothing, never exits ────────────────────────────────────
function reduceShowCues({ show = null } = {}) {
  const shows = listShows();
  const name = show ? shows.find(f => f.includes(show)) : shows[shows.length - 1];
  if (!name) return { found: false, shows, dir: RECORD_DIR };
  const file = path.join(RECORD_DIR, name);
  const rows = readRows(file);
  return { found: true, file, show: name, rows: rows.length, shows, takes: takes(rows).map(k => ({ origin: k.origin, ...sheet(rows, k) })) };
}

// ── The person-facing lens: field names and values (data_out) ────────────────────────────────────────
function runShowCues({ show = null, json = false } = {}) {
  const r = reduceShowCues({ show });
  if (json) { out.json(r); return r; }
  out.section('show_cues');
  if (!r.found) {
    out.kv('found', false);
    out.kv('dir', r.dir);
    out.list('shows', r.shows);
    return r;
  }
  out.kv('show', r.show);
  out.kv('rows', r.rows);
  out.kv('takes', r.takes.length);
  out.list('shows_on_disk', r.shows);
  r.takes.forEach((k, i) => {
    out.section(`take_${i + 1}`);
    out.kv('origin', k.origin);
    out.kv('length', k.length);
    out.section(`take_${i + 1}.moments`);
    out.table(['at', 'crowd', 'cue', 'round', 'detail'], k.cues.map(c => [c.at, c.crowd, c.cue, c.round, c.detail]));
    out.section(`take_${i + 1}.level`);
    out.table(['from', 'to', 'level'], k.levels.map(l => [l.from, l.to, l.level]));
  });
  return r;
}

module.exports = { reduceShowCues, runShowCues, listShows, RECORD_DIR, SOUND };
