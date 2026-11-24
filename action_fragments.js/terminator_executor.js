// fragment: terminator_executor (action / combat) — a LIBRARY: terminator_manager runs the pursuit and calls trackMob().
// purpose: Walks one body to the one mob the help desk made it terminator of, wherever the mob has gone, until a fight opens on it or it is
//          dead. One verb: close on a moving mob (Law 0).
//
// THE EXECUTOR TRACKS, THE NAVIGATOR WALKS, COMBAT FIGHTS. Three seats, each blind to the others' work:
//   - this executor reads where the mob stands now (the body's own sight of it, else the combat road's last report of it,
//     else the place the desk gave) and hands the navigator one short leg toward it (goTo max_steps LEG_STEPS), then reads
//     the mob again. A mob that moves is followed leg by leg; a walk to where it stood long ago is never made. Within
//     CLOSE_B of a mob it sees, the leg is to the mob's own cell (exact), so a wall between them is dug or built around.
//   - the navigator plans the whole route and walks only that leg of it, digging, placing and bridging as on any job.
//   - combat takes the body by itself: the navigator's every step passes the combat gate, and the commander's backup door
//     admits the assigned mob once it is in its aggro range and in sight (commander THE BACKUP DOOR). From then the fight is
//     fought as any is and its clock runs. A fight that ends with the mob alive (it ran out of range) leaves the body still
//     assigned, and its next combat step sends it back here: the mob is walked after again in short legs.
//
// A TERMINATOR DOES NOT GIVE UP ON A LIVE MOB. While the mob is alive the body keeps going to it. A body that has not moved
// LEG_PROGRESS_B in NO_PROGRESS_MS of legs has met ground its navigation cannot cross: a navigation fault, so a coding
// violation that stops the run (Law 13), with the place, the mob and the legs in the throw.
//
// Ends, each the end of this body's termination (help_line.end): 'killed' (any body's sight of its death), 'running' (this body's
// own run, which is its own new call), 'died' (this body's death), 'lost' (the body stands where the mob was last reported and
// it is not there: no body can say it is alive).

'use strict';

const watcher = require('@kernel/watcher');
const combatBoard = require('@api/combat_board');
const helpLine = require('@api/help_line');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { sleep } = require('@utils/fragment_utils');

const TAG = 'terminator_executor';
// Route steps one leg may walk before the mob is read again: about a zombie's walk while the body covers them.
const LEG_STEPS = 8;
// A leg that moves the body at least this far is progress.
const LEG_PROGRESS_B = 1.5;
// Legs that have not moved the body for this long are a navigation fault (Law 13): the engagement ceiling's own span.
const NO_PROGRESS_MS = 60000;
// A body this close to a mob it sees walks to the mob's own cell.
const CLOSE_B = 6;
// The body stands within this of the mob's last report, and does not see it, before it may say the mob is not there.
const ARRIVE_B = 6;
// How long it stands there without the mob in sight before the termination ends lost.
const LOST_MS = 10000;
const POLL_MS = 500;

const round1 = (n) => Math.round(n * 10) / 10;
const cell = (p) => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;

// trackMob(bot, help) → { result, legs, mob } once the body is done with this one mob. Never returns while a fight holds the
// body: the combat gate keeps it (battle_stations.combatCheckpoint).
async function trackMob(bot, help) {
  const { combatCheckpoint } = require('@api/battle_stations');
  const id = help.id;
  const label = `${help.name}#${id}`;
  let legs = 0, lostSince = null, result = null;
  let movedAt = Date.now();
  for (;;) {
    await combatCheckpoint(bot, TAG);
    const now = Date.now();
    const mine = helpLine.assigned();
    if (!mine || mine.id !== id) {
      result = helpLine.endedWhy(id) || 'ended';
      break;
    }
    const mob = bot.entities[id];
    const self = bot.entity.position;
    const at = mob && mob.position ? mob.position : (combatBoard.doomedAt(id) || mine.pos);
    if (!at) { helpLine.end('lost'); result = 'lost'; break; }
    const d = Math.hypot(at.x - self.x, at.y - self.y, at.z - self.z);
    if (!mob && d <= ARRIVE_B) {
      if (lostSince === null) lostSince = now;
      if (now - lostSince >= LOST_MS) { helpLine.end('lost'); result = 'lost'; break; }
      movedAt = now;
      await sleep(POLL_MS);
      continue;
    }
    lostSince = null;
    if (now - movedAt >= NO_PROGRESS_MS) {
      throw new Error(`[${TAG}] LAW 13 VIOLATION: terminator of ${label} for ${mine.by} has not moved ${LEG_PROGRESS_B} b in `
        + `${NO_PROGRESS_MS / 1000} s of legs (${legs} legs); body at ${cell(self)}, mob at ${cell(at)}, d=${round1(d)}, seen=${!!mob}. `
        + 'A live mob the navigator cannot reach is a navigation fault.');
    }
    legs++;
    const from = self.clone();
    const exact = !!mob && d <= CLOSE_B;
    watcher.summary(TAG, `LEG n=${legs} mob=${label} for=${mine.by} d=${round1(d)} seen=${!!mob} exact=${exact} to=${cell(at)} steps=${LEG_STEPS} still_s=${Math.round((now - movedAt) / 1000)}`);
    const went = await locomotion.goTo({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z), exact, max_steps: LEG_STEPS, leg: 'travel', purpose: 'terminate' });
    const moved = bot.entity.position.distanceTo(from);
    if (moved >= LEG_PROGRESS_B) { movedAt = Date.now(); continue; }
    watcher.summary(TAG, `LEG_STILL n=${legs} mob=${label} moved=${round1(moved)} arrived=${!!went.arrived} reason=${went.reason || went.why || 'none'} still_s=${Math.round((Date.now() - movedAt) / 1000)}`);
    await sleep(POLL_MS);
  }
  watcher.summary(TAG, `TRACK_END mob=${label} result=${result} legs=${legs}`);
  return { result, legs, mob: label };
}

module.exports = { trackMob, LEG_STEPS, NO_PROGRESS_MS };
