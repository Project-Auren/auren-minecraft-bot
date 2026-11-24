// fragment: survey_executor — does a survey job: scans a sector from its centre, or fetches stone.
//
// ── THE JOBS (job.what) ─────────────────────────────────────────────────────────────────────────
//   sector     walk out to the sector's centre, stand as near it as there is dry ground inside the square, and
//              scan from there (sector_finder.scanOne). A body that cannot stand anywhere in the square
//              writes the sector's page with no stand, so the frontier opens past it and nobody is sent again.
//   sector_tour  one seat scans the sectors round home one after another without coming home (sector_finder.tour).
//   stone_pierce  the headframe's stone and the first furnaces' while the mine is shut: one column dug straight down to
//              a run of stone and sealed behind the body (custom_api/stone_pierce), the column sought over the body's
//              whole loaded area (stone_column_scanner). A trip that cannot go down (no sealing stock, no column in the
//              loaded area) ends with nothing: stone has no other source than the pierce and the mine.
//
// The walk out is sector_finder.walkToward's.
//
// Every job ends by dropping the pocket off and handing back to the judge, as salvage does.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const finder = require('@api/sector_finder');

const TAG = 'survey_executor';

module.exports = {

    receive: watcher.track(TAG, async (signalType, payload = {}) => {
        if (signalType !== TAG) return;
        const bot = global.bot;
        if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before a survey job ran.`);
        const job = payload.job || {};
        const home = require('@thinking/assessors/survey').home();
        if (!home) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): survey job ${job.id} ran with no home sited; the board posts none before.`);

        // Every trip says what it produced (accounting_lens): a look writes a page whatever it found; a trip for
        // material produced when its pocket came back with some.
        const finish = async ({ readable, produced }) => {
            watcher.summary(TAG, readable);
            watcher.summary(TAG, `JOB_RESULT produced=${produced}`);
            const capsule = payload[TAG] || (payload[TAG] = {});
            capsule.readable = readable;
            const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
            if (drop?.abandoned) return;
            return routeToJudge(TAG, { ...payload, readable });
        };

        if (job.what === 'sector') {
            // The same sector claim every frontier scan takes (sector_finder), so two bodies never
            // scan one sector together.
            const { claimFirst, releaseTarget } = require('@utils/target_claims');
            const walk = await claimFirst([job.sector], { keyOf: s => `sector:${s}` });
            if (!walk.pick) return finish({ readable: `sector ${job.sector} is already being scanned by a peer`, produced: false });
            const scanned = await finder.scanOne(bot, job.sector);
            releaseTarget(walk.keys);
            return finish({ readable: scanned, produced: true });
        }
        if (job.what === 'sector_tour') {
            const r = await finder.tour(bot, job.rings);
            return finish({ readable: `sector tour: ${r.scanned} sector(s) scanned; ${r.ended}`, produced: r.scanned > 0 });
        }
        if (job.what === 'portal_cast') return finish(await require('@action/lava_scoop').portalTrip(bot));
        if (job.what === 'lava_obsidian') return finish(await require('@action/lava_scoop').obsidianTrip(bot, job.want));
        if (job.what === 'stone_pierce') {
            const capsule = payload[TAG] || (payload[TAG] = {});
            const r = await require('@api/stone_pierce').pierce(bot, job.want, capsule.spent_columns || []);
            if (r.abandoned) return;   // the bank's transfer already routed to the judge (Law 15)
            capsule.spent_columns = r.spent;
            if (!r.refused) return finish({ readable: r.readable, produced: r.gained > 0 });
            return finish({ readable: `pierce refused (${r.refused})`, produced: false });
        }
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): survey job ${job.id} names what='${job.what}'; the survey does sector, sector_tour, portal_cast, lava_obsidian and stone_pierce.`);
    }),
};
