// assessor: base_sweep (the home base's ground)
// purpose: THE BASE KEPT CLEAN. While BASE_SWEEP.post_min or more litter lies on the base's ground (the rectangle
//          round every sited footprint, footprints excepted), one shared job is posted and one seat walks it
//          (base_sweep_executor). It is support work beside the build: the board offers it to one body at a time, the
//          rest keep to their own. The read is base_sweep_executor.litterIn — the walk's own read, so the job is offered
//          only while the walk would find something (Law 16). It is taken every BASE_SWEEP.scan_ms, not every sweep.

'use strict';

const watcher = require('@kernel/watcher');
const { JOB_TYPE, BASE_SWEEP } = require('@thinking/architect_config');

let _readAt = 0;
let _seen = { count: 0, nearest: null };

function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.entity) return { jobs };
    const now = Date.now();
    if (now - _readAt >= BASE_SWEEP.scan_ms) {
        _readAt = now;
        const { cells, area } = require('@action/base_sweep_executor').litterIn(bot);
        if (cells.length !== _seen.count) {
            watcher.summary('base_sweep', `BASE_LITTER count=${cells.length} was=${_seen.count} sited=${!!area}`
                + `${cells[0] ? ` nearest=${cells[0].name}@${cells[0].x},${cells[0].y},${cells[0].z}` : ''}`);
        }
        _seen = { count: cells.length, nearest: cells[0] || null };
    }
    if (_seen.count < BASE_SWEEP.post_min || !_seen.nearest) return { jobs };
    const n = _seen.nearest;
    jobs.push({
        id: 'base_sweep', type: 'base_sweep', what: 'litter',
        where: { x: n.x, y: n.y, z: n.z },
        why: `${_seen.count} litter on the base's ground (nearest ${n.name})`,
        job_type: JOB_TYPE.base_sweep, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'base_sweep', assess };
