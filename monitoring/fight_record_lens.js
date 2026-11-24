// Auren_Bot/monitoring/fight_record_lens.js
// --fight-record: every fight rebuilt from the combat ledger (custom_api/combat_record), one JSON row per fact. Per body:
// fights, swings, hits, misses, kills, blows taken, flees, backup called and answered. Per fight: what opened it, its
// first target and why, how it closed, what died and what walked. Every backup call with who answered it and from how
// far, every flee with what it ran from and where to. `--fight=<id>` prints that fight's every row in order: the full
// account of the body's decisions. `--bot=<name>` narrows to one body. Inputs as ARGUMENTS, render, RETURN.
// Three ledgers for the post-battle rebuild: SHIELD (every block with its blow, its attacker and whether the body was
// fighting that attacker, and the wear by attacker), TACTICS (how every engaged mob was classed and what decided it),
// ROUTES (every combat route search by purpose and outcome, with the searches that ran out of thinking time). The
// commander's `picture` rows (every engaged mob's position once a second) print in `--fight=<id>`.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --fight-record [--bot=EmberBot] [--fight=EmberBot:3|EmberBot:none] [--all]

'use strict';

const out = require('./data_out');
const combatRecord = require('@api/combat_record');

const clock = (sec) => (sec == null ? '—' : `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`);
// The world's clock on the row: phase, day and time of day in ticks (0 sunrise, 6000 noon, 12000 sunset, 18000 midnight).
const gameTime = (r) => (r && r.game ? `${r.game.phase}:d${r.game.day ?? '?'}:${r.game.tod}` : '—');
const mobName = (m) => (m && typeof m === 'object' ? `${m.name}#${m.id}` : (m || '—'));
const list = (arr) => (arr && arr.length ? arr.map(mobName).join(',') : 'none');

