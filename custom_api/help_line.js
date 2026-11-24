// api: help_line
// purpose: This body's line to the foreman's help desk (foreman/help_desk.js). One way, no repeats: every word is a handoff the
//          receiver is trusted with, and no body speaks to another.
//
// THE CALL: a body that starts a run hands the desk one call (call, from self_preservation): the mob that drove it to run and
// every peer it knows, ranked by straight-line distance to that mob. The desk takes it at once (help_taken), as it answers a
// planning request; a desk that never takes it is a silent foreman, and silence ends the run (timeout_crash.watch, Law 30).
// The body does not call again on that run. Its next run is a new call.
//
// THE ANSWER: the desk gives the request to one body at a time. It is not answered when it arrives: it waits on the body (ask)
// until the body's next inline check (battle_stations.combatCheckpoint → answerAtGate), which reads the body as it stands at
// that step and answers "available" or "not available" with its reason. A body that reaches no check inside the desk's window
// (help_desk ANSWER_MS) has the request pulled (help_withdrawn): it no longer holds it, so it cannot answer it.
// The reasons, in the order they are read:
//   dead or respawning · the T-1 · a terminator already · promised to another call · running · healing · low health · no weapon ·
//   no shield at dusk or night · fighting another mob · on survival work · too far below the mob.
// A "yes" is a promise: until the desk's help_assign arrives, every other request is answered "promised to another call".
// The desk answers every yes it receives with help_assign; the body acts only on that.
//
// THE T-1 COMES TO EVERY CALL: the desk puts the mob on the foreman's threat board as a call (foreman/threat_board), at the
// head of every full-time terminator's list (designations letter T, the crew's seat: assessors/terminator_duty). A T-1 that
// takes a called target from its list holds it here (summon, from terminator_planner), so it can say when it reaches it.
// The desk never asks a T-1 to be a T-2.
//
// THE T-2 IS THE STOPGAP UNTIL THE T-1 ARRIVES: the assigned body leaves its job at its next combat step (battle_stations.combatCheckpoint) and pursues the
// mob (terminator_manager, terminator_executor) until it ends: killed (any body's sight of its death), lost (the terminator
// stands where it was and it is gone), unreached (legs that went nowhere), or running (the terminator's own run, which is a new
// call like any body's), or relieved (the T-1 stands within RELIEF_B of the mob: it tells the desk, help_relieve, and the desk tells the T-2,
// help_relieved). A T-2 given another request answers it "a terminator already" like any refusal.
// A fight the pursuit opens is fought as any fight is; when it ends with the mob alive, the next combat step sends the body back
// to the pursuit. When the pursuit is over the body goes to the board fresh: it does not return to the job it left.

'use strict';

const watcher = require('@kernel/watcher');
const timeoutCrash = require('@utils/timeout_crash');

const TAG = 'help_line';
// A terminator stands at RETURN_HP or better when it says yes: the line a healing body fights again at (self_preservation).
const HELPER_MIN_HP = 16;
// A body this far below the mob is in the ground under it: the walk up is a mine's length, not a chase.
const DEEP_BELOW_B = 24;
// A summoned T-1 within this of the mob has arrived: the T-2 holding it is relieved.
const RELIEF_B = 8;
// A summon not ended by the mob's death is dropped after this: the mob has outrun every word of it.
const SUMMON_MAX_MS = 300000;

let _assigned = null;     // { call, id, name, pos, by, at } — the mob this body terminates
let _asked = [];          // [{ call, ask_id, mob, by }] — the desk's questions, waiting on this body's next inline check
let _promised = null;     // { call, ask_id, answer } — this body said yes and waits for the desk's word
let _inPursuit = false;   // the pursuit chain is the live chain (set at the combat step, cleared at the judge and idle_park)
let _requestSeq = 0;
const _receipts = new Map();   // request id → the watch on the desk taking the call
const _ended = new Map();      // mob id → why this body's termination of it ended, for the pursuit's last read
const _summons = new Map();    // mob id → { call, id, name, pos, by, at, relieved } — the calls this T-1 is summoned to

