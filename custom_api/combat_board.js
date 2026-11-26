// api: combat_board
// purpose: The fleet's fast combat road. Each body sends one small note (foreman_link.sendCombatNote) the moment its
//          claim changes and every NOTE_RENEW_MS while it holds one. The foreman relays a note at once, with no batch
//          and none of the shared HQ. A claim is a lease: a peer's claim not renewed for LEASE_MS is gone, so a body
//          holds a mob only by keeping on claiming it.
//
// Every body uses the claims (mob_claims). A squad (AUREN_SQUAD, a comma-separated list of bot ids) also shares its radar
// and its melee blobs: a mob one member sees, another may take; melee mobs standing together are one claim.
//
// THE TANDEM: one guard to one worker, paired by sorted id. A guard (guard_manager) says it is on duty on this road and stands between
// its ward and the dark, fighting as any body does. A worker on tandem work (job_gates.tandemWork) runs the commander's gate as any body does; a mob the gate confirms is
// named on this road instead of fought, unless it struck the worker, stands within CONTACT_B, or is a fuse in its blast reach. The
// guard takes those mobs past any claim (commander's WARD DOOR), prefers them while nothing is in its reach, chases a mob until it
// is past LEASH_B of the ward, then returns. When the guard's duty lapses the worker fights for
// itself again and the night gate shuts on its job.
//
// THE TERMINATOR: a mob a body runs from is slated for elimination until it is dead (self_preservation), as is one whose aggro a
// fight confirmed (battle_stations). The body that marks it names it on this road (markTermination), every body carries the list in its
// notes, and any body seeing it renews where it stands (sawDoomed), so a terminator walking after it reads where it went. WHO
// TERMINATES IT IS NOT DECIDED HERE: the running body hands one call to the foreman's help desk (help_line, foreman/help_desk.js),
// which asks the bodies one at a time and makes one its terminator.
// A termination on this road ends when the mob dies (entityDead, seen by any body) or past TERMINATION_MAX_MS; every body hears
// the end and drops it.

'use strict';

const crewLog = require('@api/crew_log');

const TAG = 'combat_board';

const NOTE_RENEW_MS = 250;
const LEASE_MS = 600;
const COMMS_REPORT_MS = 30000;
// A squad member's radar reaches this far from the body that uses it.
const RADAR_REACH_B = 32;
// Melee mobs within this of one another are one blob, and a blob spans at most BLOB_SPAN_B from the mob it grew from, so a
// long line of mobs is not one claim.
const BLOB_LINK_B = 4;
const BLOB_SPAN_B = 12;
const AIM_CONE_RAD = 40 * Math.PI / 180;
// A fight takes the guard off its job: its duty stands this long past the last stamp, so the worker keeps working through it.
const DUTY_HOLD_MS = 60000;
// A guard not heard from for this long is gone. Longer than a claim's lease: its lapse recalls the worker home.
const DUTY_LEASE_MS = 3000;
// A mob inside this of a worker is the worker's own fight: with three zombies on it a body striking only the last biter
// took 13 health in 7 s from the two it had declined.
const CONTACT_B = 5;
// A guard leaves a mob this far from its ward: one chased a skeleton 47 b and left its worker alone.
const LEASH_B = 24;
const WORKED_HOLD_MS = 15000;
// THE TERMINATOR. A body with a termination open sends its note at least this often, so every peer keeps its place fresh.
const TERMINATION_RENEW_MS = 1000;
// An ended termination is remembered this long, so a peer's older note does not open it again.
const TERMINATION_ENDED_KEEP_MS = 300000;
// A termination still open after this is ended: the mob has outrun every terminator's word of it.
const TERMINATION_MAX_MS = 900000;

const SQUAD = (process.env.AUREN_SQUAD || '').split(',').map((s) => s.trim()).filter(Boolean);
const _me = () => process.env.BOT_ID || 'default';

// The arena's standing roles: AUREN_TANDEM=worker:AurenBot,guard:IrisBot. No job runs under a sentry's watch.
const benchRole = () => {
  const row = (process.env.AUREN_TANDEM || '').split(',').map((s) => s.trim().split(':')).find(([, id]) => id === _me());
  return row ? row[0] : null;
};

const inSquad = () => SQUAD.includes(_me());
const isSquadmate = (id) => id !== _me() && SQUAD.includes(id);

