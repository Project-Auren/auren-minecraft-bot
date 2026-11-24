// fragment: spawn_bed_executor — one pass: walk to the crew's spawn bed in the hive's lobby, click it, hear the server set
// the spawn. The bed, the stand beside it and the registration are bed_rest's (Law 16). One-shot: routes to the judge, and
// the next sweep posts the job again while the registration does not name the standing bed.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'spawn_bed_executor';

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success, ...extra } });
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const bedRest = require('@api/bed_rest');
  const bed = bedRest.needsRegistration(bot);
  if (!bed) { _route(true, 'the spawn is already set at the standing bed'); return; }
  const near = await bedRest.walkToBed(bot, bed, 'spawn_register');
  const r = near.ok ? await bedRest.register(bot, bed) : near;
  if (r.ok) watcher.summary(TAG, `SPAWN_REGISTERED ${bed.id} at (${bed.head.x},${bed.head.y},${bed.head.z}) — the server said "${r.said}"`);
  else watcher.warn(TAG, `SPAWN_REGISTER ${bed.id} failed: ${r.why}`);
  _route(r.ok, r.ok ? `spawn set at ${bed.id}` : r.why);
}

module.exports = {
  receive: watcher.track(TAG, receive),
};
