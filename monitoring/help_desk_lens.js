// Auren_Bot/monitoring/help_desk_lens.js
// --help: the help desk over a run — every call a running body handed the foreman, every body the request was given to and
// what it answered (reason, answer time, silence, pull), which body became the T-2, the T-1s summoned to it and whether one
// arrived and relieved the T-2, and each T-2's chase: the job it left, its legs, the legs that did not move it, and how the
// termination ended. Also every Law 13 violation line.
// Reads the foreman's HELP_* lines (foreman/help_desk.js) and the bodies' help_line, battle_stations TERMINATOR_CALL and
// terminator_executor lines. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --help-desk [--bot=B] [--all]

'use strict';

const out = require('./data_out');

// The foreman's walk (foreman/help_desk.js).
const F_CALL_RE = /HELP_CALL call=(\d+) mob=(\S+) caller=(\S+) why=(\S+)(?: t1=(\S+))? ask_order=(\S*)/;
const F_SUMMON_RE = /HELP_BOARD call=(\d+) mob=\S+ t1=(\S+)/;
const F_RELIEVED_RE = /HELP_RELIEVED call=(\d+) mob=\S+ t1=(\S+) t2=(\S+) held_ms=(\d+)/;
const F_ASK_RE = /HELP_ASK call=(\d+) mob=\S+ bot=(\S+) ask=(\d+)/;
const F_PULL_RE = /HELP_PULL call=(\d+) mob=\S+ bot=(\S+)/;
const F_SILENT_RE = /HELP_SILENT call=(\d+) mob=\S+ bot=(\S+)/;
const F_DECLINE_RE = /HELP_DECLINE call=(\d+) mob=\S+ bot=(\S+) answer_ms=(\d+) reason=(.+?)( \(answer crossed the pull\))?$/;
const F_ASSIGN_RE = /HELP_ASSIGN call=(\d+) mob=\S+ terminator=(\S+)(?: role=\S+ t1=\S+)? caller=\S+ answer_ms=(\d+)( \(answer crossed the pull\))?/;
const F_NONE_RE = /HELP_NONE call=(\d+)/;
const F_NO_REASON_RE = /HELP_REPLY_NO_REASON call=(\d+) from=(\S+)/;
// The bodies (custom_api/help_line.js, battle_stations, terminator_executor).
const B_CALL_RE = /HELP_CALL mob=(\S+) why=(\S+) ranked=(\S*)/;
const B_QUESTION_RE = /HELP_QUESTION call=(\d+)/;
const B_ASKED_RE = /HELP_ASKED call=(\d+) mob=\S+ for=\S+ answer=(.+)$/;
const B_WITHDRAWN_RE = /HELP_WITHDRAWN call=(\d+)/;
const B_TERMINATOR_RE = /\bTERMINATOR (?:role=\S+ )?mob=(\S+) for=(\S+)/;
const B_JOB_LEFT_RE = /TERMINATOR_CALL job=(\S+) mob=(\S+) for=(\S+) source=(\S+)/;
const B_LEG_RE = /\bLEG n=(\d+) mob=(\S+) for=\S+ d=([\d.]+) seen=(\S+) exact=(\S+) to=\S+ steps=\d+ still_s=(\d+)/;
const B_STILL_RE = /LEG_STILL n=\d+ mob=(\S+) moved=([\d.]+) arrived=(\S+) reason=(\S+) still_s=(\d+)/;
const B_TRACK_END_RE = /TRACK_END mob=(\S+) result=(\S+) legs=(\d+)/;
const B_END_RE = /TERMINATOR_END mob=(\S+) why=(\S+)/;
const LAW13_RE = /LAW 13 VIOLATION: (.+)$/;

const ROWS = 15;
const min = (sec) => (Number.isFinite(sec) ? +(sec / 60).toFixed(1) : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);

