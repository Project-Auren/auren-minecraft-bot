// module: self_preservation
// purpose: the crew's survival seat (crew_board `survival`). The body's life outranks the fight (Law 17): a body at
//          or under FLEE_HP breaks off and runs, and it seeks no fight until it has healed to RETURN_HP; a named monster
//          (a NEVER_WINNABLE boss) is run from too. Only a worker runs: a terminator (combat_board THE KIT WORN) never does;
//          it fights on, and heals standing inside the fight once its mobs are dead (commander THE REGEN). A witch is fought like any other mob, alone or not, near home or far, and never run from (UNFLEEABLE); nor is a field left with only shooters, by a body holding a shield. A drowned is fought like any other
//          mob, in water or out: combat walks every water edge the navigator walks. Either way the
//          body calls for backup: its boardroom chair carries a distress call naming its attackers, and every mob it runs
//          from is slated for elimination on the combat road (combat_board THE TERMINATOR), and the nearest is handed once, when
//          the run starts, to the foreman's help desk (help_line, foreman/help_desk.js). The one body the desk makes its
//          terminator takes it, wherever it stands, until it is dead or gone (calls, commander THE BACKUP DOOR).
//
// Read by every seat off the board, never called across (Law 1). The commander admits threats as it always does, so
// a mob walking up opens the fight the body runs in, and it opens the backup door on a peer's call. While `fleeing`
// the driver runs (`flee`) toward `goal`, home, instead of closing on the mob, and the gunner drops its guard and
// holds no knockback, so the body can sprint; battle_stations ends the wave 'fled' once the body is `clear`, eats what
// it carries, and sends it home to park (idle_park) before the board gives it another job.
//
// A death is still the run's error (battle_stations); this seat is what stands between a hard fight and that error.

'use strict';

const crewBoard = require('@api/crew_board');
const crewLog = require('@api/crew_log');
const hq = require('@kernel/corporate_headquarters');
const combatUtils = require('@utils/combat_utils');

const TAG = 'self_preservation';

const writeBoard = crewBoard.claimPen('survival');

// ── SECTION 1: The numbers ──

// The flee line and the return line: at 4 hearts the body runs; it fights again at 8.
// Two zombie blows on hard are 9 hp, so a body above the line survives the blow it did not see coming.
const FLEE_HP = 8;
const RETURN_HP = 16;

// The body is clear of a fight when no threat stands within its clear reach (clearReach: FLEE_CLEAR_B, or
// FLEE_CLEAR_RANGED_B for a mob that shoots) and none has struck it for FLEE_QUIET_MS. A shooter reaches the body from
// where it stands: a drowned's tridents landed at 10.8 and 16.6 b, so a run that stopped at 12 b was struck between runs.
const FLEE_CLEAR_B = 12;
const FLEE_CLEAR_RANGED_B = 24;
const FLEE_QUIET_MS = 3000;

// ── A RUN IS CONFIRMED OVER ──────────────────────────────────────────────────────────────────────────────
// The body keeps running from a mob until the mob has stopped coming: beyond its clear reach and walking toward the
// body at under PURSUIT_B b/s (the commander's `pursuit`, the mob's own walking, so a body outrunning it does not read
// as a mob giving up) for DISENGAGE_CONFIRM_MS, or gone from the board.
const PURSUIT_B = 0.5;
const DISENGAGE_CONFIRM_MS = 2000;
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'breeze', 'drowned_trident']);
// No run escapes these: an enderman teleports to the body it hunts, so a run only turns the body's back to it (arena: struck
// at 2.8 b with the guard down and killed, the enderman on 5 of its 40). Against them the body stands and fights.
// Nor a witch: its poison runs on through the run, and it walks after the runner and throws again once in range (three
// arena deaths, each a run from a witch: poisoned from 8 hp to under 1 on the way, then a potion from 9.5-11 b).
const UNFLEEABLE = new Set(['enderman', 'witch']);
// NOR A FIELD OF SHOOTERS FROM A SHIELDED BODY: every mob left shoots, so the run turns the shield's back to the arrows on
// open ground, and a shooter reaches the body from where it stands (arena: a worker poisoned at 4.6 ran from two
// skeletons and was shot down at 2.6 while the shield faced home). A body with a shield in its off-hand faces them
// behind it and fights them out instead.
const shootersOnly = (open, bot) => open.length > 0 && combatUtils.holdsShield(bot) && open.every((h) => RANGED.has(threatName(h)));
// Threats weighed: aggroed mobs, and before a fight the hostiles that could be taken by sight, within this reach or a
// threat's clear reach when that is longer.
const THREAT_REACH_B = 16;

