// fragment: terminator_manager — this body's pursuit of the one mob the foreman's help desk made it terminator of (help_line).
// No board job carries it: the combat step routes a terminator here straight from its job or its idle spot (battle_stations
// THE HELP CALL BREAKS INTO WORK).
//   - Sense    = the mob this body terminates (help_line.assigned).
//   - Act      = hand it to terminator_executor.trackMob, which walks short legs of regular navigation after it until a fight
//                opens on it (combat takes the body by itself) or the termination ends (killed, lost, unreached, running).
//   - Exit     = recursive_judge, which plans afresh: the body does not go back to the job it left.
// A fight that ends with the mob alive abandons this chain; the body, still the terminator, is routed back here at its next step.
// One signal lives for the whole chain (Law 4).

'use strict';

const watcher = require('@kernel/watcher');
const helpLine = require('@api/help_line');
const { trackMob } = require('@action/terminator_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'terminator_manager';

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the termination manager ran.`);
    helpLine.beginPursuit();
    const help = helpLine.assigned();
    let readable = `${TAG}: no mob to terminate`;
    if (help) {
      watcher.summary(TAG, `TARGET mob=${help.name}#${help.id} for=${help.by}`);
      const out = await trackMob(bot, help);
      readable = `${TAG}: ${out.mob} ${out.result} after ${out.legs} leg(s)`;
    }
    watcher.summary(TAG, readable);
    routeToJudge(TAG, { readable, [TAG]: { success: true, readable } });
  }),
};