function readRows(seg, botFilter) {
  const rows = [];
  const seen = new Set();
  for (const l of seg) {
    const r = combatRecord.parse(l.raw || '');
    if (!r) continue;
    const key = `${r.bot}|${r.seq}|${r.t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A body's view keeps the answers to its own calls: those rows are written by the answerer, not the caller.
    if (botFilter && r.bot !== botFilter && !(r.kind === 'backup_answer' && r.caller === botFilter)) continue;
    r.rel = l.relSec != null ? l.relSec : null;
    rows.push(r);
  }
  rows.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return rows;
}

function reduce(rows) {
  const bots = new Map();
  const B = (n) => {
    if (!bots.has(n)) bots.set(n, { fights: 0, swings: 0, offChase: 0, hits: 0, misses: 0, kills: 0, blows: 0, hpLost: 0, flees: 0, calls: 0, answers: 0, deaths: 0 });
    return bots.get(n);
  };
  const fights = new Map();
  const F = (r) => {
    if (!r.fight) return null;
    if (!fights.has(r.fight)) fights.set(r.fight, { id: r.fight, bot: r.bot, open: r.rel, source: null, target: null, why: null, close: null, ms: null, outcome: 'open', hpOpen: r.me ? r.me.hp : null, hpClose: null, swings: 0, hits: 0, misses: 0, blows: 0, killed: [], disengaged: [], kills: [], game: r.game || null });
    return fights.get(r.fight);
  };
  const calls = [], answers = [], flees = [], kills = [], hurts = [], terminations = [], regens = [];
  // Every mob a body engaged, once: the bodies that fought it, how each engagement on it ended, and who killed it.
  const mobs = new Map();
  const M = (r) => {
    const id = r.mob && r.mob.id;
    if (id == null) return null;
    if (!mobs.has(id)) mobs.set(id, { mob: r.mob, first: r.rel, game: r.game || null, bots: [], ends: [], killedBy: null });
    return mobs.get(id);
  };
  // The guard each body last reported (gunner `shield` rows), so every blow says whether it came round a raised shield.
  const guardOf = new Map();
  for (const r of rows) {
    const b = B(r.bot);
    const f = F(r);
    if (r.kind === 'seat' && r.seat === 'battle_stations' && r.verb === 'engage') { const m = M(r); if (m && !m.bots.includes(r.bot)) m.bots.push(r.bot); }
    if (r.kind === 'seat' && r.seat === 'battle_stations' && r.verb === 'end') { const m = M(r); if (m) m.ends.push(`${r.bot}:${r.fields && r.fields.outcome}`); }
    if (r.kind === 'kill') { const m = M(r); if (m && !m.killedBy) m.killedBy = r.bot; }
    switch (r.kind) {
      case 'fight_open': b.fights++; if (f) f.source = r.source; break;
      case 'target': if (f && !f.target) { f.target = mobName(r.mob); f.why = r.why; f.d = r.d; } break;
      case 'fight_close':
        if (f) { f.close = r.rel; f.ms = r.ms; f.outcome = r.outcome; f.hpClose = r.me ? r.me.hp : null; f.killed = r.killed || []; f.disengaged = r.disengaged || []; }
        break;
      case 'swing': b.swings++; if (f) f.swings++; break;
      case 'hit': b.hits++; if (f) f.hits++; break;
      case 'miss': b.misses++; if (f) f.misses++; break;
      case 'kill': b.kills++; if (f) f.kills.push(r.mob); kills.push(r); break;
      case 'flee_start': b.flees++; flees.push({ ...r, end: null }); break;
      case 'flee_end': { const o = [...flees].reverse().find((x) => x.bot === r.bot && !x.end); if (o) o.end = r; break; }
      // A terminator healing inside its fight (commander THE REGEN): opened when its last mob is gone, closed healed or not.
      case 'regen':
        if (r.state === 'open') regens.push({ ...r, end: null });
        else if (r.state === 'skipped') regens.push({ ...r, end: r });
        else { const o = [...regens].reverse().find((x) => x.bot === r.bot && !x.end); if (o) o.end = r; }
        break;
      case 'backup_call': b.calls++; calls.push({ ...r, answered: [] }); break;
      case 'backup_answer': b.answers++; answers.push(r); break;
      // Records written before the rename carry hunt_open, hunt_end and `hunt: true`; they read as the same rows.
      case 'hunt_open':
      case 'termination_open': terminations.push({ ...r, end: null, terminators: [], passes: [] }); break;
      case 'termination_pass': { const o = terminations.find((x) => x.mob && r.mob && x.mob.id === r.mob.id && !x.end); if (o) o.passes.push(`${r.bot}:${r.why}`); break; }
      case 'hunt_end':
      case 'termination_end': { const o = terminations.find((x) => x.mob && r.mob && x.mob.id === r.mob.id && !x.end); if (o) o.end = r; break; }
      case 'seat':
        if (r.seat === 'gunner' && r.verb === 'shield' && r.fields) guardOf.set(r.bot, { state: r.fields.state, by: r.fields.by || r.fields.why || null, rel: r.rel });
        if (r.seat === 'battle_stations' && r.verb === 'hurt') { b.blows++; b.hpLost += Number(r.fields && r.fields.lost) || 0; if (f) f.blows++; hurts.push({ ...r, guard: guardOf.get(r.bot) || null }); }
        if (r.seat === 'battle_stations' && r.verb === 'death') b.deaths++;
        if (r.seat === 'gunner' && r.verb === 'pick') b.offChase++;
        break;
      default: break;
    }
  }
  for (const a of answers) {
    const c = [...calls].reverse().find((x) => x.bot === a.caller && x.t <= a.t + 1000);
    if (c) c.answered.push(a);
    // A terminator's answer names the termination it took up (self_preservation.calls, `termination: true`).
    const h = (a.termination || a.hunt) && a.mob ? terminations.find((x) => x.mob && x.mob.id === a.mob.id) : null;
    if (h && !h.terminators.includes(a.bot)) h.terminators.push(a.bot);
  }
  // A mob's fate: killed by a body, blown up on its own, or left alive by every engagement on it (the last one's outcome).
  // A mob whose termination ended `killed` died where some body saw it fall (entityDead), though no body's own blow is on
  // the ledger as its kill (sun, a peer's last hit unseen): it is `died`, not alive.
  const diedIds = new Set(terminations.filter((t) => t.end && t.end.why === 'killed' && t.mob).map((t) => t.mob.id));
  for (const m of mobs.values()) {
    const last = m.ends.length ? m.ends[m.ends.length - 1].split(':')[1] : null;
    m.fate = m.ends.some((e) => e.endsWith(':fused')) ? 'fused' : m.killedBy ? 'killed' : diedIds.has(m.mob.id) ? 'died' :m.ends.some((e) => e.endsWith(':detonated')) ? 'detonated' : last ? `alive_${last}` : 'open';
  }
  return { bots, fights, calls, answers, flees, kills, hurts, terminations, mobs, regens };
}

function runFightRecord({ seg = [], traceName = '?', bot = null, fight = null, verbose = false } = {}) {
  const rows = readRows(seg, bot);
  out.kv('lens', 'fight-record');
  out.kv('record', traceName);
  out.kv('rows', rows.length);
  out.kv('schema', rows.length ? rows[0].v : '—');
  if (!rows.length) { out.zero('combat_record_rows'); return; }

  if (fight) {
    out.section('fight_rows');
    out.table(['at', 'game_time', 'seq', 'kind', 'seat', 'verb', 'mob', 'hp', 'food', 'shield', 'x', 'y', 'z', 'detail'],
      // `--fight=<bot>:none` prints that body's rows outside any fight: its flees, calls and blows between waves.
      rows.filter((r) => (fight.endsWith(':none') ? r.bot === fight.slice(0, -5) && !r.fight : r.fight === fight)).map((r) => {
        const { v, t, bot: _b, seq, fight: _f, kind, game, me, seat, verb, mob, rel, ...rest } = r;
        return [clock(rel), gameTime(r), seq, kind, seat || '—', verb || '—', mobName(mob), me ? me.hp : '—', me ? me.food : '—', me ? me.shield : '—', me ? me.x : '—', me ? me.y : '—', me ? me.z : '—', JSON.stringify(rest.fields || rest)];
      }));
    return;
  }

  const r = reduce(rows);
  out.section('by_bot');
  out.table(['bot', 'fights', 'swings', 'off_chase', 'hits', 'misses', 'hit_pct', 'kills', 'blows_taken', 'hp_lost', 'flees', 'backup_called', 'backup_answered', 'deaths'],
    [...r.bots.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, s]) => [n, s.fights, s.swings, s.offChase, s.hits, s.misses,
      s.hits + s.misses ? Math.round((100 * s.hits) / (s.hits + s.misses)) : '—', s.kills, s.blows, Math.round(s.hpLost * 10) / 10, s.flees, s.calls, s.answers, s.deaths]));

  out.section('fights');
  const fl = [...r.fights.values()].sort((a, b) => (a.open || 0) - (b.open || 0));
  out.table(['fight', 'opened', 'game_time', 'source', 'first_target', 'why', 'd', 'secs', 'outcome', 'hp_open', 'hp_close', 'swings', 'hits', 'misses', 'blows_taken', 'kills', 'killed', 'disengaged'],
    (verbose ? fl : fl.slice(0, 200)).map((f) => [f.id, clock(f.open), gameTime(f), f.source || '—', f.target || '—', f.why || '—', f.d ?? '—', f.ms == null ? '—' : Math.round(f.ms / 100) / 10, f.outcome,
      f.hpOpen ?? '—', f.hpClose ?? '—', f.swings, f.hits, f.misses, f.blows, f.kills.length, list(f.killed), list(f.disengaged)]));

  // Per mob, not per fight: two bodies on one mob are two fights and one kill.
  const ml = [...r.mobs.values()].sort((a, b) => (a.first || 0) - (b.first || 0));
  const fates = {};
  for (const m of ml) fates[m.fate] = (fates[m.fate] || 0) + 1;
  out.section('mob_accounting');
  out.kv('mobs_engaged', ml.length);
  for (const [k, v] of Object.entries(fates).sort((a, b) => b[1] - a[1])) out.kv(`fate_${k}`, v);
  out.kv('kill_pct', ml.length ? Math.round((100 * ((fates.killed || 0) + (fates.died || 0))) / ml.length) : '—');
  // Erased: gone for good, a blown creeper included.
  out.kv('erased_pct', ml.length ? Math.round((100 * ((fates.killed || 0) + (fates.died || 0) + (fates.detonated || 0) + (fates.fused || 0))) / ml.length) : '—');
  out.table(['first', 'game_time', 'mob', 'fate', 'killed_by', 'bots', 'engagement_ends'],
    ml.map((m) => [clock(m.first), gameTime(m), mobName(m.mob), m.fate, m.killedBy || '—', m.bots.join(',') || '—', m.ends.join(',') || '—']));

  out.section('backup_calls');
  out.table(['at', 'game_time', 'caller', 'why', 'caller_hp', 'caller_x', 'caller_z', 'attackers', 'answered_by'],
    r.calls.map((c) => [clock(c.rel), gameTime(c), c.bot, c.why || '—', c.me ? c.me.hp : '—', c.me ? c.me.x : '—', c.me ? c.me.z : '—',
      (c.attackers || []).map((a) => `${a.name}#${a.id}@${a.d}b`).join(',') || 'none',
      c.answered.map((a) => `${a.bot}:caller_d=${a.caller_d}:mob_d=${a.mob_d ?? '?'}`).join(',') || 'none']));

  out.section('terminations');
  out.table(['at', 'game_time', 'mob', 'opened_by', 'x', 'z', 'terminators', 'passes', 'ended', 'end_game_time', 'why', 'open_secs'],
    r.terminations.map((h) => [clock(h.rel), gameTime(h), mobName(h.mob), h.bot, h.pos ? h.pos.x : '—', h.pos ? h.pos.z : '—',
      h.terminators.join(',') || 'none', h.passes.join(',') || 'none', h.end ? clock(h.end.rel) : 'open', h.end ? gameTime(h.end) : '—', h.end ? h.end.why : '—',
      h.end ? Math.round(h.end.open_ms / 1000) : '—']));

  out.section('flees');
  out.table(['at', 'game_time', 'bot', 'why', 'hp', 'from', 'goal', 'ended', 'end_hp', 'end_x', 'end_z'],
    r.flees.map((f) => [clock(f.rel), gameTime(f), f.bot, f.why || '—', f.me ? f.me.hp : '—', (f.from || []).map((m) => `${m.name}#${m.id}@${m.d}b`).join(',') || 'none',
      f.goal ? `${f.goal.kind}${f.goal.name ? `:${f.goal.name}` : ''}@${f.goal.x},${f.goal.z}` : 'none',
      f.end ? clock(f.end.rel) : 'open', f.end && f.end.me ? f.end.me.hp : '—', f.end && f.end.me ? f.end.me.x : '—', f.end && f.end.me ? f.end.me.z : '—']));

  out.section('regens');
  out.table(['at', 'game_time', 'bot', 'fight', 'why', 'hp', 'food', 'ended', 'end_why', 'secs', 'end_hp', 'end_food', 'effect_left'],
    r.regens.map((g) => [clock(g.rel), gameTime(g), g.bot, g.fight || '—', g.why || '—', g.hp, g.food, g.end ? clock(g.end.rel) : 'open',
      g.end ? (g.state === 'skipped' ? `skipped_${g.end.why}` : g.end.why) : '—', g.end && g.end.ms != null ? Math.round(g.end.ms / 1000) : '—', g.end ? g.end.hp : '—', g.end ? g.end.food : '—', g.end ? g.end.effect || 'none' : '—']));

  // ── KIT: every break the server played, every wearing item that left the pocket, every weapon pick and every tool or
  // weapon taken in hand (`--all` for the hand rows; the last 30 otherwise).
  const kit = rows.filter((x) => ['broke', 'item_gone', 'weapon_pick', 'hand'].includes(x.kind));
  out.section('kit_breaks');
  out.table(['at', 'game_time', 'bot', 'fight', 'kind', 'item', 'where_or_slot', 'left', 'why', 'hand'],
    kit.filter((x) => x.kind === 'broke' || x.kind === 'item_gone').map((x) => [clock(x.rel), gameTime(x), x.bot, x.fight || '—', x.kind, x.item,
      x.where || x.slot, x.kind === 'broke' ? (x.max != null ? x.max - x.used : '—') : x.left, x.why || '—', x.hand || '—']));
  out.section('weapon_picks');
  out.table(['at', 'game_time', 'bot', 'fight', 'pick', 'pick_left', 'was', 'available'],
    kit.filter((x) => x.kind === 'weapon_pick').map((x) => [clock(x.rel), gameTime(x), x.bot, x.fight || '—', x.pick, x.pick_left ?? '—', x.was || '—', (x.available || []).join(',') || 'none']));
  const hands = kit.filter((x) => x.kind === 'hand');
  out.section('hand_changes');
  out.kv('hand_changes', hands.length);
  out.table(['at', 'game_time', 'bot', 'fight', 'took', 'took_left', 'from', 'from_left', 'by', 'pocket'],
    (verbose ? hands : hands.slice(-30)).map((x) => [clock(x.rel), gameTime(x), x.bot, x.fight || '—', x.took, x.took_left ?? '—', x.from, x.from_left ?? '—', x.by, (x.pocket || []).join(',')]));

  out.section('kills');
  out.table(['at', 'game_time', 'bot', 'mob', 'last_hit_ms', 'fight'], r.kills.map((k) => [clock(k.rel), gameTime(k), k.bot, mobName(k.mob), k.last_hit_ms, k.fight || '—']));

  // ── SHIELD: every block, then the wear by blow and attacker. `engaged` says the attacker was the body's focus when the
  // shield took it; a block from an attacker the body was not fighting is wear spent standing in its line.
  const seatRows = (seat, verb) => rows.filter((x) => x.kind === 'seat' && x.seat === seat && x.verb === verb);
  const hits = seatRows('gunner', 'shield_hit');
  out.section('shield_ledger');
  out.kv('blocks', hits.length);
  out.kv('wear', hits.reduce((s, h) => s + (Number(h.fields && h.fields.wear) || 0), 0));
  const lost = seatRows('gunner', 'shield_lost');
  out.kv('shield_lost_at', lost.length ? lost.map((x) => clock(x.rel)).join(',') : 'never');
  out.table(['at', 'fight', 'wear', 'used', 'max', 'blow', 'by', 'by_tactic', 'by_d', 'engaged', 'hp'],
    hits.map((h) => { const f = h.fields || {}; return [clock(h.rel), h.fight || '—', f.wear ?? '—', f.used ?? '—', f.max ?? '—', f.blow || 'unrecorded', f.by || '—', f.by_tactic || '—', f.by_d ?? '—', f.engaged ?? '—', h.me ? h.me.hp : '—']; }));
  const byAttacker = new Map();
  for (const h of hits) {
    const f = h.fields || {};
    const k = `${f.blow || 'unrecorded'}|${f.by || '—'}`;
    if (!byAttacker.has(k)) byAttacker.set(k, { blow: f.blow || 'unrecorded', by: f.by || '—', blocks: 0, wear: 0, engaged: 0, first: h.rel, last: h.rel });
    const a = byAttacker.get(k);
    a.blocks++; a.wear += Number(f.wear) || 0; if (f.engaged) a.engaged++; a.last = h.rel;
  }
  out.section('shield_wear_by_attacker');
  out.table(['blow', 'by', 'blocks', 'wear', 'engaged_blocks', 'unengaged_blocks', 'first', 'last'],
    [...byAttacker.values()].sort((a, b) => b.wear - a.wear).map((a) => [a.blow, a.by, a.blocks, a.wear, a.engaged, a.blocks - a.engaged, clock(a.first), clock(a.last)]));
  const walls = seatRows('gunner', 'wall');
  out.kv('blast_walls', walls.length ? walls.map((w) => `${clock(w.rel)}:${mobName(w.mob)}:${w.fields && w.fields.state}`).join(',') : 'none');

  // ── TACTICS: how each engaged mob was classed (battle_stations engage rows), first engagement per mob.
  out.section('tactics');
  const firstEngage = new Map();
  for (const e of seatRows('battle_stations', 'engage')) if (e.mob && !firstEngage.has(e.mob.id)) firstEngage.set(e.mob.id, e);
  out.table(['at', 'mob', 'tactic', 'by', 'hand', 'd'],
    [...firstEngage.values()].map((e) => { const f = e.fields || {}; return [clock(e.rel), mobName(e.mob), f.tactic || 'unrecorded', f.by || '—', f.hand || '—', f.d ?? '—']; }));
  const why = {};
  for (const fr of seatRows('commander', 'focus')) { const w = (fr.fields && fr.fields.why) || '—'; why[w] = (why[w] || 0) + 1; }
  for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) out.kv(`focus_why_${k}`, v);

  // ── ROUTES: every combat route row by purpose and state, with the searches that ran out of thinking time.
  out.section('routes');
  const routes = seatRows('driver', 'route');
  const rk = new Map();
  for (const x of routes) {
    const f = x.fields || {};
    const k = `${f.purpose || 'approach'}|${f.state || '—'}`;
    if (!rk.has(k)) rk.set(k, { purpose: f.purpose || 'approach', state: f.state || '—', n: 0, timedOut: 0, msMax: 0 });
    const a = rk.get(k);
    a.n++; if (f.timed_out) a.timedOut++; if (Number(f.ms) > a.msMax) a.msMax = Number(f.ms);
  }
  out.table(['purpose', 'state', 'rows', 'timed_out', 'slowest_ms'],
    [...rk.values()].sort((a, b) => b.n - a.n).map((a) => [a.purpose, a.state, a.n, a.timedOut, a.msMax || '—']));
  const points = seatRows('driver', 'flank_point');
  out.kv('flank_points', points.length);
  out.kv('stuck_rungs', seatRows('driver', 'stuck_rung').length);
  out.kv('stuck_faults', seatRows('driver', 'stuck_fault').length);

  out.section('blows_taken');
  // `shield` is the shield in the off-hand; `guard` the last raise or lower the gunner reported before the blow, with why.
  out.table(['at', 'game_time', 'bot', 'by', 'lost', 'hp', 'shield', 'guard', 'guard_why', 'x', 'z', 'fight'],
    r.hurts.map((h) => [clock(h.rel), gameTime(h), h.bot, mobName(h.mob), h.fields ? h.fields.lost : '—', h.fields ? h.fields.hp : '—', h.me ? h.me.shield : '—', h.guard ? h.guard.state : 'never', h.guard && h.guard.by ? h.guard.by : '—', h.me ? h.me.x : '—', h.me ? h.me.z : '—', h.fight || 'none']));
}

module.exports = { readRows, reduce, runFightRecord };