let _claim = null;      // { id, at, blob: [ids] }
let _seen = [];         // ids this squad body has in its fight
let _helping = false;   // on a peer's blob: this body strikes it without claiming it
let _pos = null;
let _dutyAt = 0;        // when this body last said it guards; 0 off duty
let _working = false;   // declining on a guard's word
let _workedAt = 0;      // when this body last worked under a guard
let _ward = [];         // the mobs this worker hands its guard
let _sentAt = 0;
let _sentKey = '';
const _peers = new Map();   // botId → { claim, seen, pos, duty, working, ward, receivedAt }
const _terminations = new Map();   // mob id → { id, name, pos, at, seen, by } — every open termination this body knows
const _ended = new Map();   // mob id → { at, why } — terminations ended, kept TERMINATION_ENDED_KEEP_MS
let _comms = { notes: 0, total: 0, max: 0, since: 0 };

// ── THE DESIGNATION ──
// Why this body is not planning through the job board (Thinking_fragments/designations): null for a bot (B), else a
// designation such as T-1 or T-1A. Every body starts a bot. It is set by whoever takes the body off the job board (the
// terminator_duty job a body takes when the crew's T-1 seat is open, action_fragments.js/test_module's T-1 march, the
// operator's `sentry --kit`) and dropped by the terminator's own planner when it steps down (terminator_planner). The
// designation is published in the body's boardroom chair (`designation`), so every peer and the foreman's help desk read
// which bodies are terminators (crewTerminators, foreman/help_desk). recursive_judge reads it
// for the body's planner (designations.plannerOf). Read for what the letter changes: a terminator never runs; it fights on
// and heals inside the fight as every body does (self_preservation, commander THE REGEN), and takes the pack a bot leaves
// be (commander, combat_utils TERMINATOR_TAKES); the engine letter picks how it fights (combat_utils.fieldAheadOn). Kept
// across a death.
let _designation = null;
let _parsed = null;
function designate(name) {
  _parsed = name === null ? null : require('@thinking/designations').parse(name);
  _designation = name;
  publishDesignation();
}
// publishDesignation() — this body's chair says what it is now (null for a bot), and the chair goes to the foreman at once,
// so a peer counting the crew's terminators and the help desk summoning them read it within one broadcast.
function publishDesignation() {
  const hq = require('@kernel/corporate_headquarters');
  const chair = hq.readBoardroomChair(_me(), {}) || {};
  if ((chair.designation || null) === _designation) return;
  hq.writeBoardroomChair(_me(), { ...chair, designation: _designation });
  require('@utils/external_library_guard').guardExternalSync(TAG, 'send the designation', () => require('@kernel/foreman_link').sendUpdate());
}
// crewTerminators() → [botId] of every body in the world designated T: this body by its own designation, a peer by its chair
// (publishDesignation) while the foreman names it connected (foreman_link.connectedPeers), so a body gone from the world holds
// no seat and a body standing still at its post keeps it (a body cell goes stale on a body that does not move).
function crewTerminators() {
  const hq = require('@kernel/corporate_headquarters');
  const out = isTerminator() ? [_me()] : [];
  for (const botId of require('@kernel/foreman_link').connectedPeers()) {
    const d = (hq.readBoardroomChair(botId, {}) || {}).designation;
    if (typeof d === 'string' && d.startsWith('T-')) out.push(botId);
  }
  return out;
}
const designation = () => _designation || require('@thinking/designations').DEFAULT;
const kitWorn = () => (_parsed ? _parsed.kit : null);
const engine = () => (_parsed ? _parsed.engine : null);
// isTerminator: the base's terminator (T), the one that holds the seat and answers help calls. fightsAsTerminator: any
// letter whose body fights as one (designations FIGHTS: T and G): never runs, heals in the fight, takes the pack.
const isTerminator = () => !!_parsed && _parsed.letter === 'T';
const fightsAsTerminator = () => !!_parsed && require('@thinking/designations').LETTERS[_parsed.letter].fights === 'terminator';
const isGladiator = () => !!_parsed && _parsed.letter === 'G';