// Never a fight to seek or to stay in, whatever the kit.
const NEVER_WINNABLE = new Set(['warden', 'wither', 'ender_dragon', 'elder_guardian']);

// ── THE CALL FOR BACKUP ──────────────────────────────────────────────────────────────────────────────────
// Re-published while the call stands, so a peer can tell a live call from one a dead body left (DISTRESS_FRESH_MS).
const DISTRESS_REFRESH_MS = 2000;
const DISTRESS_FRESH_MS = 5000;
// The run is made toward a peer within this reach (_nearestPeer).
const BACKUP_REACH_B = 32;
// Never doomed: a boss no body wins.
const NEVER_DOOMED = new Set(NEVER_WINNABLE);

// ── SECTION 2: State ──
let attached = false;
let tickHandler = null;
let recovering = false;     // latched at FLEE_HP, released at RETURN_HP
let outmatched = false;     // a named monster stands in the fight (NEVER_WINNABLE)
const running = new Map();  // id → when the mob went quiet (0 while it is still coming), for each mob this run is from
let distress = null;        // { attackers, at } as last published
let saidState = null;
let homeReadAt = 0;
let home = null;

// ── SECTION 3: The pricing — pure ──

// threatName(h) → the name a hostile is priced by: a drowned holding a trident is priced as the thrower it is.
function threatName(h) {
  return combatUtils.throwsTrident(h.entity) ? 'drowned_trident' : h.name;
}

// clearReach(h, bot) → how far the body must be from this hostile to be clear of it.
function clearReach(h, bot) {
  const name = threatName(h);
  return RANGED.has(name) ? FLEE_CLEAR_RANGED_B : FLEE_CLEAR_B;
}

// ── SECTION 4: The tick ──

function _home(now) {
  if (now - homeReadAt < 5000) return home;
  homeReadAt = now;
  const site = hq.readBuildingChair(require('@kernel/bot_mandate').homeBlueprint(), 'set_buildspot');
  home = (site && site.transpose_origin) || null;
  return home;
}

// The nearest other body in sight within BACKUP_REACH_B that is not itself calling for help: the run's goal before the base is
// sited.
function _nearestPeer(bot, self, board) {
  let best = null;
  for (const [botId, chair] of Object.entries(board)) {
    if (botId === (process.env.BOT_ID || 'default')) continue;
    if (chair && chair.distress && Date.now() - chair.distress.at <= DISTRESS_FRESH_MS) continue;
    const e = bot.players && bot.players[botId] && bot.players[botId].entity;
    if (!e || !e.position) continue;
    const d = self.distanceTo(e.position);
    if (d <= BACKUP_REACH_B && (!best || d < best.d)) best = { d, name: botId, pos: e.position };
  }
  return best;
}