const round1 = (n) => Math.round(n * 10) / 10;
const _send = (type, payload) => require('@utils/external_library_guard').guardExternalSync(TAG, `send ${type}`, () => require('@kernel/foreman_link').sendHelp(type, payload));

// call(bot, mob, why) — this body starts a run from `mob` ({ id, name, pos }). Once a run.
function call(bot, mob, why) {
  const link = require('@kernel/foreman_link');
  if (!link.hasForeman() || !link.isConnected()) return;
  const d = (c) => Math.hypot(c.x - mob.pos.x, c.y - mob.pos.y, c.z - mob.pos.z);
  const peers = link.getPeerBodyCells().map((c) => ({ botId: c.botId, d: d(c) })).sort((a, b) => a.d - b.d || (a.botId < b.botId ? -1 : 1));
  const request = ++_requestSeq;
  _receipts.set(request, timeoutCrash.watch(TAG, 'the foreman has not taken this body\'s help call'));
  _send('help_call', { request_id: request, mob: { id: mob.id, name: mob.name, pos: mob.pos }, ranked: peers.map((p) => p.botId), distances: peers.map((p) => Math.round(p.d)), why });
  watcher.summary(TAG, `HELP_CALL mob=${mob.name}#${mob.id} why=${why} ranked=${peers.map((p) => `${p.botId}:${Math.round(p.d)}`).join(',') || 'none'}`);
}

// taken(payload) — the desk has the call: the handoff is done.
function taken(payload) {
  const w = _receipts.get(payload.request_id);
  if (!w) throw new Error(`[${TAG}] the desk took call request ${payload.request_id}, which this body never made`);
  _receipts.delete(payload.request_id);
  w.done();
}

// unfit(bot) → why this body cannot terminate now, or null.
function unfit(bot) {
  if (!bot || !bot.entity || !(bot.health > 0)) return 'dead or respawning';
  const survival = require('@api/crew_board').readSurvival();
  if (survival.fleeing === true) return 'running';
  if (survival.recovering === true) return 'healing';
  if (!['sword', 'axe'].includes(require('@utils/combat_utils').pickBestWeapon(bot).rung)) return 'no weapon';
  return null;
}

// reasonNot(bot, ask) → why this body cannot take the asked call now, or null when it can.
function reasonNot(bot, ask) {
  const gone = unfit(bot);
  if (gone === 'dead or respawning') return gone;
  if (require('@api/combat_board').isTerminator()) return 'the T-1: summoned to every call, never a T-2';
  if (_assigned) return `a terminator already, of ${_assigned.name}#${_assigned.id}`;
  if (_promised) return 'promised to another call';
  if (gone) return gone;
  if (bot.health < HELPER_MIN_HP) return `low health ${round1(bot.health)}`;
  const { isNightTime, isDuskTime, PRE_BAND_MEMBERS } = require('@thinking/architect_config');
  if ((isNightTime() || isDuskTime()) && require('@kernel/bot_mandate').fearsTheNight()) {
    const off = bot.inventory.slots ? bot.inventory.slots[45] : null;
    if (!(off && off.name === 'shield') && !bot.inventory.items().some((i) => i.name === 'shield')) return 'no shield at dusk or night';
  }
  const claim = require('@api/combat_board').claim();
  if (claim && claim.id !== ask.mob.id) return `fighting another mob #${claim.id}`;
  const magnet = require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  if (magnet && PRE_BAND_MEMBERS.includes(magnet.job_type)) return `on survival work ${magnet.what || magnet.job_type}`;
  if (ask.mob.pos && bot.entity.position.y < ask.mob.pos.y - DEEP_BELOW_B) return `${Math.round(ask.mob.pos.y - bot.entity.position.y)} b below the mob`;
  return null;
}

