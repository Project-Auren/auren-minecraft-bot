// assessor: wild_wool (wool off any sheep near the hive)
// purpose: SHEARING IS ONE TRADE WITH PENNING APART. Every wool the planned buildings still wait on (flock_colors.wantedWool:
//          the hive's beds and the large build's wool, counted off the world) is shorn off whatever sheep carries it. The
//          pen's shearing (assessors/ranching) ranks first on the board, so a penned sheep is preferred; this job shears
//          the wild ones beside it, pen or no pen, full or not, by one body at a time with the crew's shears from the chest
//          (shear_wild_executor).
//          THE SERVER SAYS WHERE THE WOOL IS: at most every WILD_WOOL.herd_ask_ms this body asks the server for the woolly
//          sheep of the owed color within WILD_WOOL.hive_blocks of the bot hive (askHerd). Those standing in a crew pen are
//          the pen's. The job is posted on the nearest of the rest, for the first owed color wild sheep grow
//          (WILD_WOOL.colors), while a pair of shears is in the pocket or the chests. A body that went out and found no
//          woolly wild sheep of that color leaves it WILD_WOOL.retry_ms before posting it again (its chair's
//          `wild_wool_none`, written by the executor).

'use strict';

const { JOB_TYPE, WILD_WOOL, WOOL_COLORS, BOT_HIVE } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'wild_wool';

// hiveOrigin() → the bot hive's locked origin { x, y, z }, or null while it is unsited: the ring's middle.
function hiveOrigin() {
    const o = require('@kernel/corporate_headquarters').readBuildingChair(BOT_HIVE, 'set_buildspot')?.transpose_origin;
    return o && typeof o.x === 'number' ? { x: o.x, y: o.y, z: o.z } : null;
}

// nearHive(p) → whether `p` stands within WILD_WOOL.hive_blocks (horizontal) of the hive's origin.
function nearHive(p, hive = hiveOrigin()) {
    return !!hive && Math.hypot(p.x - hive.x, p.z - hive.z) <= WILD_WOOL.hive_blocks;
}

// wildSheep(bot) → the sheep this body senses within the hive's ring that stand in no crew pen, nearest the body first.
function wildSheep(bot) {
    const { inCrewPen } = require('@api/pen_gate');
    const hive = hiveOrigin();
    if (!hive) return [];
    const at = bot.entity.position;
    return Object.values(bot.entities)
        .filter(e => e && e.name === 'sheep' && e.position && nearHive(e.position, hive) && !inCrewPen(e.position))
        .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
}

// askHerd(color) → [{ x, y, z }] the woolly sheep of `color` the server holds within the hive's ring, outside every crew
// pen, nearest the hive first; null when the server could not be asked or the hive is unsited. One rcon command.
async function askHerd(color) {
    const hive = hiveOrigin();
    const index = WOOL_COLORS.indexOf(color);
    if (!hive || index < 0) return null;
    const r = WILD_WOOL.hive_blocks;
    // The ring is a column of the world: a box round the origin, -64 to the build height, then the circle by hand.
    const box = `@e[type=minecraft:sheep,x=${hive.x - r},y=-64,z=${hive.z - r},dx=${2 * r},dy=384,dz=${2 * r},nbt={Sheared:0b,Color:${index}b},limit=${WILD_WOOL.ask_most * 4}]`;
    const asked = await guardExternal(TAG, `ask the server for woolly ${color} sheep round the hive`,
        () => require('@utils/rcon_link').once([`execute as ${box} run data get entity @s Pos`]));
    if (!asked.ok) return null;
    const body = (asked.value || []).map(x => x && x.body).join(' ');
    const { inCrewPen } = require('@api/pen_gate');
    const out = [];
    for (const m of body.matchAll(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/g)) {
        const p = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
        if (nearHive(p, hive) && !inCrewPen(p)) out.push(p);
    }
    return out.sort((a, b) => Math.hypot(a.x - hive.x, a.z - hive.z) - Math.hypot(b.x - hive.x, b.z - hive.z));
}

// This body's last answer from the server, kept WILD_WOOL.herd_ask_ms: { color, at, sheep }.
let _herd = null;

async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot?.entity?.position || !hiveOrigin()) return { jobs };
    const owed = require('@api/flock_colors').wantedWool(bot);
    const color = Object.keys(owed).find(c => WILD_WOOL.colors.includes(c));
    if (!color) return { jobs };
    const botId = process.env.BOT_ID || 'default';
    const none = require('@kernel/corporate_headquarters').readBoardroomChair(botId, {})?.wild_wool_none;
    if (none && none.color === color && Date.now() - none.at < WILD_WOOL.retry_ms) return { jobs };
    const shears = bot.inventory.items().some(i => i.name === 'shears') || require('@perception/chest_ledger').unclaimedOf(['shears']) > 0;
    if (!shears) return { jobs };
    if (!_herd || _herd.color !== color || Date.now() - _herd.at >= WILD_WOOL.herd_ask_ms) {
        const sheep = await askHerd(color);
        if (sheep === null) return { jobs };
        _herd = { color, at: Date.now(), sheep };
    }
    if (!_herd.sheep.length) return { jobs };
    const at = bot.entity.position;
    const nearest = _herd.sheep.slice().sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
    jobs.push({
        id: 'shear_wild', type: 'shear_wild', what: `${color}_wool`,
        where: { x: Math.floor(nearest.x), y: Math.floor(nearest.y), z: Math.floor(nearest.z) },
        why: `${owed[color]} ${color} wool owed; the server holds ${_herd.sheep.length} woolly ${color} wild sheep within ${WILD_WOOL.hive_blocks} blocks of the hive`,
        job_type: JOB_TYPE.shear_wild, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'wild_wool', assess, wildSheep, nearHive };
