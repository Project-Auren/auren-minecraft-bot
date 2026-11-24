// fragment: phantom_rest_executor — one pass: walk to the crew's spawn bed in the hive's lobby, lie down a moment, get up.
// The bed, the walk's stand beside it, the rest and its record are bed_rest's (Law 16); the job is assessors/spawn_bed's,
// posted while the server spawns phantoms (architect_config PHANTOM_REST). One-shot: routes to the judge.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'phantom_rest_executor';

function _route(success, reason) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success } });
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const bedRest = require('@api/bed_rest');
  const bed = bedRest.needsRest(bot);
  if (!bed) { _route(true, 'no rest is owed now'); return; }
  const near = await bedRest.walkToBed(bot, bed, 'phantom_rest');
  const r = near.ok ? await bedRest.rest(bot, bed) : near;
  if (r.ok) watcher.summary(TAG, `PHANTOM_RESTED in ${bed.id} at (${bed.head.x},${bed.head.y},${bed.head.z})`);
  else watcher.warn(TAG, `PHANTOM_REST ${bed.id} failed: ${r.why}`);
  _route(r.ok, r.ok ? `rested in ${bed.id}` : r.why);
}

module.exports = {
  receive: watcher.track(TAG, receive),
};