// ask(payload) — the desk's question ({ call, ask_id, mob, by }) arrives: it waits for this body's next inline check.
function ask(payload) {
  _asked.push(payload);
  watcher.summary(TAG, `HELP_QUESTION call=${payload.call} mob=${payload.mob.name}#${payload.mob.id} for=${payload.by} — answered at the next inline check.`);
}

// withdraw(payload) — the desk's window closed: the request is pulled from this body. Already answered at a check, it is gone
// already, and the answer is on its way to the desk, which takes it inside its grace.
function withdraw(payload) {
  const before = _asked.length;
  _asked = _asked.filter((q) => !(q.call === payload.call && q.ask_id === payload.ask_id));
  if (_asked.length !== before) watcher.summary(TAG, `HELP_WITHDRAWN call=${payload.call} — no inline check came inside the desk's window.`);
}

// answerAtGate(bot) — the inline check: every question waiting on this body is answered from the body as it stands now, in the
// order they arrived. A yes makes a promise, so the questions after it are answered "promised to another call".
function answerAtGate(bot) {
  if (!_asked.length) return;
  const waiting = _asked;
  _asked = [];
  for (const payload of waiting) {
    const reason = reasonNot(bot, payload);
    if (!reason) _promised = { call: payload.call, ask_id: payload.ask_id, answer: timeoutCrash.watch(TAG, 'the foreman has not said what became of this body\'s yes') };
    _send('help_reply', { call: payload.call, ask_id: payload.ask_id, available: !reason, reason });
    watcher.summary(TAG, `HELP_ASKED call=${payload.call} mob=${payload.mob.name}#${payload.mob.id} for=${payload.by} answer=${reason ? `no: ${reason}` : 'available'}`);
  }
}

function _settlePromise(payload) {
  if (!_promised || _promised.call !== payload.call || _promised.ask_id !== payload.ask_id) {
    throw new Error(`[${TAG}] LAW 13 VIOLATION: the desk answered a yes (call ${payload.call}, ask ${payload.ask_id}) this body is not waiting on`);
  }
  _promised.answer.done();
  _promised = null;
}

// assign(payload) — the desk names this body the terminator. The call is over at the desk; the mob is this body's now.
function assign(payload) {
  _settlePromise(payload);
  const m = payload.mob;
  _assigned = { call: payload.call, id: m.id, name: m.name, pos: m.pos, by: payload.by, at: Date.now() };
  _ended.delete(m.id);
  watcher.summary(TAG, `TERMINATOR role=T-2 mob=${m.name}#${m.id} for=${payload.by} t1=${(payload.t1 || []).join('+') || 'none'} — the job is left at the next combat step.`);
  require('@api/combat_record').record('terminator_assigned', { mob: { name: m.name, id: m.id }, by: payload.by });
}

// end(why) — this body's termination is over: killed, lost, unreached, running or died. No word goes to the desk.
function end(why) {
  if (!_assigned) return;
  watcher.summary(TAG, `TERMINATOR_END mob=${_assigned.name}#${_assigned.id} why=${why}`);
  require('@api/combat_record').record('terminator_end', { mob: { name: _assigned.name, id: _assigned.id }, why });
  _ended.set(_assigned.id, why);
  _assigned = null;
  _inPursuit = false;
}

// endOn(id, why) — the termination ends when it is of this mob.
function endOn(id, why) { if (_assigned && _assigned.id === id) end(why); }

// relieved(payload) — the desk's word that the T-1 stands at this body's mob: the T-2's termination of it ends, and the body
// goes back to the board. A fight with the mob already open is fought out as any fight is.
function relieved(payload) {
  const m = payload && payload.mob;
  if (!m) throw new Error(`[${TAG}] LAW 13 VIOLATION: the desk's relief names no mob`);
  if (!_assigned || _assigned.id !== m.id) { watcher.summary(TAG, `T2_RELIEVED mob=${m.name}#${m.id} by=${payload.by} — this body's termination of it had already ended`); return; }
  watcher.summary(TAG, `T2_RELIEVED mob=${m.name}#${m.id} by=${payload.by} — the T-1 is at the mob; back to the board.`);
  end(`relieved by the T-1 ${payload.by}`);
}