// A claim is a battle: each one opened, this body's or a peer's, is counted where the claiming body stands (battle_ledger).
function setClaim(claim) {
  _claim = claim;
  const p = claim && global.bot && global.bot.entity && global.bot.entity.position;
  if (p) require('@api/battle_ledger').note({ by: _me(), id: claim.id, pos: p });
}
function claim() { return _claim; }
function setSeen(ids) { _seen = ids; }
function setHelping(on) { _helping = on; }
function onDuty(now = Date.now()) { return _dutyAt > 0 && now - _dutyAt <= DUTY_HOLD_MS; }
function standDuty(now = Date.now()) {
  if (!onDuty(now)) crewLog.post(TAG, 'tandem', { role: 'guard', state: 'on_duty' });
  _dutyAt = now;
}
function endDuty() {
  if (_dutyAt) crewLog.post(TAG, 'tandem', { role: 'guard', state: 'off_duty' });
  _dutyAt = 0;
}
function setWorking(on, ward) {
  if (on !== _working) crewLog.post(TAG, 'tandem', { role: 'worker', state: on ? 'declining' : 'fighting' });
  if (on) _workedAt = Date.now();
  _working = on;
  _ward = on ? ward : [];
}

function _send(now) {
  _sentAt = now;
  require('@utils/external_library_guard').guardExternalSync(TAG, 'send combat note', () => require('@kernel/foreman_link').sendCombatNote({
    sent_at: now,
    claim: _helping ? null : _claim,
    seen: _seen,
    pos: _pos,
    duty: onDuty(now),
    working: _working,
    ward: _ward,
    terminations: [..._terminations.values()].map(({ heard, ...h }) => h),
    ended: [..._ended].map(([id, x]) => ({ id, why: x.why })),
  }));
}

// tick(bot, now) — once per commander sweep. A change goes the same sweep; a body holding nothing sends nothing.
function tick(bot, now) {
  const p = bot.entity && bot.entity.position;
  _pos = p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null;
  for (const h of [..._terminations.values()]) if (now - h.at > TERMINATION_MAX_MS) endTermination(h.id, 'expired', now);
  for (const [id, x] of [..._ended]) if (now - x.at > TERMINATION_ENDED_KEEP_MS) _ended.delete(id);
  require('@api/help_line').checkRelief(bot, now);
  const held = !!_claim || _seen.length > 0 || onDuty(now) || _working;
  const key = `${_helping ? '' : _claim ? `${_claim.id}:${_claim.at}:${_claim.blob.join('+')}` : ''}|${_seen.join('+')}|${onDuty(now)}|${_working}|${_ward.join('+')}|${[..._terminations.keys()].join('+')}|${[..._ended.keys()].join('+')}`;
  if (key !== _sentKey || (held && now - _sentAt >= NOTE_RENEW_MS) || (_terminations.size > 0 && now - _sentAt >= TERMINATION_RENEW_MS)) {
    _sentKey = key;
    _send(now);
  }
}

// receive(botId, payload) — one peer's note, off the foreman's relay. The latency is the two clocks of one machine.
function receive(botId, payload, now = Date.now()) {
  _peers.set(botId, { claim: payload.claim || null, seen: payload.seen || [], pos: payload.pos || null, duty: payload.duty === true, working: payload.working === true, ward: payload.ward || [], receivedAt: now });
  if (payload.claim && payload.pos) require('@api/battle_ledger').note({ by: botId, id: payload.claim.id, pos: payload.pos }, now);
  for (const x of payload.ended || []) endTermination(x.id, x.why, now, botId);
  for (const h of payload.terminations || []) {
    if (_ended.has(h.id)) continue;
    const mine = _terminations.get(h.id);
    if (!mine) _terminations.set(h.id, { ...h, heard: now });
    else if (h.seen > mine.seen) _terminations.set(h.id, { ...mine, pos: h.pos, seen: h.seen });
  }
  const lag = Math.max(0, now - payload.sent_at);
  _comms.notes++;
  _comms.total += lag;
  if (lag > _comms.max) _comms.max = lag;
  if (!_comms.since) _comms.since = now;
  if (now - _comms.since >= COMMS_REPORT_MS) {
    crewLog.post(TAG, 'comms', { notes: _comms.notes, mean_ms: Math.round(_comms.total / _comms.notes), max_ms: _comms.max });
    _comms = { notes: 0, total: 0, max: 0, since: now };
  }
}

// liveClaims(now) → [{ botId, id, at, blob, pos }] for every peer whose lease stands.
function liveClaims(now = Date.now()) {
  const out = [];
  for (const [botId, n] of _peers) {
    if (n.claim && now - n.receivedAt <= LEASE_MS) out.push({ ...n.claim, botId, pos: n.pos });
  }
  return out;
}

