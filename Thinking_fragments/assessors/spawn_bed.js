// assessor: spawn_bed (the crew's one spawn bed, in the hive's lobby)
// purpose: ONCE THE HIVE'S BED STANDS, EVERY BODY REGISTERS AT IT. A body whose registration does not name the standing
//          bed posts its own spawn_register job; the job table puts it with the preconditions, ahead of all work, so the
//          crew registers the moment the bed is placed. The bed and the registration are bed_rest's to read.
//          WHILE THE SERVER SPAWNS PHANTOMS, a body near the bed that has not lain down for a day posts phantom_rest: one
//          seat crew-wide (the bed holds one), in the bot band (bed_rest.needsRest, architect_config PHANTOM_REST).

'use strict';

const { JOB_TYPE } = require('@thinking/architect_config');

function assess() {
    const jobs = [];
    if (!global.bot) return { jobs };
    const bedRest = require('@api/bed_rest');
    const tired = bedRest.needsRest(global.bot);
    if (tired) {
        jobs.push({
            id: 'phantom_rest', type: 'phantom_rest', what: 'phantom_rest',
            where: { x: tired.head.x, y: tired.head.y, z: tired.head.z },
            why: `phantoms spawn and this body has not lain down for a day; ${tired.id} stands near`,
            job_type: JOB_TYPE.phantom_rest, scope: 'shared', claimed_by: null,
        });
    }
    const bed = bedRest.needsRegistration(global.bot);
    if (!bed) return { jobs };
    jobs.push({
        id: 'spawn_register', type: 'spawn_bed', what: 'spawn_bed',
        where: { x: bed.head.x, y: bed.head.y, z: bed.head.z },
        why: `${bed.id} stands and this body's spawn is not set there`,
        job_type: JOB_TYPE.spawn_register, scope: 'local', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'spawn_bed', assess };