function _publishDistress(next) {
  const me = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(me, {});
  const out = { ...chair };
  if (next) out.distress = next; else delete out.distress;
  hq.writeBoardroomChair(me, out);
  require('@utils/external_library_guard')
    .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

function onPhysicsTick(bot) {
  const self = bot.entity && bot.entity.position;
  const hp = typeof bot.health === 'number' ? bot.health : null;
  if (!self || hp === null || hp <= 0) return;
  const now = Date.now();
  const cmd = crewBoard.readCommander();

  // A TERMINATOR NEVER RUNS (combat_board THE KIT WORN): it fights its fight out and heals inside it, standing where the fight
  // ended (commander THE REGEN). Only a worker runs home. Not even from a named monster: what a terminator meets it kills.
  const terminator = require('@api/combat_board').isTerminator();
  if (!recovering && hp <= FLEE_HP && !terminator) recovering = true;
  if (recovering && (hp >= RETURN_HP || terminator)) recovering = false;

  // The fight priced as it stands, or, with none open, the one the sight door would open.
  const active = cmd.active || [];
  // Mobs this run has not yet shaken: inside their clear reach, or still walking after the body, or quiet for too short a time.
  for (const id of running.keys()) if (!active.some((h) => h.id === id)) running.delete(id);
  for (const h of active) {
    if (!running.has(h.id)) continue;
    if (h.distance <= clearReach(h, bot) || h.pursuit > PURSUIT_B) running.set(h.id, 0);
    else if (!running.get(h.id)) running.set(h.id, now);
  }
  const unshaken = (h) => running.has(h.id) && (!running.get(h.id) || now - running.get(h.id) < DISENGAGE_CONFIRM_MS);
  const near = (list) => (list || []).filter((h) => h.distance <= Math.max(THREAT_REACH_B, clearReach(h, bot)));
  const open = active.filter((h) => h.distance <= Math.max(THREAT_REACH_B, clearReach(h, bot)) || unshaken(h));
  const candidates = open.length ? open : near(cmd.hostiles).filter((h) => h.seen !== false && !h.claimedBy);

  // A run is for low health and for the named monsters; every other fight is taken, a witch's included. The arena: one body
  // in iron with a shield cleared seven zombies in 9 of 9 rounds and never fell below 17.8.
  const base = _home(now);
  outmatched = !terminator && candidates.some((h) => NEVER_WINNABLE.has(threatName(h)));

  // Every fight open while the body heals, or one with a named monster, is a run, unless it holds a mob no run escapes
  // (UNFLEEABLE), which is fought out; the body is clear once it has shaken every mob it ran from, nothing it fights
  // stands within its clear reach and nothing has struck it for FLEE_QUIET_MS.
  const struck = require('@api/battle_stations').struckWithin(FLEE_QUIET_MS);
  const fleeing = (recovering || outmatched) && open.length > 0 && !open.some((h) => UNFLEEABLE.has(threatName(h)))
    && !(recovering && !outmatched && shootersOnly(open, bot));
  if (fleeing) { for (const h of open) if (!running.has(h.id)) running.set(h.id, 0); } else running.clear();
  const clear = !open.some((h) => h.distance <= clearReach(h, bot) || unshaken(h)) && !struck;
  const why = !fleeing ? null : recovering ? 'low_hp' : 'named_monster';
  // A MOB RUN FROM IS DOOMED: named on the combat road, its place renewed each tick the run still sees it, so a terminator
  // walking after it reads where it went. Who terminates it is the foreman's help desk's pick, from the one call made when the
  // run starts (below, flee_start).
  const doomable = fleeing ? open.filter((h) => !NEVER_DOOMED.has(threatName(h)) && h.entity && h.entity.position).map((h) => {
    const p = h.entity.position;
    return { id: h.id, name: threatName(h), d: h.distance, pos: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } };
  }) : [];
  for (const mob of doomable) require('@api/combat_board').markTermination(mob, now);

  // The call stands while the body runs, naming every mob pressing it.
  if (fleeing) {
    const attackers = open.map((h) => h.id).sort((a, b) => a - b);
    const same = distress && distress.attackers.join(',') === attackers.join(',');
    if (!same || now - distress.at >= DISTRESS_REFRESH_MS) {
      if (!same) {
        const named = attackers.map((id) => { const h = open.find((o) => o.id === id); return { name: h ? threatName(h) : 'entity', id, d: h ? Math.round(h.distance * 10) / 10 : null }; });
        require('@api/combat_record').record('backup_call', { attackers: named, why, reach_b: BACKUP_REACH_B });
      }
      distress = { attackers, at: now, hp: Math.round(hp * 10) / 10, why };
      _publishDistress(distress);
    }
  } else if (distress) {
    require('@api/combat_record').record('backup_call_end', { attackers: distress.attackers });
    distress = null;
    _publishDistress(null);
  }

  let goal = null;
  if (fleeing) {
    // THE RUN GOES HOME: the crew's food is there, and the body parks there once the run ends (battle_stations → idle_park).
    // A peer is run to only before the base is sited.
    const peer = base ? null : _nearestPeer(bot, self, hq.getFullBoardroom({}));
    goal = base ? { x: base.x, y: base.y, z: base.z, kind: 'home', name: null }
      : peer ? { x: peer.pos.x, y: peer.pos.y, z: peer.pos.z, kind: 'peer', name: peer.name } : null;
  }

  const state = `${recovering}|${outmatched}|${fleeing}|${why}`;
  if (state !== saidState) {
    const wasFleeing = saidState !== null && saidState.split('|')[2] === 'true';
    if (fleeing && !wasFleeing) {
      require('@api/combat_record').record('flee_start', {
        why, from: open.map((h) => ({ name: threatName(h), id: h.id, d: Math.round(h.distance * 10) / 10 })),
        goal: goal ? { kind: goal.kind, name: goal.name, x: Math.round(goal.x), y: Math.round(goal.y), z: Math.round(goal.z) } : null,
      });
      // ONE RUN, ONE CALL: a terminator that runs is a body that runs, so its termination ends here; then the nearest mob the
      // run is from is handed to the foreman's help desk once (help_line.call). The body does not call again on this run.
      const helpLine = require('@api/help_line');
      helpLine.end('running');
      const nearest = [...doomable].sort((a, b) => a.d - b.d)[0];
      if (nearest) helpLine.call(bot, { id: nearest.id, name: nearest.name, pos: nearest.pos }, why);
    } else if (!fleeing && wasFleeing) {
      require('@api/combat_record').record('flee_end', { clear, recovering });
    }
    saidState = state;
    crewLog.post(TAG, 'survival', {
      hp: Math.round(hp * 10) / 10, recovering, outmatched, fleeing, why, threats: candidates.length,
      goal: goal ? goal.kind : null, to: goal && goal.name ? goal.name : null,
    });
  }

  writeBoard({
    at: now,
    hp,
    recovering,
    outmatched,
    fleeing,
    clear,
    why,
    goal,
    calling: !!distress,
  });
}