// radar(now) → Set of mob ids a squadmate has in its fight.
function radar(now = Date.now()) {
  const out = new Set();
  if (!inSquad()) return out;
  for (const [botId, n] of _peers) {
    if (!isSquadmate(botId) || now - n.receivedAt > LEASE_MS) continue;
    for (const id of n.seen) out.add(id);
  }
  return out;
}

// guardOnDuty(now) → whether a guard's duty is heard on this road.
function guardOnDuty(now = Date.now()) {
  for (const n of _peers.values()) if (n.duty && now - n.receivedAt <= DUTY_LEASE_MS) return true;
  return false;
}

// workers(now) → [{ botId, pos }] for the peers declining on a guard's word.
function workers(now = Date.now()) {
  const out = [];
  for (const [botId, n] of _peers) if (n.working && n.pos && now - n.receivedAt <= DUTY_LEASE_MS) out.push({ botId, pos: n.pos });
  return out;
}

// guardKitted(bot) → whether this body carries the least a guard stands with: a sword or an axe, and a shield.
function guardKitted(bot) {
  return ['sword', 'axe'].includes(require('@utils/combat_utils').pickBestWeapon(bot).rung)
    && bot.inventory.items().some((i) => i.name === 'shield');
}

// ── ONE GUARD TO ONE WORKER ──
// Both sides sort the same two lists, so the i-th guard stands by the i-th worker with no message saying so.
function _guardIds(now) {
  const ids = [..._peers].filter(([, n]) => n.duty && now - n.receivedAt <= DUTY_LEASE_MS).map(([id]) => id);
  if (onDuty(now)) ids.push(_me());
  return ids.sort();
}
function _workerIds(now) {
  const ids = [..._peers].filter(([, n]) => n.working && now - n.receivedAt <= DUTY_LEASE_MS).map(([id]) => id);
  if (_working) ids.push(_me());
  return ids.sort();
}

// tandemSeatOpen(now) → whether a guard stands free for this body. Two bodies taking the last guard in one sweep sort it out:
// the one past the guards' count loses its seat on the next.
function tandemSeatOpen(now = Date.now()) {
  const guards = _guardIds(now).length;
  const workersNow = _workerIds(now);
  return _working ? workersNow.indexOf(_me()) < guards : workersNow.length < guards;
}

// guardSeatOpen(seat, now) → whether the seat'th guard's seat is open to this body: a guard's own seat, held through a fight, or one
// past the guards already on duty. A guard's fight drops its job, and its duty stands; no other body takes its place.
function guardSeatOpen(seat, now = Date.now()) {
  if (onDuty(now)) return true;
  return _guardIds(now).length < seat;
}

// wardOf(now) → { botId, pos } of the worker this guard stands by, or null.
function wardOf(now = Date.now()) {
  if (!onDuty(now)) return null;
  const id = _workerIds(now)[_guardIds(now).indexOf(_me())];
  const n = id ? _peers.get(id) : null;
  return n && n.pos ? { botId: id, pos: n.pos } : null;
}

const _fromWard = (ward, pos) => Math.hypot(ward.pos.x - pos.x, ward.pos.z - pos.z);

// beyondLeash(pos, now) → whether a guard has a ward and this point lies past LEASH_B of it.
function beyondLeash(pos, now = Date.now()) {
  const ward = wardOf(now);
  return !!ward && _fromWard(ward, pos) > LEASH_B;
}

// wards(now) → Set of the mob ids this guard's ward hands it. Off duty it is empty.
function wards(now = Date.now()) {
  const ward = wardOf(now);
  return new Set(ward ? (_peers.get(ward.botId).ward || []) : []);
}

// workedRecently(now) → whether this body worked under a guard this recently. A fight drops its job, so read off the job alone a
// worker's own fight would be yielded to a guard's claim at any distance.
function workedRecently(now = Date.now()) { return _workedAt > 0 && now - _workedAt <= WORKED_HOLD_MS; }