function reduceHelpDesk({ seg = [], bot = null } = {}) {
  const calls = new Map();       // call id → the foreman's walk
  const chases = [];             // one per assignment a body took
  const open = new Map();        // bot → its chase in progress
  const bodies = new Map();      // bot → { called, questions, answered, withdrawn }
  const violations = [];
  const noReason = [];
  const seen = new Set();
  const B = (name) => {
    if (!bodies.has(name)) bodies.set(name, { called: 0, questions: 0, answered: 0, yes: 0, withdrawn: 0 });
    return bodies.get(name);
  };
  const C = (id) => calls.get(+id);
  for (const l of seg) {
    const raw = l.raw || '';
    if (!raw.includes('HELP_') && !raw.includes('TERMINATOR') && !raw.includes('LEG') && !raw.includes('TRACK_END') && !LAW13_RE.test(raw)) continue;
    const key = `${l.bot || ''}|${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = l.relSec;
    let m;
    if ((m = F_CALL_RE.exec(raw))) {
      calls.set(+m[1], { call: +m[1], at: t, mob: m[2], caller: m[3], why: m[4], t1s: m[5] && m[5] !== 'none' ? m[5].split('+') : [], order: m[6] ? m[6].split(',') : [], asks: [], declines: [], silences: 0, pulls: 0, outcome: 'open', terminator: null, answerMs: null, crossed: false, summoned: 0, relievedBy: null, heldMs: null });
    } else if ((m = F_SUMMON_RE.exec(raw))) {
      const c = C(m[1]); if (c) c.summoned++;
    } else if ((m = F_RELIEVED_RE.exec(raw))) {
      const c = C(m[1]); if (c) { c.relievedBy = m[2]; c.heldMs = +m[4]; }
    } else if ((m = F_ASK_RE.exec(raw))) {
      const c = C(m[1]); if (c) c.asks.push(m[2]);
    } else if ((m = F_PULL_RE.exec(raw))) {
      const c = C(m[1]); if (c) c.pulls++;
    } else if ((m = F_SILENT_RE.exec(raw))) {
      const c = C(m[1]); if (c) c.silences++;
    } else if ((m = F_DECLINE_RE.exec(raw))) {
      const c = C(m[1]); if (c) c.declines.push({ bot: m[2], ms: +m[3], reason: m[4], crossed: !!m[5] });
    } else if ((m = F_ASSIGN_RE.exec(raw))) {
      const c = C(m[1]); if (c) { c.outcome = 'terminator'; c.terminator = m[2]; c.answerMs = +m[3]; c.crossed = !!m[4]; c.endAt = t; }
    } else if ((m = F_NONE_RE.exec(raw))) {
      const c = C(m[1]); if (c) { c.outcome = 'none'; c.endAt = t; }
    } else if ((m = F_NO_REASON_RE.exec(raw))) {
      noReason.push({ call: +m[1], bot: m[2], at: t });
    } else if ((m = LAW13_RE.exec(raw))) {
      violations.push({ at: t, bot: l.bot || 'foreman', what: m[1] });
    } else if (!l.bot) {
      continue;
    } else if ((m = B_CALL_RE.exec(raw))) {
      B(l.bot).called++;
    } else if ((m = B_QUESTION_RE.exec(raw))) {
      B(l.bot).questions++;
    } else if ((m = B_ASKED_RE.exec(raw))) {
      const b = B(l.bot); b.answered++; if (m[2] === 'available') b.yes++;
    } else if ((m = B_WITHDRAWN_RE.exec(raw))) {
      B(l.bot).withdrawn++;
    } else if ((m = B_TERMINATOR_RE.exec(raw))) {
      const ch = { bot: l.bot, mob: m[1], for: m[2], at: t, jobLeft: null, enteredAt: null, entries: 0, legs: 0, stillLegs: 0, maxStillS: 0, exactLegs: 0, unseenLegs: 0, firstD: null, lastD: null, trackEnds: [], end: null, endAt: null };
      chases.push(ch);
      open.set(l.bot, ch);
    } else if ((m = B_JOB_LEFT_RE.exec(raw))) {
      const ch = open.get(l.bot); if (ch) { ch.entries++; if (ch.jobLeft === null) { ch.jobLeft = m[1]; ch.enteredAt = t; } }
    } else if ((m = B_LEG_RE.exec(raw))) {
      const ch = open.get(l.bot);
      if (ch) {
        ch.legs++;
        if (ch.firstD === null) ch.firstD = +m[3];
        ch.lastD = +m[3];
        if (m[4] !== 'true') ch.unseenLegs++;
        if (m[5] === 'true') ch.exactLegs++;
        ch.maxStillS = Math.max(ch.maxStillS, +m[6]);
      }
    } else if ((m = B_STILL_RE.exec(raw))) {
      const ch = open.get(l.bot); if (ch) { ch.stillLegs++; ch.maxStillS = Math.max(ch.maxStillS, +m[5]); }
    } else if ((m = B_TRACK_END_RE.exec(raw))) {
      const ch = open.get(l.bot); if (ch) ch.trackEnds.push(m[2]);
    } else if ((m = B_END_RE.exec(raw))) {
      const ch = open.get(l.bot); if (ch) { ch.end = m[2]; ch.endAt = t; open.delete(l.bot); }
    }
  }
  const keep = (name) => !bot || name === bot;
  return {
    calls: [...calls.values()].filter((c) => keep(c.caller) || keep(c.terminator) || c.asks.some(keep)),
    chases: chases.filter((c) => keep(c.bot)),
    bodies: [...bodies].filter(([name]) => keep(name)).map(([name, b]) => ({ bot: name, ...b })),
    violations, noReason,
  };
}

function runHelpDesk({ seg = [], traceName = '?', bot = null, verbose = false } = {}) {
  const r = reduceHelpDesk({ seg, bot });
  const declines = r.calls.flatMap((c) => c.declines);
  const answerMs = [...declines.map((d) => d.ms), ...r.calls.filter((c) => c.answerMs !== null).map((c) => c.answerMs)];
  const rows = (xs) => (verbose ? xs : xs.slice(0, ROWS));

  out.kv('lens', 'help_desk');
  out.kv('record', traceName);
  if (bot) out.kv('bot', bot);

  out.section('calls');
  out.kv('calls', r.calls.length);
  out.kv('terminator_picked', r.calls.filter((c) => c.outcome === 'terminator').length);
  out.kv('no_terminator', r.calls.filter((c) => c.outcome === 'none').length);
  out.kv('still_walking_at_the_end', r.calls.filter((c) => c.outcome === 'open').length);
  out.kv('requests_given', r.calls.reduce((s, c) => s + c.asks.length, 0));
  out.kv('declines', declines.length);
  out.kv('silences', r.calls.reduce((s, c) => s + c.silences, 0));
  out.kv('pulls', r.calls.reduce((s, c) => s + c.pulls, 0));
  out.kv('answers_crossing_a_pull', declines.filter((d) => d.crossed).length + r.calls.filter((c) => c.crossed).length);
  out.kv('refusals_without_reason', r.noReason.length);
  out.kv('answer_ms_avg', avg(answerMs));
  out.kv('answer_ms_max', max(answerMs));
  out.kv('calls_put_on_threat_board', r.calls.reduce((s, c) => s + c.summoned, 0));
  out.kv('t2_relieved_by_t1', r.calls.filter((c) => c.relievedBy).length);
  out.kv('t2_held_ms_avg', avg(r.calls.filter((c) => c.heldMs !== null).map((c) => c.heldMs)));
  out.kv('pick_s_avg', avg(r.calls.filter((c) => c.outcome === 'terminator').map((c) => Math.round(c.endAt - c.at))));
  out.kv('law_13_violations', r.violations.length);

  out.section('decline_reasons');
  const reasons = new Map();
  for (const d of declines) { const k = d.reason.replace(/[#\d.,()]+/g, '').replace(/\s+of\s+\S*$/, '').trim(); reasons.set(k, (reasons.get(k) || 0) + 1); }
  out.table(['reason', 'count'], [...reasons].sort((a, b) => b[1] - a[1]));

  out.section('each_call');
  out.table(['call', 'at_min', 'mob', 'caller', 'why', 'outcome', 't2', 't1', 'relieved_by', 'given_to', 'declines', 'silences', 'answer_ms', 'pick_s'],
    rows(r.calls).map((c) => [c.call, min(c.at), c.mob, c.caller, c.why, c.outcome, c.terminator, c.t1s.join('+') || null, c.relievedBy, c.asks.join('>') || null, c.declines.length, c.silences,
      c.answerMs, Number.isFinite(c.endAt) ? Math.round(c.endAt - c.at) : null]));

  out.section('each_answer');
  out.table(['call', 'bot', 'answer_ms', 'reason', 'crossed_pull'],
    rows(r.calls.flatMap((c) => c.declines.map((d) => [c.call, d.bot, d.ms, d.reason, d.crossed]))));

  out.section('terminators');
  out.kv('assignments', r.chases.length);
  out.kv('killed', r.chases.filter((c) => c.end === 'killed').length);
  out.kv('lost', r.chases.filter((c) => c.end === 'lost').length);
  out.kv('ran', r.chases.filter((c) => c.end === 'running').length);
  out.kv('died', r.chases.filter((c) => c.end === 'died').length);
  out.kv('relieved_by_t1', r.chases.filter((c) => c.end === 'relieved').length);
  out.kv('still_chasing_at_the_end', r.chases.filter((c) => c.end === null).length);
  out.kv('legs', r.chases.reduce((s, c) => s + c.legs, 0));
  out.kv('legs_that_did_not_move', r.chases.reduce((s, c) => s + c.stillLegs, 0));
  out.kv('longest_still_s', max(r.chases.map((c) => c.maxStillS)));

  out.section('each_chase');
  out.table(['bot', 'mob', 'for', 'assigned_min', 'job_left', 'enter_s', 'legs', 'still_legs', 'exact_legs', 'unseen_legs', 'first_d', 'last_d', 'max_still_s', 'returns_after_fight', 'end', 'chase_s'],
    rows(r.chases).map((c) => [c.bot, c.mob, c.for, min(c.at), c.jobLeft, Number.isFinite(c.enteredAt) ? Math.round(c.enteredAt - c.at) : null,
      c.legs, c.stillLegs, c.exactLegs, c.unseenLegs, c.firstD, c.lastD, c.maxStillS, Math.max(0, c.entries - 1),
      c.end, Number.isFinite(c.endAt) ? Math.round(c.endAt - c.at) : null]));

  out.section('each_body');
  out.table(['bot', 'calls_made', 'requests_held', 'answered_at_check', 'said_yes', 'pulled_before_check'],
    r.bodies.sort((a, b) => (a.bot < b.bot ? -1 : 1)).map((b) => [b.bot, b.called, b.questions, b.answered, b.yes, b.withdrawn]));

  out.section('law_13_violations');
  out.table(['at_min', 'bot', 'violation'], r.violations.map((v) => [min(v.at), v.bot, v.what]));
}

module.exports = { reduceHelpDesk, runHelpDesk };
