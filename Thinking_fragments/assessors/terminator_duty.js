// assessor: terminator_duty (the crew's full-time terminator seat, T-1)
// purpose: A TERMINATOR IS A JOB, NOT A NAME IN A CONFIG. While the world spawns monsters and the crew holds fewer terminators
//          than its seats (architect_config.TERMINATOR_SEATS), a bot that could hold the T-1 kit's floor posts terminator_duty:
//          one seat crew-wide, last in the bot band and held while any other kit row of it is posted for the body (job_gates
//          seatGate), so the body's tools, equipment and trash for pillaring come first; ahead of every chest and building job
//          (architect_config JOB_TYPES). The body
//          that takes it is designated T-1 for good (action_fragments.js/terminator_duty_executor) and plans through the
//          terminator's own planner from then on, until it steps down.
//          THE STEP UP IS THE STEP DOWN READ THE OTHER WAY: the job is posted only while every part of the floor the body lacks
//          can come from the chests (terminator_planner.floorUnmet), the same reading that steps a terminator down when it
//          cannot. A peaceful world spawns no monster, so the seat is never posted there.
//          The seats are counted off the bodies' chairs (combat_board.crewTerminators); this body's own chair is put right
//          each sweep, so a chair left saying T after a restart does not hold a seat.

'use strict';

const { JOB_TYPE, TERMINATOR_SEATS, isPeacefulWorld } = require('@thinking/architect_config');

const KIT = 'T-1';

function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.entity) return { jobs };
    const board = require('@api/combat_board');
    board.publishDesignation();
    if (board.isTerminator() || isPeacefulWorld()) return { jobs };
    const held = board.crewTerminators();
    if (held.length >= TERMINATOR_SEATS) return { jobs };
    const unmet = require('@action/terminator_planner').floorUnmet(bot, KIT);
    if (unmet.length) return { jobs };
    const p = bot.entity.position;
    jobs.push({
        id: 'terminator_duty', type: 'terminator_duty', what: 'terminator_duty',
        where: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
        why: `the crew holds ${held.length} of ${TERMINATOR_SEATS} terminator seat(s) and this body can hold the ${KIT} kit's floor`,
        job_type: JOB_TYPE.terminator_duty, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'terminator_duty', assess };