// blobOf(seed, melee) → the ids of `seed`'s blob, among `melee` ({ id, position }), seed included. Pure.
function blobOf(seed, melee) {
  const gap = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const inBlob = [seed];
  const rest = melee.filter((m) => m.id !== seed.id && gap(m, seed) <= BLOB_SPAN_B);
  for (let grew = true; grew;) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (inBlob.some((m) => gap(m, rest[i]) <= BLOB_LINK_B)) { inBlob.push(rest[i]); rest.splice(i, 1); grew = true; }
    }
  }
  return inBlob.map((m) => m.id).sort((a, b) => a - b);
}

// aimsElsewhere(mob, self) → true when the server's reported head facing points away from this body by more than
// AIM_CONE_RAD. No facing read answers false: the shield stays on the draw alone.
function aimsElsewhere(mob, self) {
  const yaw = Number.isFinite(mob.headYaw) ? mob.headYaw : mob.yaw;
  if (!Number.isFinite(yaw)) return false;
  const toMe = Math.atan2(-(self.x - mob.position.x), -(self.z - mob.position.z));
  return Math.abs(Math.atan2(Math.sin(yaw - toMe), Math.cos(yaw - toMe))) > AIM_CONE_RAD;
}

// ── THE TERMINATOR ──────────────────────────────────────────────────────────────────────────────────────────────
// markTermination(mob, now) — a mob whose aggro a fight confirmed, or one this body runs from ({ id, name, pos }), is slated for
// elimination: opened once, its place renewed each pass the body still sees it. An ended termination is not opened again.
function markTermination(mob, now = Date.now()) {
  if (_ended.has(mob.id)) return;
  const h = _terminations.get(mob.id);
  if (h) { _terminations.set(mob.id, { ...h, pos: mob.pos, seen: now }); return; }
  _terminations.set(mob.id, { id: mob.id, name: mob.name, pos: mob.pos, at: now, seen: now, by: _me(), heard: now });
  require('@api/combat_record').record('termination_open', { mob: { name: mob.name, id: mob.id }, pos: mob.pos });
}

// sawDoomed(id, pos, now) — any body seeing a doomed mob renews where it stands.
function sawDoomed(id, pos, now = Date.now()) {
  const h = _terminations.get(id);
  if (h) _terminations.set(id, { ...h, pos, seen: now });
}

// endTermination(id, why, now, heardFrom) — the termination is over everywhere this body's notes reach. Stated once, by the body that
// ended it; a body hearing the end from a peer drops it without a row.
function endTermination(id, why, now = Date.now(), heardFrom = null) {
  if (_ended.has(id)) return;
  const h = _terminations.get(id);
  _ended.set(id, { at: now, why });
  _terminations.delete(id);
  if (h && !heardFrom) require('@api/combat_record').record('termination_end', { mob: { name: h.name, id }, why, by: h.by, open_ms: now - h.at });
}

const doomed = (id) => _terminations.has(id);
const terminationEnd = (id) => _ended.get(id) || null;
// doomedAt(id) → the place a doomed mob was last seen by any body, or null.
const doomedAt = (id) => (_terminations.has(id) ? _terminations.get(id).pos : null);
// openTerminations() → [{ id, name, pos, seen }] for every termination open on this road: the mobs bodies ran from or fought,
// each where any body last saw it. A terminator's planner reads it for targets (terminator_planner).
const openTerminations = () => [..._terminations.values()].filter((t) => t.pos).map(({ id, name, pos, seen }) => ({ id, name, pos, seen }));

function reset() {
  _terminations.clear(); _ended.clear();
  _claim = null; _seen = []; _helping = false; _pos = null; _dutyAt = 0; _working = false; _workedAt = 0; _ward = []; _sentAt = 0; _sentKey = '';
  _peers.clear();
  _comms = { notes: 0, total: 0, max: 0, since: 0 };
}

module.exports = {
  benchRole, onDuty, standDuty, endDuty, setWorking, guardKitted, guardOnDuty, tandemSeatOpen, guardSeatOpen, wardOf, workers, wards, beyondLeash, workedRecently, CONTACT_B,
  inSquad, isSquadmate, setClaim, claim, setSeen, setHelping, tick, receive, liveClaims, radar, blobOf, aimsElsewhere, reset,
  markTermination, sawDoomed, endTermination, doomed, doomedAt, terminationEnd, openTerminations,
  designate, designation, kitWorn, engine, isTerminator, fightsAsTerminator, isGladiator, publishDesignation, crewTerminators,
  LEASE_MS, RADAR_REACH_B,
};