// summon(payload) — this T-1 took a called target off its list ({ call, mob, by }): held here until it reaches the mob.
function summon(payload) {
  const m = payload && payload.mob;
  if (!m || typeof m.id !== 'number') throw new Error(`[${TAG}] LAW 13 VIOLATION: a called target was taken with no mob`);
  if (!require('@api/combat_board').isTerminator()) {
    watcher.summary(TAG, `T1_SUMMON_REFUSED mob=${m.name}#${m.id} — this body is no longer a terminator`);
    return;
  }
  _summons.set(m.id, { call: payload.call, id: m.id, name: m.name, pos: m.pos, by: payload.by, at: Date.now(), relieved: false });
  watcher.summary(TAG, `T1_SUMMONED call=${payload.call} mob=${m.name}#${m.id} for=${payload.by} t2=${payload.t2 || 'asking'}`);
}

// dropSummon(id) — the T-1 finished the called target: nothing more is said of it.
function dropSummon(id) { _summons.delete(id); }

// summons(now) → [{ call, id, name, pos, by, at, relieved }]: the calls this T-1 still answers, each where any body last saw
// its mob (combat_board.doomedAt). A summon ends with its mob's termination, or after SUMMON_MAX_MS.
function summons(now = Date.now()) {
  const board = require('@api/combat_board');
  for (const [id, s] of [..._summons]) {
    if (board.terminationEnd(id) || now - s.at > SUMMON_MAX_MS || !board.isTerminator()) {
      _summons.delete(id);
      watcher.summary(TAG, `T1_SUMMON_END mob=${s.name}#${id} why=${board.terminationEnd(id) ? board.terminationEnd(id).why : (board.isTerminator() ? 'expired' : 'stepped down')}`);
      continue;
    }
    const at = board.doomedAt(id);
    if (at) s.pos = at;
  }
  return [..._summons.values()];
}

// checkRelief(bot, now) — once per combat sweep (combat_board.tick): a summoned T-1 within RELIEF_B of the mob tells the desk
// it has arrived, once per summon, so the desk relieves the T-2 holding it.
function checkRelief(bot, now = Date.now()) {
  if (!_summons.size) return;
  const me = bot && bot.entity && bot.entity.position;
  if (!me) return;
  for (const s of summons(now)) {
    if (s.relieved) continue;
    const e = bot.entities[s.id];
    const pos = e && e.position ? e.position : null;
    if (!pos || pos.distanceTo(me) > RELIEF_B) continue;
    s.relieved = true;
    _send('help_relieve', { call: s.call, mob: { id: s.id, name: s.name } });
    watcher.summary(TAG, `T1_ARRIVED call=${s.call} mob=${s.name}#${s.id} d=${round1(pos.distanceTo(me))} — the desk relieves the T-2.`);
  }
}

// foremanGone() — the socket closed: the body is stopping (foreman_link), so the desk's answers it waits on are not waited for.
function foremanGone() {
  for (const w of _receipts.values()) w.done();
  _receipts.clear();
  if (_promised) { _promised.answer.done(); _promised = null; }
  _asked = [];
  _summons.clear();
}

const assigned = () => _assigned;
const endedWhy = (id) => _ended.get(id) || null;
const inPursuit = () => _inPursuit;
// beginPursuit() — the combat step routed this body into the pursuit: its own steps are not broken into. Cleared where a chain
// lands after a fight (chainAtJudge): a pursuit chain reaches the judge or idle_park only when it is over or a fight abandoned it.
function beginPursuit() { _inPursuit = true; }
function chainAtJudge() { _inPursuit = false; }

module.exports = {
  call, taken, ask, withdraw, answerAtGate, assign, end, endOn, foremanGone, assigned, endedWhy, inPursuit, beginPursuit, chainAtJudge, unfit,
  relieved, summon, summons, dropSummon, checkRelief,
  HELPER_MIN_HP, RELIEF_B,
};
