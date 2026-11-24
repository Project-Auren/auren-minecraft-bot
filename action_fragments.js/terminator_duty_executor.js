// fragment: terminator_duty_executor — the body takes the crew's terminator seat: it is designated T-1, and the judge's next
// read sends every planning turn to the terminator's own planner (designations.plannerOf, terminator_planner), which gears it
// from the chests first. Full time: the body leaves the job board until it steps down. The seat and the floor are read again
// here, since a peer may have taken the seat or the chests emptied since the board posted it (assessors/terminator_duty).
// One-shot: routes to the judge.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'terminator_duty_executor';
const KIT = 'T-1';

function _route(success, reason) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success } });
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const board = require('@api/combat_board');
  const { TERMINATOR_SEATS } = require('@thinking/architect_config');
  const held = board.crewTerminators();
  if (held.length >= TERMINATOR_SEATS) { _route(true, `the seat is taken (${held.join(',')})`); return; }
  const unmet = require('@action/terminator_planner').floorUnmet(bot, KIT);
  if (unmet.length) { _route(true, `the chests can no longer lift the ${KIT} floor: ${unmet.join(',')}`); return; }
  board.designate(KIT);
  const p = bot.entity.position;
  watcher.summary(TAG, `T_STEP_UP designation=${KIT} seats=${held.length + 1}/${TERMINATOR_SEATS} at=(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`);
  _route(true, `took the terminator seat as ${KIT}`);
}

module.exports = {
  receive: watcher.track(TAG, receive),
};