// ── SECTION 5: Peers' calls, read by the commander ──

// calls(bot) → Set of mob ids this body answers: the mob the foreman's help desk assigned this body (help_line.assigned), at any
// distance. The desk assigns only a body that said it was available (help_line.reasonNot).
let answering = new Map();   // `${caller}:${mob}` → the answer as last recorded (combat_record backup_answer/backup_drop)
function calls(bot) {
  const out = new Set();
  const self = bot.entity && bot.entity.position;
  if (!self) return out;
  const taken = new Map();   // `${caller}:${mob}` → the answer's row fields
  // A called-on mob a peer holds the claim on is that peer's fight: the helper does not open on it (it would only yield), it
  // walks on and takes it the moment the claim lapses (the peer kills it, or runs and drops it).
  const help = require('@api/help_line').assigned();
  if (help && !require('@api/mob_claims').owners().has(help.id)) {
    out.add(help.id);
    const key = `${help.by}:${help.id}`;
    const own = require('@api/combat_board').claim();
    // A body that answered and is now in the fight keeps its answer row.
    if (own && own.id === help.id) { if (answering.has(key)) taken.set(key, answering.get(key)); } else {
      const e = bot.players && bot.players[help.by] && bot.players[help.by].entity;
      const mob = bot.entities[help.id];
      const at = mob && mob.position ? mob.position : (require('@api/combat_board').doomedAt(help.id) || help.pos);
      taken.set(key, {
        caller: help.by, caller_d: e && e.position ? Math.round(self.distanceTo(e.position) * 10) / 10 : null, caller_hp: null,
        mob: { name: help.name, id: help.id }, mob_d: at ? Math.round(Math.hypot(at.x - self.x, at.z - self.z) * 10) / 10 : null, termination: true,
      });
    }
  }
  // WHO ANSWERED WHOM, AS IT CHANGES: one row when this body takes a caller's attacker, one when it lets it go.
  for (const [key, f] of taken) if (!answering.has(key)) require('@api/combat_record').record('backup_answer', f);
  for (const [key, f] of answering) if (!taken.has(key)) require('@api/combat_record').record('backup_drop', { caller: f.caller, mob: f.mob });
  answering = taken;
  return out;
}

// ── SECTION 6: Lifecycle ──

// Attached for the process after the commander (it reads the commander's board) and before the gunner and the
// driver, which read this seat the same tick.
// A doomed mob's death ends its termination, whoever saw it fall.
let deadHandler = null;
let selfDeathHandler = null;
function start(bot) {
  if (attached) return;
  deadHandler = (e) => {
    if (!e) return;
    require('@api/help_line').endOn(e.id, 'killed');
    if (require('@api/combat_board').doomed(e.id)) require('@api/combat_board').endTermination(e.id, 'killed');
  };
  bot.on('entityDead', deadHandler);
  // A terminator that dies has ended its termination: it respawns as a body like any other.
  selfDeathHandler = () => require('@api/help_line').end('died');
  bot.on('death', selfDeathHandler);
  recovering = false;
  outmatched = false;
  running.clear();
  distress = null;
  saidState = null;
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  if (deadHandler) (bot || global.bot).removeListener('entityDead', deadHandler);
  if (selfDeathHandler) (bot || global.bot).removeListener('death', selfDeathHandler);
  deadHandler = null;
  selfDeathHandler = null;
  tickHandler = null;
  attached = false;
  if (distress) { distress = null; _publishDistress(null); }
}

module.exports = {
  start, stop, calls, clearReach, NEVER_DOOMED,
  FLEE_HP, RETURN_HP, FLEE_CLEAR_B, BACKUP_REACH_B, DISTRESS_FRESH_MS,
};
