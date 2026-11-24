// architect_config — every tunable that shapes fleet behaviour, in one place. Pure data: no logic, no
// side effects. Edit a number to change what the bot does.

'use strict';

// Y below which the world does not exist for the fleet: unroutable, undiggable, no drops. null = off.
// A body already below it is exempt from the floor. It lifts for a body whose deep shaft is open (terrain_predicates.openDepthFloor).
const WORLD_DEPTH_FLOOR_Y = 0;

// Half-width of the Chebyshev square around WORLD SPAWN where no block may be broken or placed. 0 = off.
// fleet_control writes this into server.properties as `spawn-protection`, so one value authors both sides.
const SPAWN_PROTECTION_RADIUS = 16;

// How far from WORLD SPAWN the foreman must land before it sites a base and raises a crew, and how far every sited
// column of the base (footprint, pad, stand, light) keeps from it (footprint_survey.readSurface). Chebyshev, same shape.
const BASE_CLEAR_OF_SPAWN = 50;

// The protocol the fleet speaks and the block registry it answers questions from. The ceiling is the
// newest version minecraft-protocol and mineflayer both carry, NOT Mojang's newest release; preflight's
// "Version ceiling" pass reads both libraries and tells you when this stops being the answer.
const SERVER_MINECRAFT_VERSION = process.env.AUREN_MINECRAFT_VERSION || '26.1';

// Where a body connects. Re-exported from foreman_config, which is the page a stranger edits.
const SERVER_ENDPOINT = require('../foreman_config');

// Fleet pecking order for peer tiebreaks — lower = elder. THIS TABLE IS THE ROSTER: fleet_control and the
// camera launcher both derive their bot list from these keys, so adding a bot is one edit here.
const BOT_SENIORITY = {
    AurenBot: 1,
    TessaBot: 2,
    IrisBot:  3,
    VesperBot: 4,
    KoaBot: 5,
    NicoBot: 6,
    EmberBot: 7,
    LumiBot: 8,
    PascalBot: 9,
    FaroBot: 10,
    RemiBot: 11,
    DanteBot: 12,
    LyraBot: 13,
    NevinBot: 14,
    VedaBot: 15,
    CorinBot: 16,
    MarnoBot: 17,
    XylarBot: 18,
    ThalonBot: 19,
    ZarekBot: 20,
};

// ── THE JOB-TYPE TABLE ────────────────────────────────────────────────────────────────────────────
// Row: { key, stage }. BAND ORDER IS AUTHORED HERE — selectBand returns the first non-empty band.
//   preconditions — survival and one-time locks; every member declares stage null.
//   bot           — the BODY on its own behalf.
//   chest         — shelf levels.
//   blueprint     — a building's bill; every declared stage is a PLACEMENT.
// Every job finishes: work a structure needs is asked for by the structure (compost_gather for the bone meal
// the field is short of), never posted standing in a band of its own.
const JOB_TYPES = [
    ['preconditions', [
        { key: 'respawn_recover',        stage: null },
        // TEMPORARY: a body in running water plans only its way out (assessors/current).
        { key: 'leave_current',          stage: null },
        { key: 'eat_food',               stage: null },
        // Every body registers its spawn at the crew's bedroom bed the moment it stands (assessors/spawn_bed, bed_rest).
        { key: 'spawn_register',         stage: null },
        { key: 'ground_salvage',         stage: null },
        // A tender stands at the pen and opens the gate on nothing less than a shepherd holding the flock (assessors/ranching).
        { key: 'shepherd_pen',           stage: null },
    ]],

    ['bot', [
        // A moment's lie-down in the spawn bed against phantoms, while the server spawns them (bed_rest PHANTOM_REST). It has
        // no material to measure, so its stage is declared: work done at the base, like a craft.
        { key: 'phantom_rest',           stage: 'craft' },
        // The carried crafting table, ahead of every tool: none of them is made without a table (craft_handler THE CARRIED TABLE).
        'crafting_station',
        // No bootstrap barrel row: the barrel is a BLUEPRINT row, placed where the foreman sited it.
        'resource_pillaring_stock',
        'crafting_tool_bootstrap',
        'resource_baseline',
        'crafting_weapon',
        'crafting_defense',
        'crafting_tool',
        'crafting_flat',
        // THE CREW'S TERMINATOR SEAT, LAST IN THE BAND AND AHEAD OF EVERY CHEST AND BUILDING JOB: posted while the crew holds
        // fewer terminators than TERMINATOR_SEATS and this body can hold the T-1 kit's floor from the chests
        // (assessors/terminator_duty), and held while any other kit row of this band is posted for the body (job_gates
        // seatGate): its tools, its equipment and its trash for pillaring come first. The body that takes it plans as a
        // terminator from then on (terminator_duty_executor).
        { key: 'terminator_duty',        stage: 'gather' },
    ]],

    // ── CHEST OUTRANKS BLUEPRINT: bot, chest, building ────────────────────────────────────────────
    // The shelf is the fleet's TOOL SHOP.
    ['chest', [
        // The chests' own upkeep, first in the band: every other chest job needs a free slot to finish in.
        { key: 'chest_housekeeping',     stage: 'craft' },
        // The standing home's fixtures joining the pool (assessors/home_stations).
        { key: 'home_stations',          stage: 'craft' },
        { key: 'furnace_collect',        stage: 'craft' },
        { key: 'furnace_load',           stage: 'craft' },
        // Banked compostables into the composter, one batch per COMPOST_BATCH_MIN (assessors/compost).
        { key: 'compost_feed',           stage: 'craft' },
        // A forest run for the composter while the bone_meal row is short and no bone is held (assessors/compost).
        { key: 'compost_gather',         stage: 'gather' },
        // The base's ground swept of litter by one seat while litter lies there (assessors/base_sweep).
        { key: 'base_sweep',             stage: 'gather' },
        // Water poured on a lava pool the tunnels logged, and the obsidian it makes mined (assessors/mining, obsidian_pour).
        // A chest order ahead of the rest of the band: posted only to the body carrying the diamond pickaxe, one seat, and a
        // draw among the tunnel seats would reach it about one trip in sixty.
        { key: 'mining_obsidian',           stage: 'gather', ahead_of_sites: true },
        // One seat walks the sectors round home in one trip (assessors/survey). Ahead of the draw, so it is taken once a body's bot band is done.
        { key: 'survey_tour',               stage: 'gather', ahead_of_sites: true },
        // One body's trip to surface lava: buckets scooped, cast at natural water, mined (assessors/mining, lava_scoop).
        { key: 'survey_lava',               stage: 'gather', ahead_of_sites: true },
        // One body's trip with lava to the portal's mould, the frame cast and lit (assessors/survey, lava_scoop).
        { key: 'survey_portal',             stage: 'gather', ahead_of_sites: true },
        // Banked farm saplings planted in the tree farm while it holds too few trees (assessors/tree_farm).
        { key: 'sapling_plant',          stage: 'gather' },
        // THE WHEAT FARMER'S VISIT, the wheat row's one source: posted only while the chests are short of the row
        // (assessors/farming). A field not yet built yields the bootstrap wheat; a built one is built, sown, bone-mealed and
        // harvested as on any visit (farm_manager). The cane fields stay farm_tend.
        { key: 'farm_wheat',             stage: 'gather' },
        'resource_standing_stock',
        'resource_chest_restock',
    ]],

    ['blueprint', [
        // A STANDING SUPPORT'S BROKEN BLOCKS, FIRST OF ALL BUILDING WORK: a few per body, so the crew swarms the damage
        // (assessors/downloaded_build SUPPORT UPKEEP, support_repair_executor). Building work, so it ranks in the building
        // band like the rest, at its head (job_ranking.measureSiteRank: ahead of every site and of the ahead_of_sites work). The lobby never closes and the upper floors are extra
        // storage, so the crew's working stock stays in the headframe and the lobby while a floor is closed.
        { key: 'support_repair',            stage: 'build' },
        // THE SHAFT'S TORCH VISIT, AHEAD OF EVERY SITE: it lights the way down for the whole crew rather than one
        // building, so the site walk does not order it (job_ranking, `ahead_of_sites`). It is posted only while a
        // torch is held or the fuel to make one is banked (assessors/lighting).
        { key: 'light_network',             stage: 'build', ahead_of_sites: true },
        // One armed body stands by a spawn-proofing worker through the night (assessors/tandem). Ahead of the sites: the
        // worker's night gate opens only on its duty.
        { key: 'tandem_guard',              stage: 'build', ahead_of_sites: true },
        // The survey (assessors/survey): the home sector's scan first, gating nothing; a furnace's stone open to
        // the sky while the shaft is dug.
        { key: 'survey_sector',            stage: 'gather' },
        { key: 'survey_stone',             stage: 'gather' },
        { key: 'building_headframe',        stage: 'build' },
        'building_headframe_supply',
        'building_structure_supply',
        // A downloaded building's ladder (assessors/downloaded_build): trees, then anchors bottom-up.
        // Blueprint band because they BLOCK a structure.
        { key: 'site_clear_trees',          stage: 'gather' },
        { key: 'site_column',               stage: 'build' },
        'site_supply',
        'farm_supply_seeds',
        'farm_supply_dirt',
        { key: 'farm_tend',                 stage: 'build' },
        // One bringer at a time while the crew's pen lacks animals and wheat lasts (assessors/ranching).
        { key: 'herd_animal',               stage: 'gather' },
        // The pen's woolly flock shorn by a body near it, the fleet's shears taken from the chest and put back (assessors/ranching).
        { key: 'shear_animal',              stage: 'gather' },
        // A full meat pen's grown animals past its breeding stock slaughtered for meat and hide (assessors/ranching).
        { key: 'cull_animal',               stage: 'gather' },
        // The wool still owed shorn off wild sheep near the hive, pen or no pen (assessors/wild_wool, WILD_WOOL).
        { key: 'shear_wild',                stage: 'gather' },
        // The pen's wheat past the herd's feeds one pair the server says can breed (assessors/ranching).
        { key: 'breed_animal',              stage: 'craft' },
        // The pen's white animals dyed to the colors the building's wool asks for, in proportion (assessors/ranching).
        { key: 'dye_animal',                stage: 'craft' },
        { key: 'building_structure',        stage: 'build' },
        { key: 'mining_dig_shaft',          stage: 'gather' },
        // A tunnel seat is pulled, never ranked: it is posted only while an order is short of something
        // underground, and job_ranking places it at that order's band and site (`pulled_by`). This row
        // only makes the key known; its band here decides nothing.
        { key: 'mining_dig_cell',           stage: 'gather' },
        // ── THE FURNACE'S INPUT RANKS WITH WHAT WANTED THE SMELT ──────────────────────────────────
        // The charcoal is the building's, a fleet total — not a per-body bot-band row.
        'smelt_input_supply',
    ]],
];

// Index IS the order — the only place the ladder's direction exists.
const STAGES = Object.freeze(['build', 'craft', 'gather']);
const STAGE_INDEX = Object.freeze(Object.fromEntries(STAGES.map((s, i) => [s, i])));

// JOB_TYPE maps a key to ITSELF, never a number, so a misspelt member gets a load-time throw.
const JOB_TYPE = {};
const JOB_CATEGORY_OF = {};   // key → the asker it serves; authored, and nothing moves a job out of it
const JOB_STAGE_OF = {};      // key → declared stage; ABSENT means "measure it"; null means pre-band
const JOB_AHEAD_OF_SITES = new Set();   // keys ranked ahead of the site walk within their band (job_ranking)
const CATEGORY_NAMES = Object.freeze(JOB_TYPES.map(([category]) => category));
const PRE_BAND = CATEGORY_NAMES[0];
const CATEGORY_INDEX = Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((c, i) => [c, i])));
// The pre-band's members are an ORDERED LIST OF BANDS: a dead bot must respawn before it eats.
const PRE_BAND_MEMBERS = Object.freeze(JOB_TYPES[0][1].map(m => (typeof m === 'string' ? m : m.key)));

// ── WHAT A BAND MEANS ONCE THE ORDER IS DECIDED ───────────────────────────────────────────────────
// `level_against` — the shelf the among-equals tie-break (dispatcher) levels against. Chest and
// blueprint level against the shelf (fleet totals); every other band levels against the pocket.
// `goal` — whether this order's number is the fleet's or this body's:
//   'fleet'     a total (shelf level, building's bill) — a pledge against it is true.
//   'per_body'  each body's own (kit, hunger, death) — no pledge is read.
const BAND_POLICY = Object.freeze({
    preconditions: { level_against: 'pocket',             goal: 'per_body' },
    bot:           { level_against: 'pocket',             goal: 'per_body' },
    chest:         { level_against: 'storage',            goal: 'fleet' },
    blueprint:     { level_against: 'pocket_and_storage', goal: 'fleet' },
});
const BAND_GOALS = Object.freeze(['fleet', 'per_body']);

// Every band must have a policy naming a real band (Law 13).
for (const band of CATEGORY_NAMES) {
    if (!BAND_POLICY[band]) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): band '${band}' is in JOB_TYPES but has `
            + `no BAND_POLICY entry. Every band must declare which shelf its tie-break levels against.`);
    }
}
for (const band of Object.keys(BAND_POLICY)) {
    if (!CATEGORY_NAMES.includes(band)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): BAND_POLICY names '${band}', which is `
            + `not a band in JOB_TYPES (${CATEGORY_NAMES.join(' | ')}). A policy for a band that does not `
            + `exist governs nothing and reads as if it did.`);
    }
    if (!BAND_GOALS.includes(BAND_POLICY[band].goal)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): BAND_POLICY['${band}'].goal is `
            + `${JSON.stringify(BAND_POLICY[band].goal)}, which must be one of ${BAND_GOALS.join(' | ')}. `
            + `Undeclared, the pledge mechanism would have to guess whether this band's quantities are `
            + `fleet totals or per-body ones, and guessing wrong on 'per_body' sends bodies out bare.`);
    }
}

// No tiebreak beyond (band, rung) is computed here — equal jobs are picked at random; dependencies are gates.
for (const [category, members] of JOB_TYPES) {
    for (const member of members) {
        const key    = typeof member === 'string' ? member : member.key;
        const stage  = typeof member === 'string' ? undefined : member.stage;
        if (JOB_TYPE[key] !== undefined) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES lists "${key}" twice — one job type, one identity (Law 16).`);
        }
        if (stage !== undefined && stage !== null && !STAGES.includes(stage)) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES member "${key}" declares stage '${stage}', `
                + `which is not one of ${STAGES.join('/')}.`);
        }
        if (category === PRE_BAND && stage !== null) {
            throw new Error(`CODING VIOLATION (Law 13): pre-band member "${key}" must declare \`stage: null\` — `
                + 'the pre-band ranks conditions of being able to serve any asker, and a stage is meaningless for work that produces nothing.');
        }
        if (category !== PRE_BAND && stage === null) {
            throw new Error(`CODING VIOLATION (Law 13): "${key}" is in category '${category}' and declares \`stage: null\`, `
                + 'which only the pre-band may do. Give it a stage, or omit `stage` to have the board measure it.');
        }
        JOB_TYPE[key]        = key;
        JOB_CATEGORY_OF[key] = category;
        if (stage !== undefined) JOB_STAGE_OF[key] = stage;
        if (typeof member !== 'string' && member.ahead_of_sites === true) JOB_AHEAD_OF_SITES.add(key);
    }
}

// NO SLOT ARITHMETIC, NO COMPOSED INTEGER, NO DECODER.

// ── DAY / NIGHT GATING ─────────────────────────────────────────────────────────────────────────────
// Vanilla clock: 0 = dawn, 12000 = dusk, 24000 = next dawn; the gate closes at dusk.
const NIGHT_STARTS_AT = 12000;
const NIGHT_ENDS_AT   = 23000;

// PEACEFUL HAS NO NIGHT — no monsters, so no night gate and the bodies keep working.
function isPeacefulWorld() {
    const d = global.bot && global.bot.game ? global.bot.game.difficulty : null;
    return d === 'peaceful';
}

function isNightTime() {
    const tod = global.bot && global.bot.time ? global.bot.time.timeOfDay : null;
    if (tod == null) return false;
    if (isPeacefulWorld()) return false;
    return tod >= NIGHT_STARTS_AT && tod < NIGHT_ENDS_AT;
}

// DUSK IS THE LAST STRETCH OF DAY, DUSK_LEAD_TICKS before night: 2 minutes of game time at 20 ticks a second. In it
// no job that would be out at night is started, and a running one stops at its next natural boundary (job_gates).
const DUSK_LEAD_TICKS = 2400;
function isDuskTime() {
    const tod = global.bot && global.bot.time ? global.bot.time.timeOfDay : null;
    if (tod == null) return false;
    if (isPeacefulWorld()) return false;
    return tod >= NIGHT_STARTS_AT - DUSK_LEAD_TICKS && tod < NIGHT_STARTS_AT;
}


// Build steps in order (order field = priority); tokens shared with job_board's assessors/building.
const TYPE_COORDINATES        = 'coordinates';
const TYPE_BLUEPRINT_PASTED   = 'blueprint_pasted';
const TYPE_STRUCTURE_COMPLETE = 'structure_complete';

// A `condition` token gates a requirement until it holds (job_board.conditionMet).
const BUILDING_REQUIREMENTS = [
    // The portal's mould stands in the base once the run's main build is finished (MAIN_BUILD: the large build when one
    // is named, else the bot hive).
    { field: 'lava_portal_mould', type: TYPE_COORDINATES,        order: 90, condition: 'main_build_complete' },
    { field: 'lava_portal_mould', type: TYPE_BLUEPRINT_PASTED,   order: 91, condition: 'main_build_complete' },
    // Built like every base structure, by preconstruction (building_manager RECIPES); the survey then casts and lights it.
    { field: 'lava_portal_mould', type: TYPE_STRUCTURE_COMPLETE, order: 92, condition: 'main_build_complete', execute_key: 'lava_portal_mould_execute' },
    // A crew's waste pit (WASTE_PIT below), sited by the foreman beside its home, is the first structure built: it is
    // a few blocks of digging and needs no material, so it is done in seconds by one body while the rest gather for
    // the alpha. Rows of one order are taken in table order, so its build comes before the headframe's.
    { field: 'waste_pit', type: TYPE_COORDINATES,        order: 0 },
    { field: 'waste_pit', type: TYPE_BLUEPRINT_PASTED,   order: 1 },
    { field: 'waste_pit', type: TYPE_STRUCTURE_COMPLETE, order: 2, execute_key: 'waste_pit_execute' },
    { field: 'headframe', type: TYPE_COORDINATES,        order: 0 },
    { field: 'headframe', type: TYPE_BLUEPRINT_PASTED,   order: 1 },
    { field: 'headframe', type: TYPE_STRUCTURE_COMPLETE, order: 2, execute_key: 'headframe_execute',
      job_type: 'building_headframe', supply_job_type: 'building_headframe_supply' },
    // The rows after the alpha structure's are its supports: once the alpha stands, every one still owing work posts its
    // build at once (assessors/building `front`), ranked by STRUCTURE_PRIORITY.
    // The base's spawn proofing (SPAWN_PROOFING below): the torch posts over the ground round its structures, painted
    // when the base is sited and generated from that paint (base_layout.proofingBuilding). Its torches are what open the
    // night gate for work on the base's ground (job_gates 'lit', lighting_integrity.litAtNight), so every structure
    // beside it builds through the night once they stand.
    { field: 'spawn_proofing', type: TYPE_COORDINATES,        order: 6 },
    { field: 'spawn_proofing', type: TYPE_BLUEPRINT_PASTED,   order: 7 },
    { field: 'spawn_proofing', type: TYPE_STRUCTURE_COMPLETE, order: 8, execute_key: 'spawn_proofing_execute' },
    // The animal pens (FARM_PENS below), sited by the foreman beside the wheat field. After the home, whose
    // crafting table makes their fences and gates.
    { field: 'sheep_pen', type: TYPE_COORDINATES,        order: 6 },
    { field: 'sheep_pen', type: TYPE_BLUEPRINT_PASTED,   order: 7 },
    { field: 'sheep_pen', type: TYPE_STRUCTURE_COMPLETE, order: 8, execute_key: 'sheep_pen_execute' },
    { field: 'cow_pen',   type: TYPE_COORDINATES,        order: 6 },
    { field: 'cow_pen',   type: TYPE_BLUEPRINT_PASTED,   order: 7 },
    { field: 'cow_pen',   type: TYPE_STRUCTURE_COMPLETE, order: 8, execute_key: 'cow_pen_execute' },
];

// Every stock the fleet maintains, in bot pockets or in shared storage. Fields:
//   item              what is held (an item name or an object-group name)
//   holder            'bot' | 'storage' — which layer holds it, never which chest
//   deficit_below     restock when held drops under this; absent = hold-only
//   fill_to           a storage row's restock fills back up to this; absent = deficit_below
//   dump_threshold    how much survives a dump; required on every row
//   mode              'active' (shortfall drives acquisition) | 'passive' (filled from what exists)
//   kind: 'tool'      the row names a tool FAMILY; min_tier / max_tier bound the tier made
//   spare_mode        a tool row's mode for the tools past the first; absent = 'passive'
//   stone_level       a tool row is satisfied by this many stone-or-better tools in place of deficit_below
//   job_type          post under this job type instead of the branch default
//   after_fulfilled   do not order until the named row is satisfied
//   per_crew          a bot row the whole crew keeps this many of, not one a body: the first bodies to make it carry
//                     them and the rest ask for none (requested_work.activeStockRows); a for_kit row counts it so too
//   surplus_to        a storage row's push side: past deficit_below, while its material lies spare in the chests (past what the
//                     kit, the building and the structures owe), one more is made, up to this (a count, or 'crew': one a body)
//                     (requested_work.surplusStock). deficit_below is the pull side: the minimum, gathered for
//   for_kit           a storage row holding the material of these bot-row items for every body still short of one;
//                     its deficit_below is worked out each pass and its dump_threshold raised to it (requested_work.kitStock)
//   reserve           a for_kit row's standing shelf, kept past the kit: added to the worked-out deficit_below
// ── THE CREW: ONE KIND OF BOT, ONE BASE ───────────────────────────────────────────────────────────────────────
// Every bot is the same crew. It raises the headframe first as its bootstrap, then the base round it with the bot hive
// among its supports, and a large build last when the run names one.
// The difficulty decides what turns on monsters (CREW_DIFFICULTY below): the night gate (bot_mandate.fearsTheNight),
// the wheat the crew eats and the base's spawn proofing (support_need). The world differs by itself: on peaceful
// hunger never falls, so no body eats, and no monster spawns, so no body fights one; the eating and the fighting stand
// ready all the same.
//   ALPHA_STRUCTURE     the structure raised before any other; it opens STRUCTURE_PRIORITY, and its chests are the home
//   SHAFT_HEAD          the structure the shallow shaft hangs from
//   CREW_DIFFICULTY     the server difficulty the crew works on (the foreman writes it; bot_mandate.fearsTheNight reads it)
//   LARGE_BUILD         the large build foreman_config names (BUILDS, not the hive), or null: it stands apart from the base
//                       and is built last
//   PLANNED_BUILD       the bot hive: a support every base raises, on the column machine with its own plan slot
//   PLANNED_BUILDS      every building on the column machine (downloaded_plan_registry.of, one plan each): the hive,
//                       then the large build, which posts nothing until the hive stands (assessors/downloaded_build)
//   MAIN_BUILD          the build `ends built` waits for and the portal's mould follows: the large build, else the hive
//   STRUCTURE_PRIORITY  every structure the crew raises, alpha first and the large build last
//   ALPHA_PHASE         THE BUILD PHASES: which building's orders are gathered, crafted and smelted first. Phase 0 is the
//                       bodies' own (the bot band, ahead of every building). Phase 1, the alpha phase, opens
//                       STRUCTURE_PRIORITY, ranked in order: the headframe, the waste pit and the shallow shaft (the
//                       mine's shaft, not its cells). Phase 2 is every SUPPORT after it but the large build (the hive, the
//                       pens, the fields, the proofing), all ranked equal; phase 3 is the large build
//                       (job_ranking.measureSiteRank). A phase prefers its orders and never refuses a later phase's work
// The fields, the pens and the tree farm (FARM_FIELD, FARM_PENS, TREE_FARM) each stand in the priority. Until the mine is
// open, the headframe's stone and the first furnaces' are pierced from one column at a time (STONE_PIERCE); every
// other building's stone comes from the strip mine once it is dug and lit, and from nowhere else.
// CREW is the crew's name in every memory partition: the crew half of a building room key (bot_mandate.buildingRoomKey),
// the station registry's keys and the foreman's crew memory.
const CREW = 'crew';
// ── THE HIVES: A SHELTER BUILT OF FLOORS, NOT ONE FIXED BLUEPRINT (js_kernel/hive_stack) ─────────────────────────────
// Each hive is a recipe over the floors in building_blueprints.json's `floors` section (edited in Structure Studio's floor
// designer). Read bottom first:
//   shelter     the floors raised first: the bot hive's is its ground lobby alone
//   expansions  raised on top of the shelter in this order, each when its need calls for it. The needs are not hooked in yet.
//   grows       true: the last expansion repeats, so the hive keeps growing upward the way comb is added for surplus
//               honey; false: the hive stops at its last expansion
//   roof        the cap over the top floor, lifted and set again on each expansion
//   phase       how far a crew raises the hive at the start of a run: 1 the shelter, n the shelter and n-1 expansions.
//               Growing a hive that already stands (lift the roof, build, roof again) is not built yet.
//   beds        a number: that many beds, the first of the floors' beds, up to the room's capacity; 'all': every bed the floors hold.
//               The bot hive's one bed is the lobby's, in its open middle: the crew's spawn bed, which every body
//               registers at (bed_rest). Any number of players share one bed.
//   enchanting  false builds an enchanting table and bookshelves as planks
// Every hive here shares the 10 x 15 shell, stairs and roof, so the towers look alike outside and differ inside.
const HIVES = Object.freeze({
    bot_hive: Object.freeze({
        title: 'Bot hive',
        shelter: Object.freeze(['bot_hive_lobby']),
        // Storage only: the crew's work is many bodies with plain tools, not one body at endgame gear, so a stations floor
        // for enchanting is not raised (bot_hive_stations stays in the blueprints, unused). The hive grows storage floor
        // on storage floor.
        expansions: Object.freeze([
            Object.freeze({ title: 'Storage', floors: Object.freeze(['bot_hive_storage']) }),
        ]),
        // Phase 1: the lobby and the roof. 1: the lobby's one bed.
        roof: 'hive_roof', grows: true, phase: 1, beds: 1, enchanting: false,
    }),
});
// The bot hive is a support of every base: the crew's shelter, beds and stations, sited nearest the headframe (HIVE_SITING).
const BOT_HIVE = 'bot_hive';
// The home's blocks with a window the station registry proves and pools (station_registry.WINDOW_TYPE_VALIDATORS).
const HOME_FIXTURES = Object.freeze(['barrel', 'furnace', 'crafting_table']);
// The headframe is the bootstrap: the crew's home and the structure its shallow shaft hangs from.
const ALPHA_STRUCTURE = 'headframe';
const SHAFT_HEAD = 'headframe';
// The layout sites the home from where the body stands, on ground its shaft descends through (lock_all_buildspots).
if (SHAFT_HEAD !== ALPHA_STRUCTURE) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): the shallow shaft hangs from '${SHAFT_HEAD}', not the home `
        + `'${ALPHA_STRUCTURE}'; the base is sited round a home its shaft hangs from (lock_all_buildspots.siteHomeFromBody).`);
}
// The difficulty foreman_config gives the run; the foreman writes it into server.properties (utils/server_settings).
const DIFFICULTIES = Object.freeze(['peaceful', 'normal', 'hard']);
const CREW_DIFFICULTY = require('../foreman_config').difficulty;
if (!DIFFICULTIES.includes(CREW_DIFFICULTY)) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): foreman_config.difficulty is '${CREW_DIFFICULTY}'; `
        + `it is one of ${DIFFICULTIES.map(d => `'${d}'`).join(' | ')} (environment override AUREN_DIFFICULTY).`);
}
// The run's large build (BUILDS below), or null when foreman_config names none.
const LARGE_BUILD = require('../foreman_config').build || null;
// PLANNED_BUILD is the bot hive, a support every base raises on the column machine; PLANNED_BUILDS is every building on
// that machine, the hive first and the large build after it (assessors/downloaded_build: supports first).
const PLANNED_BUILD = BOT_HIVE;
const PLANNED_BUILDS = Object.freeze(LARGE_BUILD ? [BOT_HIVE, LARGE_BUILD] : [BOT_HIVE]);
const MAIN_BUILD = LARGE_BUILD || BOT_HIVE;
// ── A STANDING SUPPORT IS MENDED BY A SWARM ──────────────────────────────────────────────────────────────
// A building that has stood once is latched standing (downloaded_plan_registry.stood). The large build is then done.
// A support (PLANNED_BUILD) is kept: its broken cells are posted as repair jobs, lowest first, so many bodies carry a
// few blocks each. A job's load spreads the open cells over the crew, one job per body, between `least` and `most`
// cells: a job's time is mostly its trip to the chests, so a body places its share in one trip instead of two, and small
// damage still fans out. `posted` caps the jobs one sweep posts.
const SUPPORT_REPAIR = Object.freeze({ least: 2, most: 6, posted: 16 });

// LEAF_PAIRS — the pairs of shears the fleet keeps for leaves, kept only while a planned building has leaves
// (requested_work.leafStock). One leaf seat per pair (harvest_executor), so this many bodies cut leaves at once and the
// leaf order is offered in this many seats (assessors/downloaded_build). The kit's shears row keeps these and one more
// for shearing sheep.
const LEAF_PAIRS = 1;

// ── THE ONE KIT: EVERY CREW CARRIES AND BANKS THE SAME ROWS ───────────────────────────────────────────────────
// Saplings and leaf litter are banked and composted into bone meal (assessors/compost) for the wheat field; the waste
// pit takes the rest of the trash; the chests are kept tidy (assessors/housekeeping). A blueprint's own requests are
// its bill; these are the rows every base keeps whatever it builds.
const ARMOR_SETS = 2;
// One guard stands by one worker through the night (assessors/tandem, combat_board): at most this many pairs at once.
const TANDEM_PAIRS = 3;

const STOCK_THRESHOLDS = Object.freeze([
    // ── A TOOL ROW NAMES THE TIERS IT ACCEPTS, IN ORDER (`tiers`) ─────────────────────────────────────
    // A body short of a tool walks the row's `tiers` and takes the first it can have (assessors/shared.kitTier):
    //   'copper' — crafted when the recipe's ingots are banked past what the building and the structures still ask for:
    //              a building's copper is its own, and the mine's pickaxes once spent more than the castle was short.
    //              It replaces a stone tool that wore out, and a stone tool on the shelf goes first;
    //   'stone'  — crafted when cobblestone is held or banked;
    //   'wooden' — crafted from planks.
    // A row whose tiers it can have none of posts nothing, and the body works with what it holds — for the
    // shovel that is its fists. `countInInventory` counts the family. `max_tier` still bounds what an UPGRADE
    // may craft. The mine is entered with the pickaxe row's `deficit_below` in the pocket
    // (mining_manager.canEnterMine), and the body digs the set down to MINING_LAST_PICKAXE before surfacing.
    { item: 'pickaxe',        holder: 'bot', kind: 'tool', tiers: ['copper', 'stone', 'wooden'], deficit_below: 3, dump_threshold: 3, max_tier: 'wooden', mode: 'active', spare_mode: 'active', stone_level: 3 },
    { item: 'axe',            holder: 'bot', kind: 'tool', tiers: ['copper', 'stone', 'wooden'], deficit_below: 2, dump_threshold: 2, max_tier: 'wooden', mode: 'active' },
    { item: 'tools',          holder: 'bot', dump_threshold: 99 },
    // EVERY BODY CARRIES A CRAFTING TABLE: with no standing table in reach it sets this one down, crafts, and digs it
    // back up (craft_handler THE CARRIED TABLE). First in the kit (crafting_station), so every tool after it can be made.
    { item: 'crafting_table', holder: 'bot', deficit_below: 1, dump_threshold: 1, mode: 'active', job_type: 'crafting_station' },
    // TORCHES ARE CRAFTED FOR THE TRIP THAT PLACES THEM (lighting_manager.takeTorches), from the banked fuel
    // (the charcoal row) and the planks a body carries, and kept: no order ever makes one for a pocket. A pocket keeps
    // up to one stack and banks the rest.
    { item: 'torch',          holder: 'bot', dump_threshold: 64 },
    // PLANKS STAY IN THE POCKET: they are the fleet's throwaway block (utils/trash), spent by every pillar,
    // bridge and cube trip, so a body keeps what it holds — four stacks, the planks of one stack of logs —
    // and the next trip draws that much less from the chests. `deficit_below` is the walking reserve a cube
    // trip is priced to arrive with (assessors/downloaded_build.trashOf).
    { item: 'planks',        holder: 'bot', deficit_below: 12, dump_threshold: 256, job_type: 'resource_pillaring_stock', mode: 'active' },
    // A body keeps one stack of sticks for the crafts that need them (leaves drop most of them, planks make the rest
    // when a craft asks) and banks the rest.
    { item: 'stick',          holder: 'bot', dump_threshold: 64 },
    // Unpledged dirt is banked; a builder discards it once the building and standby are supplied.
    { item: 'dirt',           holder: 'bot', dump_threshold: 0 },
    // COBBLESTONE IS BANKED, NONE KEPT: a building counts the chests and its builder's own pocket, never a stone a
    // peer keeps, so a kept stone is stone no furnace or wall can be paid with. A stone tool's cobblestone is
    // withdrawn from the chests for its craft (supply_manager's raw-material step), as the shaft's fill is.
    { item: 'cobblestone',    holder: 'bot', dump_threshold: 0 },
    { item: 'raw_iron',       holder: 'bot', dump_threshold: 0 },
    { item: 'wheat',          holder: 'bot', dump_threshold: 0 },
    { item: 'saplings',       holder: 'bot', dump_threshold: 0 },

    // ── THE CHESTS HOLD MATERIAL; A TOOL OR A TORCH IS MADE WHEN A BODY NEEDS ONE ───────────────────
    // A tool takes a whole chest slot and a stack of cobblestone in that slot makes twenty of them, so the
    // chests keep the cobblestone, sticks and coal and the body short of a tool crafts it at the home it was
    // walking to anyway (assessors/shared.kitTier). MADE_TO_ORDER below is the list; waste_pit and the chest
    // housekeeping both read it.
    // FUEL STANDS BY AS CHARCOAL, BURNED FROM LOGS: trees are near and never run out. Coal is never ordered; the
    // coal the strip mine turns up counts toward the charcoal row (substitutes_for), so charcoal is smelted only
    // while the chests hold less than its level of either. The row's level is this standing shelf plus the fuel
    // every smelt the building still owes burns (assessors/furnace._buildingSmelts, fuel_calculator.charcoalFor).
    // TWO STACKS STAND BY: one fuel makes four torches, so every body of a twenty-body crew taking its
    // TORCH_NETWORK.mine_torches at once burns 50, and the furnaces burn the rest. The row refills once a stack is spent.
    { item: 'charcoal',      holder: 'storage', deficit_below: 64, fill_to: 128, dump_threshold: 128, mode: 'active' },
    // A stone or copper shovel speeds excavation without ordering a wooden shovel.
    { item: 'shovel', holder: 'bot', kind: 'tool', tiers: ['copper', 'stone'], deficit_below: 2, dump_threshold: 2, max_tier: 'stone', mode: 'active' },
    // EVERY BODY KEEPS ONE IRON PICKAXE, as it keeps its stone ones: one way to mine at every depth. It is reserved for the
    // ores and floors no lower tier takes (fragment_utils.RESERVED_TOOLS), so the stone set digs the stone and the iron one
    // lasts; a deep seat is any open tunnel, and a body takes one with its own pickaxe (assessors/mining). A worn one is made
    // again from the banked iron, as a worn stone one is made again from the banked cobblestone.
    // Every body keeps one shield (the sword and shield below). The chests ask the furnaces for the iron of the crew's whole
    // kit at once (the iron_ingot row, requested_work.kitStock).
    // THIRTY-TWO INGOTS STAND BY PAST THE KIT: the shallow mine keeps the shelf full, so a pickaxe worn out on the deep floors
    // is made again at once, and the iron never runs out under the deep crew.
    // THE IRON KIT IS MADE AS SOON AS ITS IRON IS BANKED, AHEAD OF THE BUILDING, as a stone tool is made from
    // banked cobblestone: each row is active, so a body withdraws the iron and crafts. THE IRON GOES IN THIS ORDER
    // (after_fulfilled): the bucket, then the shears, then each body's shield and the iron pickaxes, then the armor; a
    // building's iron waits until the kit owes none (job_gates.kitFirstGate).
    { item: 'iron_pickaxe', holder: 'bot', deficit_below: 1, dump_threshold: 1, mode: 'active', after_fulfilled: 'shears' },
    { item: 'iron_ingot', holder: 'storage', for_kit: ['shield', 'iron_pickaxe'], reserve: 32, dump_threshold: 0, mode: 'active' },
    // TWO SETS OF IRON ARMOR FOR EXPLORING, from surplus iron only (ARMOR.sets): nothing gathers for them.
    { item: 'iron_helmet', holder: 'storage', deficit_below: 0, dump_threshold: 0, surplus_to: ARMOR_SETS, mode: 'active', after_fulfilled: 'iron_pickaxe' },
    { item: 'iron_chestplate', holder: 'storage', deficit_below: 0, dump_threshold: 0, surplus_to: ARMOR_SETS, mode: 'active', after_fulfilled: 'iron_pickaxe' },
    { item: 'iron_leggings', holder: 'storage', deficit_below: 0, dump_threshold: 0, surplus_to: ARMOR_SETS, mode: 'active', after_fulfilled: 'iron_pickaxe' },
    { item: 'iron_boots', holder: 'storage', deficit_below: 0, dump_threshold: 0, surplus_to: ARMOR_SETS, mode: 'active', after_fulfilled: 'iron_pickaxe' },
    // A DIAMOND PICKAXE IS TIED TO OBSIDIAN: an order for obsidian asks for one (requested_work.obsidianStock), which asks for
    // diamond, which opens the deep shaft. Any ask for a deep material opens it (assessors/mining.deepAsks). It waits on no
    // other row: its diamond is mined only once an iron pickaxe is held (DEEP_ORES), which every body's kit carries.
    { item: 'diamond_pickaxe', holder: 'storage', deficit_below: 0, dump_threshold: 0, surplus_to: 'crew', mode: 'active' },
    // THREE BUCKETS STAND IN THE CHESTS, AND NO MORE: a bucket is a tool for a job, drawn for it and put back when it is
    // done, so the crew keeps enough for the work at once and spends no iron past it. The first iron the crew makes
    // anything of. A bucket a body carries is signed out, not missing (SIGNED_OUT_ITEMS); no body keeps one past its work:
    // the next dump brings it home (dump_threshold 0).
    { item: 'bucket', holder: 'storage', deficit_below: 3, dump_threshold: 0, mode: 'active' },
    // THE SHEARS ARE THE KIT'S, second after the bucket: one pair for shearing sheep, and LEAF_PAIRS more only while a
    // planned building has leaves (requested_work.leafStock); banked and only lent, a pair in a body's pocket is signed
    // out (SIGNED_OUT_ITEMS).
    { item: 'shears', holder: 'storage', deficit_below: LEAF_PAIRS + 1, dump_threshold: LEAF_PAIRS + 1, mode: 'active', after_fulfilled: 'bucket' },
    // BONE MEAL STANDS BY FOR THE WHEAT FIELD, so the first crops are grown the moment the field is planted and the
    // sheep's wheat comes sooner. Crafted from bone when a bone is reachable; with none, assessors/compost sends one
    // body on a forest run for compostables until the first wheat field is sown (COMPOST_SEED_KEEP), and the composter
    // makes the rest. One seat: a crafted row.
    { item: 'bone_meal', holder: 'storage', deficit_below: 8, fill_to: 16, dump_threshold: 16, mode: 'active' },
    // THE BOOKS THE STOOD-IN BLOCKS STILL OWE (STAND_INS): the row's level is worked out each pass (requested_work
    // standInStock) as the books every stood-in cell still standing as planks is made of, less the books the fleet
    // already reaches in bookshelves and lecterns. The paper is crafted from the cane only once the cane hold lets it go
    // (ingredient_keep: every cane field planted), and the leather is the cow cull's, so the books come as those come.
    { item: 'book', holder: 'storage', for_stand_ins: true, deficit_below: 0, dump_threshold: 0, mode: 'active' },
    // THE FOOD CHEST STANDS STOCKED ON EVERY DIFFICULTY, A FULL STACK: a body eats when its hunger falls under
    // HUNGER_EAT_THRESHOLD (eat_executor reads the chest), and only a body at 18 food or more heals, so a body that ran
    // or fought comes home to the bread and heals. Every loaf eaten is a loaf short of the stack, so the farm's wheat is
    // baked on the regular, and all of it stays in the chests. On peaceful hunger never falls, so the stack stands.
    { item: 'bread',         holder: 'storage', deficit_below: 64, dump_threshold: 64, mode: 'active' },
    // THE WHEAT IS GROWN ON REQUEST: storage asks a stack, and the field is worked only while the chests are short of it
    // (assessors/farming, the farm_wheat order). Passive: no gather is posted for it; the wheat farmer's visit is its one
    // source, so a crew that eats nothing parks its field instead of filling the chests. Bread bakes only past
    // INGREDIENT_KEEP.wheat, so the stack's lower half stays the pens' lead and feed.
    { item: 'wheat',         holder: 'storage', deficit_below: 64, dump_threshold: 64, mode: 'passive' },
    // THE COMBAT UNIFORM: every body carries a sword and a shield, on every difficulty — on peaceful a wolf still
    // bites, and the same body fights whatever the difficulty spawns.
    // THE SWORD IS STONE OR COPPER: no wooden sword is made (like the shovel), and none better, since a crew's iron
    // swords would cost two ingots a body. Sword and shield are the top of the kit; no armour is made.
    { item: 'shield', holder: 'bot', deficit_below: 1, dump_threshold: 1, job_type: 'crafting_defense', mode: 'active', after_fulfilled: 'shears' },
    { item: 'sword', holder: 'bot', kind: 'tool', tiers: ['copper', 'stone'], deficit_below: 1, dump_threshold: 1, max_tier: 'stone', job_type: 'crafting_weapon', mode: 'active' },
]);


// Load-time integrity (Law 13) — preflight loads every fragment, so this runs on every change.
for (const row of STOCK_THRESHOLDS) {
    // The holder is the LAYER, and only two exist.
    if (row.holder !== 'bot' && row.holder !== 'storage') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has holder ${JSON.stringify(row.holder)}. The only holders are 'bot' (the pocket) and 'storage' `
            + `(the fleet's chest system as one pool). A request is fleet-wide and is never addressed to a `
            + `named chest, and there are no chest roles — see the holder note above this table.`);
    }
    if (row.fill_to != null && (row.holder !== 'storage' || !(row.fill_to >= row.deficit_below))) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' has fill_to `
            + `${row.fill_to}; fill_to is a storage row's refill level and is at least its deficit_below (${row.deficit_below}).`);
    }
    if ('role' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still declares a chest 'role'. Roles ('requester'/'buffer') are deleted: buffer goes into any `
            + `chest and a request is filled from any chest.`);
    }
    if ('target' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still uses a removed field name. 'target' became 'keep', which became 'dump_threshold'.`);
    }
    if (typeof row.dump_threshold !== 'number') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has no numeric 'dump_threshold'. Every stock must declare how much survives a dump.`);
    }
    // A mode is required wherever deficit_below is declared — undeclared, it would fall back silently.
    if (row.deficit_below != null && row.mode !== 'active' && row.mode !== 'passive') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares deficit_below ${row.deficit_below} but mode '${row.mode}'. Every restocked row must declare `
            + `mode: 'active' (the shortfall drives acquisition) or 'passive' (it is filled from what `
            + `already exists). Gating is an overlay on top of either, never a third mode.`);
    }
    if (row.job_type != null && JOB_TYPE[row.job_type] === undefined) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares job_type '${row.job_type}', which is not a job type in JOB_TYPES. `
            + `The row would post under its branch's default instead, silently.`);
    }
    // A for_kit row is the chests' and its deficit is worked out each pass from the bot rows it names; a standing shelf
    // past the kit is its `reserve`, never a deficit_below.
    if (row.for_kit && (row.holder !== 'storage' || row.deficit_below != null
        || !row.for_kit.every(item => STOCK_THRESHOLDS.some(r => r.holder === 'bot' && r.item === item)))) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' declares for_kit `
            + `${JSON.stringify(row.for_kit)}; for_kit is a storage row with no deficit_below of its own, naming bot rows.`);
    }
    // The inverse: a mode with no deficit_below governs a shortfall that is never computed.
    if (row.deficit_below == null && row.mode !== undefined && !row.for_kit) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares mode '${row.mode}' but no 'deficit_below'. A hold-only row has no shortfall to answer for.`);
    }
}

// ── How far from home a body gathers off the surface ──
// Seeds, leaf litter, flowers and every punched block are taken no farther than this many blocks (flat) from the
// crew's home structure, about the loaded area round it. Past it a trip finds nothing and goes home.
const GATHER_REACH = 160;
// ── How near a blueprint a gather may not disturb the ground ──
// THE CAUSE: a gather that digs the base's ground tears up terrain the crew builds, levels and tends, so building
// and harvesting thrash over the same cells. Within this many blocks (flat, Chebyshev) of any sited structure's
// footprint, the base's lights included (fragment_utils.gatherBanned), no gather digs ground (GATHER_KEEPOUT_GROUND):
// no punched or shaved block, no surface stone, no pierced shaft, and no survey page that would send a gatherer
// there. A gather that leaves the ground as it stands (a tree, a plant, a grass tuft, a drop) disturbs no terrain
// and is permitted, keeping only the harvest's own keep-out. Building, clearing a site, mining the planned shaft
// and tending the base's own fields are the base's own work and stay inside.
const GATHER_KEEPOUT = 20;
// The block names whose digging changes the ground: the terrain itself, its stone and its ores, as generated.
const GATHER_KEEPOUT_GROUND = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|stone|cobblestone|mossy_cobblestone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|calcite|smooth_basalt|(red_)?sandstone|(\w+_)?terracotta|obsidian|dripstone_block|pointed_dripstone|moss_block|ice|packed_ice|blue_ice|budding_amethyst|amethyst_block|(deepslate_)?\w+_ore)$/;
// How far past a crew's wheat field or sheep pen its trees are felled before it is built: a tree whose wood stands
// this close holds leaves over the site, and a felled tree's leaves decay with it. Those two are sited over trees
// (utils/surface_site), so the felling is what clears their ground, canopy and all.
const SURFACE_TREE_MARGIN = 4;

// WHERE A CREW NEVER SETTLES, LANDS OR BUILDS: every biome named here; every biome not named is free (settles).
// The list says what is not wanted, by why; each structure's siting refuses the ground a biome name cannot (water,
// unevenness, an unsafe descent).
const BANNED_BIOMES = new Set([
    // water: the sea, its shore, rivers and swamps
    'ocean', 'deep_ocean', 'warm_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean', 'cold_ocean', 'deep_cold_ocean',
    'frozen_ocean', 'deep_frozen_ocean', 'river', 'frozen_river', 'beach', 'snowy_beach', 'stony_shore',
    'swamp', 'mangrove_swamp',
    // mountains, hills, cliffs and plateaus
    'meadow', 'cherry_grove', 'grove', 'snowy_slopes', 'frozen_peaks', 'jagged_peaks', 'stony_peaks',
    'windswept_hills', 'windswept_gravelly_hills', 'windswept_forest', 'windswept_savanna', 'savanna_plateau',
    'badlands', 'eroded_badlands', 'wooded_badlands',
    // trees that are not oak or spruce, or big 2×2 trees
    'jungle', 'sparse_jungle', 'bamboo_jungle', 'dark_forest', 'pale_garden', 'birch_forest', 'old_growth_birch_forest',
    'old_growth_pine_taiga', 'old_growth_spruce_taiga', 'savanna',
    // no trees
    'desert', 'mushroom_fields',
    // snow and ice: water freezes over a field
    'snowy_plains', 'ice_spikes', 'snowy_taiga',
    // underground, the Nether and the End
    'dripstone_caves', 'lush_caves', 'deep_dark', 'nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest',
    'basalt_deltas', 'the_end', 'end_highlands', 'end_midlands', 'small_end_islands', 'end_barrens', 'the_void',
]);
// settles(biome) → true for a read biome the crew may settle in; an unread biome (null) settles nowhere.
const settles = (biome) => !!biome && !BANNED_BIOMES.has(biome);
// WHERE THE CREW'S BASE STANDS, best first: oak forest, then plains, the biomes oak grows in. The building's footprint
// is sited on a plot whose dominant biome is in the first rank any passing plot reaches
// (lock_all_buildspots.siteBuilding); a landing with none in either is refused and rolled again.
const BASE_BIOMES = [
    new Set(['forest', 'flower_forest']),
    new Set(['plains', 'sunflower_plains']),
];
// THE TWO WOODS EVERY DOWNLOADED BUILDING IS MADE OF, the two the base's forest gives most. A plan builds its
// download's most-used wood as `primary` and every other wood as `accent` (blueprint_material_rule), so the build
// keeps two tones. Both are replanted in equal numbers (sapling_planter).
const BUILD_WOOD = Object.freeze({ primary: 'oak', accent: 'birch' });

// WHERE THE FOREMAN HAS TO LAND FOR A CREW TO BE WORTH RAISING.
const SEA_LEVEL = 63;
// Below the column's own topmost ground by more than this = underground (a cave, a mine, a ravine).
const LANDING_SURFACE_SLACK = 4;
// Above SEA_LEVEL by more than this = a peak.
const LANDING_MAX_ABOVE_SEA = 20;


// ── COPPER STANDS IN FOR IRON WHERE THE GAME MAKES THE SAME BLOCK OF IT ──────────────────────────────
// A downloaded building's block named on the left is built as the block on the right (downloaded_plan_registry
// blockOf), so iron is spent only on the blocks that have no copper form.
const COPPER_FOR_IRON = Object.freeze({ iron_bars: 'copper_bars', iron_chain: 'copper_chain', lantern: 'copper_lantern' });

// ── PLANKS STAND IN FOR THE BOOK BLOCKS UNTIL A WHOLE CUBE OF THEM CAN BE PAID ───────────────────────
// A bookshelf is three books, and a book is three paper (cane) and a leather (the cow cull): the slowest material the
// building asks for. A downloaded building's block named here is built as its site wood's planks
// (downloaded_plan_registry voxelBlock), so the walls go up without waiting on the cows and the cane. A cube is built
// of the real block once the books the fleet reaches pay for every stood-in cell of that cube still standing as
// planks, cubes taken in their build order (standIns); its column then offers it again and the trip digs the planks
// and places the real blocks. A real block already standing is the block the plan asked for, at any time.
// `books`: the books one block of it is made of. The `book` stock row (STOCK_THRESHOLDS) asks for the books still owed.
const STAND_INS = Object.freeze({
    bookshelf: Object.freeze({ books: 3 }),
    lectern: Object.freeze({ books: 3 }),
});

// Fuel preference order (first one held is used); logs excluded — worth 4x a plank.
// Coal first, charcoal second; planks burn only when a body holds neither and the chests hold neither.
const FUEL_PREFERENCES = ['coal', 'charcoal', 'planks'];
// ── CHARCOAL IS THE FUEL OF EVERYTHING; WOOD BURNS ONLY TO MAKE IT ─────────────────────────────────────────────
// Every smelt burns coal or charcoal. Planks burn under one smelt only, charcoal's own (fuel_calculator.fuelsFor), so
// the wood is turned into the fuel every other smelt and every torch waits on, and is never burned for stone.
const WOOD_FUEL_ONLY_FOR = 'charcoal';

// ── COMPOST → BONE MEAL ────────────────────────────────────────────────────────────────────────────
// Waste (leaf litter, saplings, apples) into bone meal; `leaf_litter` is the compostable block.
const BONE_MEAL_MAX_CROP_STAGE = 6;
// THE BIOMES A GATHERED BLOCK GROWS IN, for a block found only in some (sector_finder.categoriesFor): a body that sees
// none where it stands is sent to a book page recording the block or one of these biomes, and with neither the
// frontier is scanned ring by ring until one is, so the landing's own biome does not decide what the crew can gather.
// Leaf litter generates on the floor of these forests (Minecraft 1.21.5).
const SOURCE_BIOMES = Object.freeze({
    leaf_litter: Object.freeze(['forest', 'dark_forest', 'wooded_badlands']),
});
// A bone-meal visit carries up to this many from the chests: every banked one, in practice. The field spends them
// one crop at a time until that crop is ripe (farm_executor.bonemealReachable), so the first wheat comes first.
const BONE_MEAL_PER_VISIT = 64;
// Banked compostables that post the `compost_feed` job: one body empties them all into the composter in
// one visit, so the walk is paid once per hundred items.
const COMPOST_BATCH_MIN = 100;
// THE COMPOST GATHERING IS A BOOTSTRAP: the forest run (assessors/compost forestRun) goes out only until the first wheat
// field is sown (farming_integrity.firstFieldSown). From then the harvest's seeds are the compost: storage keeps this
// many wheat seeds (one stack), and every seed past it goes to the composter, from a body's pocket at its drop-off
// (compost_executor.compostSurplusSeeds) and from the chests in the compost batch (bankedCompostables).
const COMPOST_SEED_KEEP = 64;
// What the composter's gathering run (assessors/compost forestRun) asks for, and the order a punch cap counts: any
// compostable the ground offers (fragment_utils group `compostables`: leaf litter and flowers), every one taken.
const COMPOST_RUN_ITEM = 'compostables';
// THE COMPOST RUN GOES WHERE THE GROUND IS THICK, not where it is nearest (sector_finder.densest): it walks to the book
// page that saw the most compostable blocks together once that is `min` or more, and with none that thick it scans the
// next frontier sector first, so each run widens the book until a dense patch (a forest floor, a flower field) is found.
// `min` is a guess, unmeasured: a sunflower plain's sector reads a few hundred flowers, a forest's leaf litter more.
const COMPOST_DENSITY = Object.freeze({ min: 200 });

// ── CHEST HOUSEKEEPING (assessors/housekeeping, chest_housekeeping_executor) ─────────────────────────
// THE CLEAN-OUT: once full_share of every chest slot is taken, whatever the slots hold, passes are posted until
// clean_to of them is taken or nothing is left to take. What goes is chest_housekeeping_executor.plan's ranking
// (WASTE_PIT). One body makes at most moves_per_pass stack moves, then the board is read again.
const CHEST_HOUSEKEEPING = Object.freeze({ full_share: 0.80, clean_to: 0.50, moves_per_pass: 15 });

// THE BASE SWEEP (assessors/base_sweep, base_sweep_executor): the home base's ground kept clear of litter, a support job
// beside the work. The base is the spawn proofing's rectangle (base_layout.proofingTorches); a sited structure's own
// footprint is its builder's and is left alone (a pen, the farm, a building). Litter is every plant a hand breaks: the
// compostables group (leaf litter, flowers) and the grasses, ferns, bushes and mushrooms named here. One shared seat
// walks it, nearest first, at most punch_max breaks a pass, then banks; the haul's compostables reach the composter
// through compost_feed.
//   scan_ms  — how often a body re-reads the rectangle for litter (the board sweeps far more often).
//   post_min — the litter left that is worth a walk; fewer waits until more is found.
const BASE_SWEEP = Object.freeze({
    punch_max: 40,
    scan_ms: 30000,
    post_min: 3,
    litter: Object.freeze(['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'bush', 'firefly_bush',
        'short_dry_grass', 'tall_dry_grass', 'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom', 'red_mushroom']),
});

// A mining trip is bounded by TOOLS, never by a count of cells: the body carries the pickaxe row's set
// and keeps taking cells while it holds more than MINING_LAST_PICKAXE, so the last one is reserved for
// finishing the cell in hand before the walk up (mining_manager). The shaft is the exception: it is the rush to
// the iron band and is dug in one trip on SHAFT_PICKAXES (count + spare in all; its owner crafts only what it is
// short of that total, mining_manager.takeShaftPicks), the spare spent if it must be. MINING_PASSES_PER_DISPATCH bounds
// the RE-PASSES on ONE cell or shaft segment that keeps shrinking without coming clean.
const MINING_LAST_PICKAXE = 1;
const MINING_PASSES_PER_DISPATCH = 3;
// The shaft's pickaxes, in all: 3 wooden (59 uses each) dig the staircase to the iron band, plus 1 spare.
const SHAFT_PICKAXES = Object.freeze({ item: 'wooden_pickaxe', count: 3, spare: 1 });

// ── THE SHAFT BELOW THE IRON BAND (building_site_overlays.routeBelow) ─────────────────────────────────
// floor_y: how deep the deep shaft is routed to, past the shallow shaft's straight run, by flights and quarter-turn landings.
// max_checks: pieces one mouth's route search may walk. A mouth with no route still makes a shallow shaft, and a
// siter looks route_search_beyond blocks further out for one with a route (find_buildingspot).
// first_turn_y: the highest piece that may be a landing. Where deepslate starts, and under the mine's lowest tunnel
// floor in either layout (mining_cell_graph hangs its floors on flights of the site's heading, up to 2 copies under STRADDLE_FLOOR_Y).
const SHAFT_TURNS = Object.freeze({ floor_y: -58, max_checks: 300, first_turn_y: 8, route_search_beyond: 32 });

// ── WHAT ONLY THE DEEP SHAFT REACHES ──────────────────────────────────────────────────────────────────
// Ore category -> the tool the fleet must hold before the ore opens the deep shaft (no deepslate before iron, no
// obsidian before diamond), and the floor its tunnels are dug nearest. Any ask for one of these opens the deep shaft; no
// ask, no deep shaft. A material only the deep levels hold joins this table to be asked for the same way.
// DEEP_SEAT_FACTOR: seats per ore short against a shallow tunnel's, since deepslate digs at half the speed.
const DEEP_ORES = Object.freeze({
    lapis:    Object.freeze({ tool: 'iron_pickaxe', y: 0 }),
    gold:     Object.freeze({ tool: 'iron_pickaxe', y: -16 }),
    redstone: Object.freeze({ tool: 'iron_pickaxe', y: -58 }),
    diamond:  Object.freeze({ tool: 'iron_pickaxe', y: -58 }),
    obsidian: Object.freeze({ tool: 'diamond_pickaxe', y: -58 }),
});
const DEEP_SEAT_FACTOR = 2;

// ── SECTORS (perception_nodes.js/sector_scan, survey_book) ───────────────────────────────────────────
// A sector is one `span`-block square of a fixed grid; its scan is taken from as near its centre as a body can
// stand and reads `radius` blocks around that, inside the server's view distance. The span is under the view
// radius, so a neighbouring sector's centre is loaded ground from this one's, and a body walks out to the
// frontier in legs of at most `leg` blocks that each end on loaded ground. A cliff face is open to the sky only
// within `face_depth` blocks under its column's own ground: a ravine's walls below that are underground, where a
// body sent for stone would stand at the bottom beside its lava.
// backstop_rings: the sectors are never limited, but a frontier scan past this many rings round home's sector is a
// sign the thing sought is on no scan list (SURVEY_CATEGORIES), not that the world holds none; custom_api/sector_finder
// stops there with a loud error.
// tour_rings: how far out the one seat of the sector tour scans (assessors/survey, sector_finder.tour).
// finder_scans: the most frontier sectors one claim scans looking for a thing (sector_finder.escalate); after each scan
// the claim reads the book again and goes on, and past the last it drops its signal with a warning.
const SECTOR_SCAN = Object.freeze({ radius: 150, span: 128, leg: 112, face_depth: 6, backstop_rings: 4, finder_scans: 3, tour_rings: 1 });
// What the survey book records as present or absent: a category per block name, first match wins. A sector
// records the ones open to the sky, plus its biomes ('biome:<name>') and its animals ('animal:<name>').
const SURVEY_WOODS = Object.freeze(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']);
// The flowers a dye is made from, each its own category (DYE_STOCK keeps a stack of each from the composter).
const SURVEY_FLOWERS = Object.freeze(['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
    'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'pink_petals', 'wildflowers']);
const SURVEY_CATEGORIES = Object.freeze([
    ['coal', /^(deepslate_)?coal_ore$/],
    ['iron', /^(deepslate_)?iron_ore$/],
    ['copper', /^(deepslate_)?copper_ore$/],
    ['gold', /^(deepslate_)?gold_ore$/],
    ['redstone', /^(deepslate_)?redstone_ore$/],
    ['lapis', /^(deepslate_)?lapis_ore$/],
    ['diamond', /^(deepslate_)?diamond_ore$/],
    ['emerald', /^(deepslate_)?emerald_ore$/],
    ['amethyst', /^(budding_amethyst|amethyst_cluster)$/],
    ['obsidian', /^obsidian$/],
    ['stone', /^stone$/],
    ['deepslate', /^deepslate$/],
    ['sand', /^sand$/],
    ['red_sand', /^red_sand$/],
    ['gravel', /^gravel$/],
    ['clay', /^clay$/],
    ['mud', /^mud$/],
    ['dripstone', /^(pointed_dripstone|dripstone_block)$/],
    ['moss', /^moss_block$/],
    ['ice', /^(ice|packed_ice|blue_ice)$/],
    ...SURVEY_WOODS.map(w => [`${w}_log`, new RegExp(`^${w}_log$`)]),
    ...SURVEY_WOODS.map(w => [`${w}_leaves`, new RegExp(`^${w}_leaves$`)]),
    ...SURVEY_FLOWERS.map(f => [f, new RegExp(`^${f}$`)]),
    ['grass', /^(short_grass|tall_grass|fern)$/],
    ['leaf_litter', /^leaf_litter$/],
    ['cocoa', /^cocoa$/],
    ['pumpkin', /^pumpkin$/],
    ['melon', /^melon$/],
    ['sugar_cane', /^sugar_cane$/],
    ['bamboo', /^bamboo$/],
    ['cactus', /^cactus$/],
    ['sweet_berries', /^sweet_berry_bush$/],
    ['water', /^water$/],
    ['lava', /^lava$/],
].map(([category, pattern]) => Object.freeze({ category, pattern })));
// The ore category an underground item is mined from: its raw drop, its ingot and its ore blocks share one.
const SURVEY_ORE_ITEM = /^(?:raw_|deepslate_)?(coal|iron|copper|gold|redstone|lapis|diamond|emerald)(?:_ore|_ingot|_lazuli)?$/;

// ── THE WASTE PIT (custom_api/waste_pit) — WHERE A POCKET'S TRASH GOES INSTEAD OF A CHEST ─────────────
// The pit is the `structure` blueprint (building_blueprints.json): a 4×3 pad with a trench two blocks long
// down its middle, sited by the foreman beside the home (WASTE_PIT_SITING) and built by the crew. A body
// stands on the pad cell at one end of the trench and tosses along it at the far wall; an item resting
// on the pit floor is under the thrower's feet, past the reach of a player's pickup box, and despawns on
// its own after five minutes.
// A POCKET BANKS AT A DROP-OFF, and the chests' clean-out (CHEST_HOUSEKEEPING) carries waste here. Two exceptions are
// thrown at the drop-off: `useless`, and `wooden_tools` the body does not keep: they exist to reach stone, so a chest
// keeps none (waste_pit.trashIn). Every throw names its reason in the item book. What a clean-out takes:
//   ranking   one chest slot at a time until clean_to: of every item with a slot to give, the one holding the most slots,
//             and of equals the least valuable: `value` in its order, then anything it does not name. A stack of sixteen
//             and a stack of sixty-four are one slot each.
//   limit     never taken: what the building and the structures still ask for, through their recipes, and one stack of
//             everything, so a little of everything stays (waste_pit.chestLimit).
//   exempt    never taken: `exempt`, and everything the fleet makes (a recipe; no chain makes those without end), but
//             for `gathered`, which the world also hands over without end.
//   useless   what the world hands over that nothing could ever want: thrown from the pocket at a drop-off, so it never
//             reaches a chest while the pit stands, and none kept of any banked before it stood. A wrong entry destroys a
//             thing and a missing one costs one chest slot, so an item goes here only when no future plan could ask for it.
const WASTE_PIT = Object.freeze({
    structure: 'waste_pit',
    exempt: Object.freeze(['diamond', 'diamond_ore', 'deepslate_diamond_ore', 'emerald', 'emerald_ore', 'deepslate_emerald_ore',
        'raw_iron', 'iron_ore', 'deepslate_iron_ore', 'raw_gold', 'gold_ore', 'deepslate_gold_ore', 'gold_nugget', 'iron_nugget',
        'ancient_debris', 'netherite_scrap', 'enchanted_book', 'saddle', 'name_tag', 'ender_pearl', 'nether_star', 'saplings']),
    useless: Object.freeze(['rotten_flesh', 'poisonous_potato', 'spider_eye', 'phantom_membrane', 'pufferfish']),
    wooden_tools: Object.freeze(['wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_hoe', 'wooden_sword']),
    gathered: Object.freeze(['stick', 'diorite', 'granite', 'andesite', 'amethyst_block']),
    value: Object.freeze(['gravel', 'flint', 'diorite', 'granite', 'andesite', 'tuff', 'calcite', 'smooth_basalt', 'dirt', 'cobblestone', 'sand', 'stick', 'leaf_litter', 'oak_leaves', 'birch_leaves',
        'wheat_seeds', 'poppy', 'dandelion', 'wildflowers', 'peony', 'lily_of_the_valley', 'feather', 'ink_sac']),
});

// ── THE MINE'S UNIT: 'cell' (5×5×5 rooms) OR 'strip' (1×2 trunk and branches) — mining_cell_graph ──────────
// Both grow as a fan from each floor's staircase side-attaches, nearest the prime first. A strip body mines
// the ore it uncovers in the tunnel's walls (mining_executor.mineVeins). AUREN_MINE_LAYOUT picks one for a
// run, so the two can be run side by side on the same code.
const MINE_LAYOUTS = ['cell', 'strip'];
const MINE_LAYOUT = process.env.AUREN_MINE_LAYOUT || 'strip';
if (!MINE_LAYOUTS.includes(MINE_LAYOUT)) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): AUREN_MINE_LAYOUT is "${MINE_LAYOUT}"; it is one of ${MINE_LAYOUTS.join(', ')}.`);
}

// ── A CREEPER BEFORE ITS FUSE: 'move' OR 'stand' — driver's creeper footwork ─────────────────────────────────
// Both strike on the predicted reach (gunner, prediction_engine). 'move' keeps the predicted gap just outside the fuse
// distance, closing and backing off as both bodies move; 'stand' holds still while the creeper walks in and closes only on
// one that is not coming. AUREN_CREEPER_FOOTWORK picks one for a run, so the two can be tried side by side.
const CREEPER_FOOTWORKS = ['move', 'stand'];
const CREEPER_FOOTWORK = process.env.AUREN_CREEPER_FOOTWORK || 'move';
if (!CREEPER_FOOTWORKS.includes(CREEPER_FOOTWORK)) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): AUREN_CREEPER_FOOTWORK is "${CREEPER_FOOTWORK}"; it is one of ${CREEPER_FOOTWORKS.join(', ')}.`);
}

// ── NOTHING IN THE BODY'S OWN KIT MAY REQUIRE STONE (STANDING) ───────────────────────────────────
// A kit requiring stone requires a shaft, which requires a pickaxe, which is itself a kit row —
// checked by walking the row's own recipe decomposition (`build_material_calculator`, Law 16).
// Scoped to `holder: 'bot'`, `mode: 'active'` rows with a `deficit_below` — the ones that drive a trip.
{
    const { isUnderground } = require('@utils/fragment_utils');
    const { blueprintToRawMaterials } = require('@utils/calculators/build_material_calculator');
    const STONE_TIERS = ['stone', 'copper', 'iron', 'diamond', 'netherite'];
    // A row a for_kit storage row names has its material ordered by the shelf; the body's row crafts from what is
    // banked, and job_gates.chainGate holds it until the chests hold the material, so it never sends a body digging.
    const shelfOrdered = new Set(STOCK_THRESHOLDS.filter(r => r.holder === 'storage' && r.for_kit).flatMap(r => r.for_kit));
    for (const row of STOCK_THRESHOLDS) {
        if (row.holder !== 'bot' || row.mode !== 'active' || !(row.deficit_below > 0)) continue;
        if (shelfOrdered.has(row.item)) continue;
        if (row.min_tier && STONE_TIERS.includes(row.min_tier)) {
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot-kit row '${row.item}' `
                + `declares min_tier '${row.min_tier}', so the body cannot equip itself without cobblestone — `
                + `and cobblestone is a shaft, which is a pickaxe, which is another row of this same kit. `
                + `The body's own kit is made of wood only; a stone tier is the SHELF's order `
                + `(holder: 'storage'), which the family count then satisfies for free.`);
        }
        // A tool row names a FAMILY, which has no recipe of its own — ask the tier the body makes from nothing,
        // its wooden one. A row whose tiers hold no wooden is offered only once stone already exists
        // (shared.kitTier), so it never sends a body digging for its own tool.
        if (row.kind === 'tool' && Array.isArray(row.tiers) && !row.tiers.includes('wooden')) continue;
        const token = row.kind === 'tool' ? `${row.max_tier || 'wooden'}_${row.item}` : row.item;
        for (const raw of Object.keys(blueprintToRawMaterials({ [token]: row.deficit_below }))) {
            if (!isUnderground(raw)) continue;
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot-kit row '${row.item}' `
                + `decomposes to '${raw}', which is reached only by digging — a pickaxe and a shaft. The `
                + `bot band sits above every other band and must empty before any of them is reached, so a `
                + `kit row that needs stone waits on a pickaxe that is waiting on this row. Put the order `
                + `on the shelf (holder: 'storage') or in a build's bill, or make the row passive if the `
                + `body should merely keep what it finds.`);
        }
    }
}

// ── Combat / engagement tunables ──
// "Inside base" = within this many blocks of the headframe's transpose_origin; engage on aggro outside it.
const HEADFRAME_SAFE_RADIUS = 32;

// A livestock predator (threat_scanner.isPredator) is fought on sight, without waiting to be struck, only where it
// threatens the herd: within pen_blocks (horizontal) of one of the crew's pens (FARM_PENS), or within herd_blocks of a
// body holding a herding job. Elsewhere, the rest of the base included, it is a neutral and left alone until it bites
// (combat_utils.NEVER_INITIATE): a wolf is neutral until struck, and its pack answers the first blow.
// Only an ARMED body (a sword or an axe in the pocket) opens a guard fight; a bare-handed one fights a predator only
// once bitten. Only a body within engage_blocks of a guarded predator takes it on: the crew's nearest answer it, and a
// body across the base does not drop its work to chase one its peers are already on (mob_claims gives the mob one fighter).
const PREDATOR_GUARD = {
    pen_blocks: 16,
    herd_blocks: 16,
    engage_blocks: 24,
};

// A hostile is "aggroed" iff within AGGRO_RANGE blocks and has clear line-of-sight to the bot.
const AGGRO_RANGE     = 15;
const DISENGAGE_RANGE = 20;

// ── PER-SPECIES AGGRO RANGE ────────────────────────────────────────────────────────────────────────
// Only the skeleton family is listed; every other mob falls back to AGGRO_RANGE.
const MOB_AGGRO_RANGE = {
    skeleton: 18,
    stray: 18,
    bogged: 18,
    wither_skeleton: 18,
};
const MAX_AGGRO_RANGE = Object.values(MOB_AGGRO_RANGE).reduce((m, v) => Math.max(m, v), AGGRO_RANGE);

// ── THE GATE IS A CYLINDER, NOT A SPHERE ───────────────────────────────────────────────────────────
// Horizontal aggro range and vertical range are independent budgets.
const AGGRO_VERTICAL_RANGE = 8;
const MAX_CAST_RANGE = Math.hypot(MAX_AGGRO_RANGE, AGGRO_VERTICAL_RANGE);
// Measured against the diagonal, not the radius — the farthest a mob can be and still be aggroed.
if (DISENGAGE_RANGE <= MAX_CAST_RANGE) {
    throw new Error(`[architect_config] DISENGAGE_RANGE ${DISENGAGE_RANGE} must exceed the aggro cylinder's ` +
        `diagonal ${MAX_CAST_RANGE.toFixed(2)} (widest radius ${MAX_AGGRO_RANGE} × vertical ${AGGRO_VERTICAL_RANGE})`);
}

// The horizontal radius this species is honoured at — the one route for the table lookup (Law 16).
function aggroRangeFor(name) {
    if (!name) return AGGRO_RANGE;
    return MOB_AGGRO_RANGE[String(name).toLowerCase()] || AGGRO_RANGE;
}

// ── THE THROWER'S REACH ────────────────────────────────────────────────────────────────────────────
// A mob seen within this reach is taken past the aggro cylinder, at the same height budget (commander, THE THROWER'S
// DOOR), and only seen: the cylinder, and DISENGAGE_RANGE above it, are unchanged. A drowned is taken at its trident's
// throw (a hit landed from 21 b in the arena) so the fight opens before the throw; one seen walking in at 20 b was not
// taken and threw on the body's first step.
const MOB_SIGHT_REACH = {
    drowned: 24,
};
// engageRangeFor(name) → the farthest a seen mob of this species is taken: its sight reach or its aggro radius.
function engageRangeFor(name) {
    const r = aggroRangeFor(name);
    if (!name) return r;
    return Math.max(r, MOB_SIGHT_REACH[String(name).toLowerCase()] || 0);
}

// The cylinder's diagonal, rounded up so the predicate never truncates one voxel short.
function aggroCastRange(name) {
    return Math.ceil(Math.hypot(aggroRangeFor(name), AGGRO_VERTICAL_RANGE));
}

// THE ONE ROUTE for the gate itself (Law 16). Plain {x,y,z} so benches and monitors can ask the bot's
// own question without dragging prismarine into a reader (Law 26).
function withinAggroRange(self, pos, name) {
    if (!self || !pos) return false;
    if (Math.abs(pos.y - self.y) > AGGRO_VERTICAL_RANGE) return false;
    return Math.hypot(pos.x - self.x, pos.z - self.z) <= aggroRangeFor(name);
}
// ── THE TORCH NETWORK (lighting_integrity) ─────────────────────────────────────────────────────────────
// THE MINE IS LIT BY ITS DESIGN, NEVER BY A LIGHT READING: its torches stand where its geometry puts them, whether
// or not a cell reads dark (lighting_integrity.mineLamps). The staircase declares a light point (its blueprint's
// light_points), lit on every stair_every-th copy from the top and on the bottom copy; every strip tunnel, trunk
// and branch alike, takes a wall torch at its doorway block and every tunnel_every blocks after (blocks 1, 13,
// 25...); a 5×5×5 cell takes the light point its blueprint declares. mining_cell_graph proves the spacing on the
// design at load with the light model (preflight pass 2): no stand cell of the designed mine reads block light
// lit_above or under. A body digging a cell places its torch in the same pass.
// THE BASE is lit by its design too: torches on posts over the ground round its structures, painted and proven lit
// over the ground the siting read (BASE_LIGHTS, base_layout) and built as the spawn proofing. Whether every designed torch stands, base and
// mine, is the integrity keeper's verdict (foreman/integrity_keeper_worker.js). Every crew lays torches, and digs
// its mine only lit: no body goes down without
// mine_torches of them or the fuel to make them (mining_manager.mineLightReady), and until then the furnace's stone
// comes from the surface. A lighting visit takes the dug shaft's missing torches. The base's ground opens the night
// gate for work on it once every spawn-proofing torch stands (job_gates.nightGate).
//   lit_above        a cell is lit when its block light is above this; a hostile spawns at block light 0 (26.1)
//   torches_per_trip the most torches one lighting visit carries and places
//   mine_torches     the torches a body crafts and takes down the mine, counting what it holds
//   tunnel_every     blocks between two torches along one strip tunnel, the first at its doorway block
//   stair_every      staircase copies between two lit light points, the first on the top copy, the bottom copy lit too
const TORCH_NETWORK = Object.freeze({
    lit_above: 0,
    torches_per_trip: 32,
    mine_torches: 10,
    // A trip below the shallow shaft takes this many: a pull at the door, kept in the pocket between trips, and its walk home is long.
    deep_torches: 32,
    tunnel_every: 12,
    stair_every: 3,
});

// Leading an animal with held wheat (herd_executor). Distances are flat blocks between body and animal.
// A sheep is pulled from 9 blocks and not from 10, and a tempted sheep halts 2.1–2.5 from the holder.
const HERDING = {
    tempt_range: 9,         // farthest a held animal may trail before it counts as lost
    caught_up: 3,           // an animal this close has stopped following and is waiting at the holder
    leg_steps: 4,           // route steps one lead leg may walk, so a lagging animal stays inside tempt_range
    acquire_blocks: 4,      // how close the herder comes to the animal before it shows the wheat
    max_approach_walks: 6,  // walks re-aimed at a wandering animal before it counts as out of reach
    tempt_wait_ms: 7000,    // longer than the 5 s an animal refuses a new tempt after losing one
    lag_wait_ms: 10000,     // a leg's wait for the animal, renewed while it is still closing (water is slow)
    max_reacquires: 3,      // walks back to a lost animal before the herd ends as lost
    gate_approach_blocks: 2, // the lineup cell, this far out from the gate on its axis: the lead ends there and walks straight in
    deep_blocks: 4,         // the deep cell, this far past the gate's inner cell: the bringer draws its flock in to here (a tempted animal stops 2.5 b short of the wheat, so they clear the doorway)
    park_blocks: 12,        // the standby cell, this far out from the gate on its axis: where a tender waits for the shepherd; past tempt range of the gate, so a bringer's wheat never draws the penned flock out
    herders: 2,             // wheat a herd needs: the bringer's and its shepherd's
    drop_hold_ms: 2500,     // at the inner cell, the flock in, the longest the bringer waits for an animal to leave the doorway before it shuts the gate
    sweep_step_ms: 400,     // a sweeping shepherd rests this long on each stand along the fence, so the tempted flock keeps pace (herd_executor.sweepFlock)
    doorway_blocks: 1.5,    // a penned animal this close to a gate cell being opened stands in the doorway (the cell inside it and those beside that): no gate opens on it
    doorway_clear_ms: 15000, // the longest a gate waits for a penned animal to leave the doorway; then a body inside opens it, the animal named, and one outside does not
    doorway_wheat_ms: 60000, // the longest a gate waits for wheat shown outside within tempt reach of it to leave; then the crossing fails
    shepherd_wait_ms: 300000, // the longest a shepherd holds for one tender before it gives the post up
    shepherd_release_ms: 3000, // a tender gone without saying it is out (killed, disconnected): its standby cell must read free this long before the shepherd leaves
    wait_say_ms: 10000,     // a body waiting on a peer at the pen writes what it sees this often ([HERD_WAIT])
    wheat_followers: ['sheep', 'cow', 'mooshroom', 'goat'],   // every animal held wheat tempts: a gate opens only with none but the pen's kind at heel
    shoo_tick_ms: 1000,     // how often a herder showing its wheat reads for an animal of another kind following it (herd_executor.shooGuard)
    shoo_every_ms: 3000,    // one hit per this interval on an animal of another kind inside strike reach, while it stays
    shoo_warn_ms: 20000,    // one warning per this interval for an animal of another kind following out of strike reach
    flock_blocks: 4,       // animals this close to the bringer as it leaves the standby cell are the flock it takes in
    unreachable_skip_ms: 600000, // an animal no route reached is skipped this long by the body that tried
    gate_wait_ms: 180000,   // how long a body waits for the gate, the standby cell, or a tender for its shepherd, before the job ends
    // EACH PEN HOLDS ONE KIND (pen_gate.penOf reads its row): `animal` is the kind; `wool` pens are shorn and dyed for
    // the building's wool; `cull_keep` is the grown stock a full meat pen keeps when it slaughters the rest for meat
    // and hide (assessors/ranching, cull_executor). A pen with no row is a coding violation. `per_cell`, when set,
    // is that pen's animals per interior cell in place of grass_per_animal: a cow eats nothing, so the cow pen is
    // stocked at 85% of its cells (68 cows in the 5x16 pen against the sheep's 16) and culls down to 16 to breed back.
    // EVERY PEN FILLS BY HERDING AND BREEDING TOGETHER: herding fetches wild animals from the first ring of sectors round
    // home (reach_rings) while the pen has room (and brings back any escaped one); from two penned it also breeds on the
    // clock (breed_every_ms).
    // `herd_until`: the pen herds no more wild animals once it holds this many (escaped ones are still fetched back); the
    // rest it breeds. null herds until the pen is full.
    pens: Object.freeze({
        sheep_pen: Object.freeze({ animal: 'sheep', wool: true, cull_keep: null, herd_until: null }),
        cow_pen:   Object.freeze({ animal: 'cow', wool: false, cull_keep: 16, per_cell: 0.85, herd_until: 16 }),
    }),
    grass_per_animal: 5,    // interior cells per animal: the flock is the pen's interior over this
    sense_pen_blocks: 64,   // a body farther than this from its pen cannot count the flock, so it posts no herd job
    // The herd has no reach: an animal no body senses is looked for in the survey book and then the next frontier
    // sector (animal_finder.seek over custom_api/sector_finder), and the pen asks while either is open.
    pen_short_warn_ms: 120000, // one warning per this interval from a body that senses no free animal, every section counted empty, while the pen holds fewer than 2
    // BREEDING ON THE CLOCK (herd_executor.breedRound): every breed_every_ms one body goes to the pen with two wheat for
    // each pair the pen has room to raise and feeds every animal that comes to the fence, nearest first. The clock is
    // the game's own: a grown animal that bred can breed again after 5 minutes, so a round on that clock finds the
    // pen's grown stock ready without asking the server. A lamb fed grows sooner.
    breed_pair_min: 2,      // penned animals before the pen breeds
    reach_rings: 1,         // sector rings round home a herd looks for wild animals in (sector_finder RINGS): the first ring
    breed_every_ms: 300000, // one breeding round per pen this often: the game's breeding cooldown
    // THE ROUND READS THE PEN FIRST (herd_executor.breedRound, pen_gate.askBreeding): the server's Age of every penned
    // animal says which are grown and ready (Age 0, not in love), grown and cooling (Age above 0, ticks left), or young
    // (Age below 0). Only the ready are fed, in pairs. The round is posted breed_lead_ms before the clock comes round, and
    // at the fence the breeder waits, up to breed_ready_wait_ms, for the cooling animals that come ready by then.
    breed_lead_ms: 45000,
    breed_ready_wait_ms: 60000,
    feed_reach: 3,          // the server's entity interaction range: an animal farther than this is not fed
    feed_wait_ms: 8000,     // the wait, at the fence with the wheat in hand, for the animal to come within feed_reach
    // SHEARING (shear_executor): the fleet's pen pair of shears, made once the pen holds an animal; LEAF_PAIRS more are
    // made for leaves (assessors/downloaded_build). Both are banked and only borrowed (shear_manager, harvest_executor).
    // A pen is shorn as soon as one penned animal of an owed color is woolly: no count of penned animals, no wait for
    // the rest to grow back (assessors/ranching).
    wool_ask_ms: 60000,     // how often the board asks the server which penned animals are woolly
    string_blocks: 48,      // the string's length: the walk, animal to animal, a bringer goes out of its way to tie more on
    string_max: 5,          // most animals one string ties, and never more than the pen has room for
    string_slice_ms: 60,    // the route search's clock for pricing one hop of the string
    call_shepherd_blocks: 24, // a bringer this near its standby cell says `near` and the board calls the shepherd:
                              // its fetch and walk (~16 s) overlap the last of the lead, so neither stands long
    feed_take_ms: 1500,     // the wait, after a feed, for the wheat in hand to be taken; untaken, the feed is tried once more
    shear_reach: 3,         // the server's entity interaction range: an animal farther than this is not shorn
    shear_walks: 3,         // walks toward one animal that keeps moving before the shearer passes it by
    dye_reach: 3,           // the server's entity interaction range: an animal farther than this is not dyed
    // CULLING (cull_executor): a culler strikes one animal until it dies, then the next, with the combat code's reach and
    // charge (combat_utils).
    strike_walks: 3,        // walks toward one animal that keeps moving before the culler passes it by
    strikes_max: 20,        // strikes at one animal before the culler passes it by
    strike_ms_max: 30000,   // the longest a culler works one animal before it passes it by
    // THE KEEPER WATCHES EVERY PEN (foreman/pen_keeper): every animal by its id, in and out, read off the keeper's body.
    keeper_tick_ms: 250,    // how often the keeper reads every pen's animals, the gate and the bodies beside it
    keeper_sight_blocks: 48, // a pen whose middle is farther than this from the keeper's body is not seen: unknown, never empty
    keeper_near_blocks: 8,  // the bodies this close to an animal that left its pen are named beside it, with their hands
    wolf_alert_blocks: 16,  // a wolf this close to a pen's fence is said
    wolf_warn_ms: 60000,    // one warning per wolf per this interval while it stays near
};
for (const [pen, row] of Object.entries(HERDING.pens)) {
    if (typeof row.animal !== 'string' || !HERDING.wheat_followers.includes(row.animal)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): HERDING.pens.${pen}.animal is ${JSON.stringify(row.animal)}; a pen holds an animal held wheat leads (HERDING.wheat_followers).`);
    }
    if (row.herd_until !== null && !(Number.isInteger(row.herd_until) && row.herd_until >= HERDING.breed_pair_min)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): HERDING.pens.${pen}.herd_until is ${row.herd_until}; it is null or a stock of at least breed_pair_min (${HERDING.breed_pair_min}), so the pen herds enough to breed.`);
    }
    if (row.cull_keep !== null && !(Number.isInteger(row.cull_keep) && row.cull_keep >= HERDING.breed_pair_min)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): HERDING.pens.${pen}.cull_keep is ${row.cull_keep}; it is null or a whole stock of at least breed_pair_min (${HERDING.breed_pair_min}), so the pen can still breed.`);
    }
}
// THE HERD'S WHEAT: the wheat the crew holds for leading and holding animals, shown and never fed. A herd needs a wheat
// for its bringer and one for its shepherd, and every pen may be tended at once, so the keep is that for every pen.
// Breeding feeds only the wheat past it (assessors/ranching), and bread is baked only past INGREDIENT_KEEP.wheat, which is
// never under it (checked below), so neither eats the wheat the herd is led with.
const HERD_WHEAT_KEEP = HERDING.herders * Object.keys(HERDING.pens).length;

// ── PHANTOM REST: A MOMENT IN THE SPAWN BED (bed_rest, assessors/spawn_bed, phantom_rest_executor) ─────────────────
// Phantoms come to a player who has not slept for three days. While the server spawns them (its gamerule spawn_phantoms;
// the foreman turns it off at every launch, so the rest is off until it is turned on in the server), a body near the
// crew's one spawn bed that has not lain down for longer than rest_after_ticks lies down at night for lie_ms and gets
// up. One body at a time (the bed holds one). A body far from the bed is never called back for it.
//   near_blocks       a body this near the spawn bed rests; farther off it does not
//   rest_after_ticks  the world ticks since this body last lay down before it rests again: one day
//   lie_ms            how long it lies down
//   ask_ms            how often the server is asked whether phantoms spawn
//   retry_ms          after the server refused a lie-down (monsters near, the bed taken), the body asks again after this
//   occupied_wait_ms  the longest a body at the bed waits for a peer lying in it to get up
const PHANTOM_REST = Object.freeze({ near_blocks: 32, rest_after_ticks: 24000, lie_ms: 1000, ask_ms: 60000, retry_ms: 30000, occupied_wait_ms: 8000 });

// ── WILD WOOL: WOOL OFF ANY SHEEP NEAR THE HIVE (assessors/wild_wool, shear_wild_executor) ─────────────────────────
// SHEARING IS ONE TRADE WITH PENNING APART: every wool still owed (flock_colors.wantedWool: the supports' beds and the
// large build's wool) is shorn off whatever sheep carries it, pen or wild. The pen's shearing (assessors/ranching) ranks
// first on the board, so a penned sheep is preferred; a wild sheep is shorn beside it, by one body with the crew's
// shears, taken from the chest and put back, whether or not a pen is raised or full.
//   colors        the colors wild sheep grow: an owed color off this list waits for a pen and its dye
//   hive_blocks   a sheep is shorn only within this many blocks (horizontal) of the bot hive's origin: the server is
//                 asked for the woolly sheep inside that ring (wild_wool.askHerd), and none farther is walked to
//   herd_ask_ms   how often one body asks the server for the woolly sheep round the hive
//   ask_most      the nearest wild sheep the server is asked about at once (which are woolly, and their colors)
//   sheep_most    the most sheep one shearing walks to before it banks what it has
//   retry_ms      after a body found no woolly wild sheep of the color it went for, it posts that color again after this
//   settle_ms     the wait after a shearing for the wool to land before it is picked up
const WILD_WOOL = Object.freeze({
    settle_ms: 800,
    colors: Object.freeze(['white', 'black', 'gray', 'light_gray', 'brown', 'pink']),
    hive_blocks: 160,
    herd_ask_ms: 30000,
    ask_most: 12,
    sheep_most: 6,
    retry_ms: 120000,
});

// DYES — the sixteen wool colors, each with the dye that makes it and where that dye comes from. Animals are herded
// whatever their color (the string ties the nearest): the pen's colors are made by dyeing white animals, so they are
// deterministic. `from` is what the recipe book (crafting_blueprints.json) crafts the dye from. `ease`:
//   easy — a surface flower or bone meal, picked near home or kept in storage (DYE_STOCK);
//   trip — a source found in one biome family (`biomes`): a body with none in reach is sent by sector_finder to a book
//          sector recording it or those biomes, else to the biome the server locates (a DECORATION_LOCATE source) or
//          to scan the next frontier sector;
//   hard — no fleet source yet. The dye is held at the gate and the hold says why (`why`).
// A mix lists the two dyes it is crafted from; its ease is the harder of the two.
// Squid live in rivers and oceans; their ink is dived for (custom_api/squid_hunt over ink_diver).
const SQUID_WATERS = Object.freeze(['river', 'frozen_river', 'ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'lukewarm_ocean',
    'deep_lukewarm_ocean', 'warm_ocean', 'frozen_ocean', 'deep_frozen_ocean']);
const DYES = Object.freeze({
    white:      { dye: 'white_dye',      ease: 'easy', from: ['bone_meal'] },
    light_gray: { dye: 'light_gray_dye', ease: 'easy', from: ['azure_bluet'] },
    gray:       { dye: 'gray_dye',       ease: 'trip', from: ['black_dye', 'white_dye'] },
    black:      { dye: 'black_dye',      ease: 'trip', from: ['ink_sac'], biomes: SQUID_WATERS },
    brown:      { dye: 'brown_dye',      ease: 'trip', from: ['cocoa_beans'], biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle'] },
    red:        { dye: 'red_dye',        ease: 'easy', from: ['poppy'] },
    orange:     { dye: 'orange_dye',     ease: 'easy', from: ['orange_tulip'] },
    yellow:     { dye: 'yellow_dye',     ease: 'easy', from: ['dandelion'] },
    lime:       { dye: 'lime_dye',       ease: 'trip', from: ['green_dye', 'white_dye'] },
    green:      { dye: 'green_dye',      ease: 'trip', from: ['cactus'], biomes: ['desert', 'badlands'] },
    cyan:       { dye: 'cyan_dye',       ease: 'trip', from: ['blue_dye', 'green_dye'] },
    light_blue: { dye: 'light_blue_dye', ease: 'easy', from: ['blue_orchid'] },
    blue:       { dye: 'blue_dye',       ease: 'easy', from: ['cornflower'] },
    purple:     { dye: 'purple_dye',     ease: 'easy', from: ['blue_dye', 'red_dye'] },
    magenta:    { dye: 'magenta_dye',    ease: 'easy', from: ['allium'] },
    pink:       { dye: 'pink_dye',       ease: 'easy', from: ['pink_tulip'] },
});
// THE COLOUR SWAP: a dyed block (wool, carpet, bed, banner, candle, concrete, terracotta, stained glass, shulker box)
// whose dye comes only from a far biome is built in a common colour instead, in the same shape. The swap is made
// when a downloaded blueprint becomes a plan (js_kernel/blueprint_material_rule), so the plan holds only the common
// colour and no body ever reads the original; a plan made with another swap is refused at load until it is made
// again (downloaded_plan_registry). brown is cocoa (jungle); green is cactus (desert, badlands), and lime and cyan
// are mixed from green. Each colour swapped to is an `easy` dye (DYES): red from a poppy, yellow from a dandelion,
// blue from a cornflower.
const COLOR_SWAP = Object.freeze({ brown: 'red', green: 'yellow', lime: 'yellow', cyan: 'blue' });
for (const [from, to] of Object.entries(COLOR_SWAP)) {
    if (!DYES[from] || !DYES[to] || DYES[to].ease !== 'easy' || COLOR_SWAP[to]) {
        throw new Error(`[architect_config] CODING VIOLATION: COLOR_SWAP ${from} → ${to} must swap a dye colour for an easy one that is not itself swapped.`);
    }
}
// THE DECORATION LOCATE: a dye source wanted only for decoration whose biomes are rare is not
// searched for ring by ring. Past the book, the foreman asks the server where the nearest of its biomes lies (`locate
// biome`, one tag per command) and the body walks there (custom_api/sector_finder, foreman/decoration_locate). A strict
// whitelist: each entry is a DYES source, its reason is decoration, and it is never a survival material nor anything
// underground (an ore, a cave biome); foreman/decoration_locate refuses at load and on every ask anything else.
const DECORATION_LOCATE = Object.freeze({
    cocoa_beans: Object.freeze({ dye: 'brown_dye', reason: 'decoration', locate: Object.freeze(['#minecraft:is_jungle']) }),
    ink_sac:     Object.freeze({ dye: 'black_dye', reason: 'decoration', locate: Object.freeze(['#minecraft:is_ocean', '#minecraft:is_river']) }),
});
// The server's sheep Color tag, 0..15, in the game's own order.
const WOOL_COLORS = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);
for (const c of WILD_WOOL.colors) {
    if (!WOOL_COLORS.includes(c)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): WILD_WOOL.colors names '${c}', which is no wool color.`);
    }
}
// What storage keeps for the dyes before the composter may have any (compost_executor.bankedCompostables):
//   flowers      — the flowers a dye is made from; of each, storage keeps only what the wool still owed will be dyed
//                  with (flock_colors.flowersKept), and the rest is compost;
//   bone_meal    — bone meal kept for white dye; every other use (the field, the craft of more) takes only what lies past it.
const DYE_STOCK = Object.freeze({
    flowers: SURVEY_FLOWERS,
    bone_meal: 5,
});
// What storage keeps of an ingredient before any craft may spend it: a craft takes only what lies past the keep
// (supply_manager Step 4a; job_gates.chainGate holds the craft until there is some). Wheat: the pen's lead and feed,
// shown to herd sheep and fed to breed them, so bread is baked only from wheat past it: half the wheat row's stack.
const INGREDIENT_KEEP = Object.freeze({
    wheat: 32,
    // A crew whose build carries no cane: the cane field's replanting, twelve stalks. A build's cane is held whole until
    // all of it is grown (calculators/ingredient_keep, THE CANE HOLD).
    sugar_cane: 12,
});
if (INGREDIENT_KEEP.wheat < HERD_WHEAT_KEEP) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): INGREDIENT_KEEP.wheat is ${INGREDIENT_KEEP.wheat}, under HERD_WHEAT_KEEP (${HERD_WHEAT_KEEP}); bread would eat the wheat the herd is led with.`);
}

// Hunger / eating (Law 17 self-preservation). Minecraft food is 0–20.
const HUNGER_EAT_THRESHOLD      = 18;
const HUNGER_MUST_EAT_THRESHOLD = 0;
const HUNGER_FULL               = 20;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTROL PROGRAM — the crew and the foreman
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// The foreman's own player name; NOT in BOT_SENIORITY — the roster is bots, the foreman is staff.
const FOREMAN_NAME = 'Foreman';

// ── WHAT A CREW MAY BUILD AS ITS LARGE BUILD, AND THE NUMBERS ITS SITE IS FOUND WITH ──────────────────────────
// w/l/below/blocks ARE THE PLAN'S OWN NUMBERS, checked against it at downloaded_plan_registry.load.
const BUILDS = Object.freeze({
    // One row per hive (HIVES), each stacked from its floors at the start of a run.
    ...Object.fromEntries(Object.entries(HIVES).map(([name, hive]) => [name, Object.freeze({
        name, blueprint: name,
        get w() { return require('@kernel/blueprint_registry').getBuilding(name).dimensions.w; },
        get l() { return require('@kernel/blueprint_registry').getBuilding(name).dimensions.l; },
        get blocks() { return require('@kernel/blueprint_plan_calculator').authoredVoxels(require('@kernel/blueprint_registry').getBuilding(name), this.beds).length; },
        // A number: that many of the room's beds, up to its capacity; 'all': every one.
        get beds() { const capacity = require('@kernel/blueprint_registry').getBuilding(name).design_intent.bed_capacity; return hive.beds === 'all' ? capacity : Math.min(hive.beds, capacity); },
        get below() { return require('@kernel/blueprint_anchor_calculator').ENTRY_FEET_BELOW; },
        ring: 4, maxTolerance: 3,
        // Planks hold the cell of a fixture whose material no job gathers yet: flint, string and blaze rods, and with
        // enchanting off every block made of books (a support raises no cow pen, so no leather and no book).
        get substitutions() { return { fletching_table: 'planks', loom: 'planks', brewing_stand: 'planks', ...(hive.enchanting ? {} : { enchanting_table: 'planks', bookshelf: 'planks', lectern: 'planks' }) }; },
    })])),
    medieval_house_with_full_interior_from_abfielder: Object.freeze({
        name: 'medieval_house_with_full_interior_from_abfielder', w: 25, l: 47, below: 4, ring: 4, blocks: 5800, maxTolerance: 3,
    }),
    house_from_abfielder: Object.freeze({
        name: 'house_from_abfielder', w: 46, l: 24, below: 4, ring: 4, blocks: 3758, maxTolerance: 3,
    }),
    use_this_from_abfielder_1: Object.freeze({
        name: 'use_this_from_abfielder_1', w: 32, l: 31, below: 4, ring: 4, blocks: 3405, maxTolerance: 3,
    }),
    overgrown_survival_castle: Object.freeze({
        name: 'overgrown_survival_castle', w: 41, l: 53, below: 9, ring: 4, blocks: 25064, maxTolerance: 3,
    }),
});

// ── SIGNED-OUT ITEMS: A TOOL ONE BODY TAKES FROM THE CHESTS AND BRINGS BACK ─────────────────────────────────────
// Item → every form it is held in. A chest row for one of these counts it in every body's pocket as well as the
// chests (inventory_lens.forChestRequest), so a bucket out at the wheat field, empty or full, is the crew's one
// bucket signed out, not a shortfall to craft again.
const SIGNED_OUT_ITEMS = Object.freeze({
    bucket: Object.freeze(['bucket', 'water_bucket', 'lava_bucket']),
    shears: Object.freeze(['shears']),
    diamond_pickaxe: Object.freeze(['diamond_pickaxe']),
});

// ── ARMOR IS COPPER OR BETTER, AND FOR FIGHTING ON PURPOSE ────────────────────────────────────────────
// `tiers`, worst first, are what custom_api/armor counts as armor; below copper (leather, gold) it is no armor at all.
// Copper is the terminator's floor (terminator_kits T-1): a body that fights on purpose blocks most blows with its shield,
// so the lightest set that can be made from the mine's copper is enough to field one. `sets` is the fewest sets a
// fight-on-purpose job works with. Everyday work defends by avoidance, then the shield.
const ARMOR = Object.freeze({ tiers: Object.freeze(['copper', 'iron', 'diamond', 'netherite']), sets: ARMOR_SETS });

// ── THE BASE IS SITED ONE STRUCTURE AT A TIME AND LIT OVER THE GROUND AS IT STANDS (lock_all_buildspots, base_layout)
// A crew's structures are sited one after another, each on its own ground (surface_site, footprint_survey.siteBeside):
// the alpha structure first, then each support beside the one it serves, nearest first; a support with no spot there
// is sited beside any structure already placed, nearest first, so every support finds a place while the land holds one.
// THE BASE AREA is the ground of the base's parts joined: every sited footprint widened by `margin`, and a walk `path` blocks
// to either side of the line joining each part to its nearest neighbour (the shortest joins that connect every part), never
// the empty ground of the box round them all. Every crew lights it with
// one generated blueprint, its spawn proofing (base_layout.proofingBuilding): torches on `post_block` posts standing on the ground as it
// is, no earthwork. The posts are painted at siting over the ground the survey read (base_layout.paintLights): one on
// a grid every `every` blocks, then one on each stand cell the grid leaves dark, nearest the area's middle first,
// until the game's light rule (light_calculator) lights every stand cell of the area over TORCH_NETWORK.lit_above.
// A stand cell is the air over a land column of the area outside every footprint whose ground lies no more than `deep`
// under the area's middle ground height (deeper is a ravine or a pit, not the base's ground); a footprint counts opaque
// (its build lights itself); the ground's trees count felled. A post stands on a land column with no trunk, `ring` or
// more from every footprint, with a land column beside it a body stands on to place it.
//   every       blocks between two grid posts on either axis
//   margin      blocks round each footprint the area takes in
//   path        blocks to either side of the line joining two parts the walk between them takes in
//   ring        the nearest a post stands to a footprint, so none stands against a fence, a gate or a door
//   deep        the most a stand cell's ground lies under the area's middle ground height
//   post_block  the block a torch stands on, one over the ground; the torch is two over it
//   limit       the most posts one base takes; a base its limit leaves dark is refused at siting
//   trip        the posts one claim builds (a `post_block` and a torch each), nearest after nearest, as one section;
//               every section the pool pays for is a seat of its own, and a body back from one takes the next off the board
//   clear_radius the blocks round a finished post in which that same claim fells every trunk (post_clearing). The posts wait
//               on no felling: the lights come first and the base's other trees are left standing
const BASE_LIGHTS = Object.freeze({ every: 10, margin: 12, path: 6, ring: 2, deep: 8, post_block: 'cobblestone', limit: 400, trip: 3, clear_radius: 3 });
// The base's spawn proofing: the generated blueprint of its torch posts. Every crew lights its base with it.
const SPAWN_PROOFING = 'spawn_proofing';

// ── THE STONE PIERCE: THE HEADFRAME'S AND THE FIRST FURNACES' STONE FROM ONE COLUMN AT A TIME ───────────────────────
// The headframe's stone and the first furnaces' while the mine is shut: a 1-wide shaft straight down through the ground
// to a run of `stone`, sealed on the way back up (custom_api/stone_pierce, stone_column_scanner). The column is sought
// over the body's whole loaded area. No stone is taken open to the sky; every other building's waits for the mine.
//   stone_run       uninterrupted `stone` blocks the column must hold under its ground
//   max_overburden  the most non-stone ground over the run
//   min_radius      the nearest column to the body, so it never opens the cell it stands on
//   station_reach   how far round the body stations are read, so no column is opened beside one: the loaded area
//   exit_reach      how far from the body that nearest permitted column is looked for
//   scan_batch      columns read before the scan asks whether anything fit
//   max_batches     batches read once the first fit is found, before the list is handed over
//   min_fits        the ranked list's floor before the scan stops early
//   scan_up         rows above the body's feet the ground is looked for in
//   scan_down       rows below
//   max_approaches  ranked columns claimed and walked to before the trip concedes
//   filler_reserve  spendable blocks the body holds before it goes down, to seal its way back up
const STONE_PIERCE = Object.freeze({
    stone_run: 9, max_overburden: 6, min_radius: 2, station_reach: 192, exit_reach: 128, scan_batch: 64, max_batches: 4, min_fits: 12,
    scan_up: 16, scan_down: 24, max_approaches: 8, filler_reserve: 12,
});

// ── NO BLUEPRINT STANDS CLOSER THAN BLUEPRINT_SPACING TO ANOTHER ─────────────────────────────────────────────
// Footprint edge to footprint edge, in blocks: the floor under every siting gap below and under the clearance
// find_buildingspot keeps (lock_all_buildspots). A gap may be set wider; none is set narrower.
const BLUEPRINT_SPACING = 5;

// ── NO BLUEPRINT IS SITED WHERE WATER CAN REACH IT ───────────────────────────────────────────────────────────
// Every column within WATER_CLEARANCE of a footprint is free of surface water at siting, and every column under
// the footprint is free of water within WET_DEPTH under its first land (the scrape_max a site allows), where the
// crew's cut can open it. Flowing water spreads seven blocks over flat ground, so a source eight away cannot reach
// the footprint after it is sited. A blueprint that holds water has its water placed by the crew later, never found
// there (footprint_survey.wetNear). Columns outside the loaded area count wet.
const WATER_CLEARANCE = 8;
const WET_DEPTH = 2;

// Where a crew's waste pit may go, relative to its home (the headframe): the nearest spot min_gap or more
// from the home's footprint and every footprint sited before it, its pad within ±rise of the home floor. Every trip's
// leftovers are carried from the home to the pit, so the nearest level spot wins. fill_max is 0: the pad is cut, never filled,
// so the pit is built with no material.
const WASTE_PIT_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 24, rise: 1, scrape_max: 2, fill_max: 0 });

// Where a crew's crop fields and water pool may go. The pool stands beside the home, the nearest spot min_gap or more
// from every footprint sited before it and the shallow shaft's whole run. The first wheat field and the first cane field
// stand in the farm ring, beside the base's outermost structure and farther out, by the same rule; every copy attaches
// to its crop's cluster, touching (lock_all_buildspots siteFieldCluster), and keeps min_gap from everything else. A
// field stands on the surface (utils/surface_site): its floor is the middle height of the ground under it, ground up
// to scrape_max over that is cut and ground up to fill_max under it is filled.
// attach_scrape_max / attach_fill_max: the cut and fill an attached copy may take to stand on its cluster's floor, looser
// than a field sited on its own, so a copy attaches wherever the ground allows and starts a new cluster only where not.
const WHEAT_FIELD_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 48, scrape_max: 2, fill_max: 2, attach_scrape_max: 4, attach_fill_max: 4 });

// Where each of a crew's pens may go: beside its home (the headframe), flanking it in the ring of the hive, min_gap
// or more from every footprint sited before it (a second pen keeps clear of the first), by the field's own rule:
// nearest first, on the surface. Two layers of cut or fill keep its floor in the soil, so the grass left standing at
// floor height spreads over the cut and filled cells.
// apart_degrees: of every two pens, the least angle between their standby sides: 180, the gates on opposite ends.
// behind_degrees: the least angle between one pen's standby side and the other pen seen from its middle: each pen
// stands behind the other, away from its gate (lock_all_buildspots penApart).
// The portal's mould stands in the base, sited as the other small structures are, beside the home.
const PORTAL_MOULD = 'lava_portal_mould';
const PORTAL_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 48, scrape_max: 2, fill_max: 2 });
// SUPPORTS SWITCHED OFF: on the support list (STRUCTURE_PRIORITY) and raised by no crew: never sited, never posted
// (support_need.raises). The portal's mould is off: no crew casts or lights a portal.
const SUPPORTS_OFF = Object.freeze([PORTAL_MOULD]);
const PEN_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 48, scrape_max: 2, fill_max: 2, apart_degrees: 180, behind_degrees: 135 });

// Where the bot hive may go: the nearest plot to the headframe's footprint, edge to edge, that passes the hive's own plot
// rules (footprint_survey.surveyFootprintNear: ground in BASE_BIOMES, level within BUILDS.bot_hive.maxTolerance, the ring
// land, no water within WATER_CLEARANCE, a dry pit), min_gap or more from the headframe, its shaft's run and every
// footprint sited before it, and its own ring clear of each (a gap of at least ring + 1).
//   search_to  the farthest gap searched: the waste pit's reach, so the hive stands within the walk the crew makes from
//              the home every trip; past it the landing is refused and rolls again
//   stride     blocks between two plots tried, on either axis: every plot, so the nearest one is found
//   tries      the most nearest-first plots whose pit is read voxel by voxel before the landing is refused; a plot whose
//              pit holds water usually shares it with its neighbours, so past this many the ground is wet throughout
const HIVE_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 24, stride: 1, tries: 64 });
// LARGE_SITING — where the large build (LARGE_BUILD) stands: the nearest plot outside the whole base, sited after it,
// kept min_gap clear of every footprint and, where monsters spawn, of the lit ground (lock_all_buildspots.sitePlanned).
// Its plot rules are its BUILDS row's, as the hive's are. search_to reaches past the base's far side; stride 2 halves
// each axis of a search a large footprint makes costly; tries as the hive's.
const LARGE_SITING = Object.freeze({ min_gap: BLUEPRINT_SPACING, search_to: 48, stride: 2, tries: 64 });

// ── THE TREE FARM (custom_api/sapling_planter) — A CREW PLANTS ITS BUILD'S TWO WOODS BESIDE ITS BASE ──────────
// THE FARM begins where the base ends: every grid cell GATHER_KEEPOUT or more from every sited footprint, the base's
// lights box included, so no farm tree stands where the crew builds, tends or clears canopy. It runs out to the loaded
// area round home (GATHER_REACH from the home structure's origin). Its cells are a grid `spacing` apart
// (perception_nodes/tree_farm_ground owns the geometry).
// THE HOME BAND is the farm's cells within `close` of its start. THE INTEGRITY KEEPER KEEPS ITS MAP (the
// `tree_farm` verdict): each cell treed, open or blocked, and the band's saturation, treed over treed and open. No body
// counts the farm for itself.
// A sapling is planted in two ways, which together keep the forest without over-foresting any of it:
//   - IN PLACE, by the harvester: after each felling outside the keep-out, ONE sapling where the tree stood. The
//     forest it fells is kept as it was, never thickened. The rest of what it carries rides home and is banked.
//   - THE HOME BAND, by the sapling_plant chest job (assessors/tree_farm): while the keeper reads the band below
//     `saturation` percent and the chests hold a farm sapling, one body takes up to `batch` out and plants the band's
//     open cells nearest home first. At the target it stops, and plants again only when a felling opens the band.
// The saplings neither way plants bank, and past `bank` go to the composter.
//   keep        farm saplings a pocket keeps of each; past it they are banked like any surplus
//   bank        farm saplings the chests keep of each before the composter may have any (compost_executor)
//   spacing     blocks, centre to centre, between a sapling and any other sapling or trunk
//   ring        the width of the rows out from the farm's start a planting walks, nearest row first
//   close       the depth, out from the farm's start, of the home band the keeper counts and the chest job fills
//   saturation  percent of the home band's plantable cells treed at which the chest job stops
//   batch       the most farm saplings, both woods together, one planting job takes out of the chests
const TREE_FARM = Object.freeze({
    keep: 0, bank: 64, spacing: 3, ring: 8, close: 32, saturation: 80, batch: 32,
});
for (const k of ['keep', 'bank', 'spacing', 'ring', 'close', 'saturation', 'batch']) {
    if (!Number.isInteger(TREE_FARM[k]) || TREE_FARM[k] < 0) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): TREE_FARM.${k} is ${TREE_FARM[k]}; it is a whole number of zero or more.`);
    }
}
if (TREE_FARM.spacing < 1 || TREE_FARM.ring < 1 || TREE_FARM.batch < 1 || TREE_FARM.saturation > 100) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): TREE_FARM needs a spacing, a ring and a batch of at least 1, and a saturation of at most 100.`);
}

// TERMINATOR_POSTS — WHERE THE BASE'S TERMINATOR (T-1) WAITS. It idles at the crew's park spot (action_fragments.js/idle_park),
// the one idle place of the home. After a battle of its own it holds where the battle left it for `after_battle_ms`, in case
// the fight comes back, and only then returns to the park (action_fragments.js/terminator_planner). Every battle a body of the
// crew opens is counted to the nearest of the `anchors` (custom_api/battle_ledger) as a record: it chooses no post today, and
// is kept for lighting the places fights recur and for a base spread too wide for one park spot. The anchors also bound the
// terminator's targets (TARGET_LEASH round each).
//   anchors          structure names (their building rooms): the hive, then
//                    the headframe. The tree farm is the band round the headframe, so its battles count to the headframe.
//                    The mine is not one yet.
//   after_battle_ms  how long a terminator holds the place of its last battle
//   stand_search     blocks round an anchor searched for open dry ground to stand on, outside every footprint
// TERMINATOR_SEATS — how many full-time terminators (T-1) the crew keeps. A seat open is a terminator_duty job posted to
// every bot that could hold the kit's floor (assessors/terminator_duty); the first to take it fills it. A terminator that
// steps down (terminator_planner) or leaves the world opens its seat again.
const TERMINATOR_SEATS = 1;
// THREAT_ZONE_B — the threat zone: a hostile on the surface within this of a sited structure's origin is a threat on the
// foreman's board (foreman/threat_board), the list a T-1 works. It lies inside what the keeper's body at the base is sent.
const THREAT_ZONE_B = 64;
if (!Number.isInteger(THREAT_ZONE_B) || THREAT_ZONE_B < 1) throw new Error(`[architect_config] CODING VIOLATION (Law 13): THREAT_ZONE_B is ${THREAT_ZONE_B}; it is a whole number of blocks, at least 1.`);
if (!Number.isInteger(TERMINATOR_SEATS) || TERMINATOR_SEATS < 0) throw new Error(`[architect_config] CODING VIOLATION (Law 13): TERMINATOR_SEATS is ${TERMINATOR_SEATS}; it is a whole number of zero or more.`);

const TERMINATOR_POSTS = Object.freeze({
    anchors: Object.freeze([BOT_HIVE, ALPHA_STRUCTURE]),
    after_battle_ms: 180000,
    stand_search: 16,
});
for (const name of TERMINATOR_POSTS.anchors) {
    if (typeof name !== 'string' || !/^[a-z_0-9]+$/.test(name)) throw new Error(`[architect_config] CODING VIOLATION (Law 13): TERMINATOR_POSTS.anchors names ${JSON.stringify(name)}; an anchor is a structure's name.`);
}

for (const [name, row] of Object.entries({ WASTE_PIT_SITING, WHEAT_FIELD_SITING, PEN_SITING, PORTAL_SITING, HIVE_SITING, LARGE_SITING })) {
    if (!(row.min_gap >= BLUEPRINT_SPACING)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): ${name}.min_gap is ${row.min_gap}; no blueprint stands closer than BLUEPRINT_SPACING (${BLUEPRINT_SPACING}) to another.`);
    }
}

// ── THE WHEAT FIELD: THE STRUCTURE, ITS ROOM KEYS AND THE DESIGN ONE ROOM IS BUILT TO ─────────────────────────
// One nine-by-nine field with its water poured from a bucket; its room keys are the wheat field and the other crop
// fields (farmland_site.CROPS: the cane field), each built to its own blueprint and tended with it. The farming triad
// (farming_integrity, assessors/farming, farm_manager) reads it. Every crew farms.
// CRITICAL MASS: the pens eat wheat as fast as they breed, so the crew grows enough wheat in ONE harvest to breed every
// pen full. calculators/wheat_critical_mass works out how many wheat fields that takes; the first is `structure`, the
// rest are its `copies` (room keys wheat_field_2 and on, each built to the same design: blueprint_registry serves the
// copy), attached to the wheat cluster by its attach points, touching (lock_all_buildspots siteFieldCluster). Only the first field orders seeds from the grass;
// a copy is sown from the seeds the harvests bring back (farming_integrity, THE SEED ORDER).
//   margin       share of the breeding wheat grown over it
//   fields_max   the most wheat fields a crew sites, the first included
const WHEAT_CRITICAL_MASS = Object.freeze({ margin: 0.25, fields_max: 6 });
if (!(WHEAT_CRITICAL_MASS.margin >= 0) || !Number.isInteger(WHEAT_CRITICAL_MASS.fields_max) || WHEAT_CRITICAL_MASS.fields_max < 1) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): WHEAT_CRITICAL_MASS is ${JSON.stringify(WHEAT_CRITICAL_MASS)}; margin is a share of 0 or more and fields_max a whole number of 1 or more.`);
}
const WHEAT_FIELD_COPIES = Object.freeze(Array.from({ length: WHEAT_CRITICAL_MASS.fields_max - 1 }, (_, i) => `wheat_field_${i + 2}`));
// THE CANE FIELDS GROW THE BUILD'S SUGAR CANE (calculators/cane_critical_mass): the build's paper, read off its plan, is
// grown in `hours` by enough cane fields, each of its plants yielding about one block every `grow_minutes`. The first is
// 'cane_field', the rest its copies (room keys cane_field_2 and on, built to the cane field's design). Every one is sited
// up front, so its footprint is reserved before any tree is planted (sapling_planter keeps GATHER_KEEPOUT from every
// footprint): the first in the farm ring outside the base's blueprints, each copy attached to the cluster by its attach
// points, touching, growing away from the home (lock_all_buildspots siteFieldCluster). Cane is the build's alone: the
// first field is planted from wild cane (WILD_CANE), every copy from the cane the harvests bring back, cut above the
// bottom block and planted again, so the cane doubles about every round of growth until every field is planted full;
// from then the cane cut past its replanting is spent as it comes (calculators/ingredient_keep THE CANE HOLD). Once the
// cane standing and held reaches the build's need, every field but the first is cut to the
// ground, and the first keeps its bottom blocks to grow again (farmland_site THE LAST CUT). A crew whose build carries
// no cane sites no cane field (support_need).
//   margin        share of the build's cane grown over it
//   hours         the time the fields together grow the build's cane in
//   grow_minutes  minutes one plant takes to grow one block of cane
//   fields_max    the most cane fields a crew sites, the first included
const CANE_CRITICAL_MASS = Object.freeze({ margin: 0.25, hours: 2, grow_minutes: 18, fields_max: 6 });
if (!(CANE_CRITICAL_MASS.margin >= 0) || !(CANE_CRITICAL_MASS.hours > 0) || !(CANE_CRITICAL_MASS.grow_minutes > 0)
    || !Number.isInteger(CANE_CRITICAL_MASS.fields_max) || CANE_CRITICAL_MASS.fields_max < 1) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): CANE_CRITICAL_MASS is ${JSON.stringify(CANE_CRITICAL_MASS)}; margin is a share of 0 or more, hours and grow_minutes above 0, fields_max a whole number of 1 or more.`);
}
// WILD CANE (assessors/farming, harvest_executor): wild cane plants the first cane field only. ONE body at a time gathers
// it while the first field's unsown slots are more than the cane the fleet reaches, scanning sector after sector with no
// backstop (sector_finder RINGS); once the first field can be planted no wild cane is gathered. Its order
// is one pledge, one seat. A trip cuts each plant whole at its bottom block and is TIMED: walking (to the first cane,
// between patches, to another sector) against cutting. It ends with the pledge in the pocket, or, before any walk past
// its first patch, once walking is more than `walk_share` of the trip's time, and banks what it cut.
//   pledge      cane one trip brings back
//   walk_share  the most of a trip's time walking may take before it walks on to more cane
const WILD_CANE = Object.freeze({ pledge: 15, walk_share: 0.4 });
if (!Number.isInteger(WILD_CANE.pledge) || WILD_CANE.pledge < 1 || !(WILD_CANE.walk_share > 0 && WILD_CANE.walk_share < 1)) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): WILD_CANE is ${JSON.stringify(WILD_CANE)}; pledge is a whole number of 1 or more and walk_share a share between 0 and 1.`);
}
const CANE_FIELD_COPIES = Object.freeze(Array.from({ length: CANE_CRITICAL_MASS.fields_max - 1 }, (_, i) => `cane_field_${i + 2}`));
// copies   every field copy, wheat and cane; copyOf: copy room key → the field it is built to (blueprint_registry serves it).
// pool     the crew's one water pool (blueprint water_pool): a field the triad builds first, every pour filled from it.
const FARM_FIELD = Object.freeze({
    structure: 'wheat_field', design: 'wheat_field', cane: 'cane_field', pool: 'water_pool',
    keys: Object.freeze(['water_pool', 'wheat_field', ...WHEAT_FIELD_COPIES, 'cane_field', ...CANE_FIELD_COPIES]),
    copies: Object.freeze([...WHEAT_FIELD_COPIES, ...CANE_FIELD_COPIES]),
    copyOf: Object.freeze(Object.fromEntries([...WHEAT_FIELD_COPIES.map(k => [k, 'wheat_field']), ...CANE_FIELD_COPIES.map(k => [k, 'cane_field'])])),
});
// The animal pens, each sited beside the home on the surface; HERDING.pens names each one's animal. Sheep, for the
// wool of beds, carpets and banners; cows, for meat and the leather of books (producer_hooks).
const FARM_PENS = Object.freeze(['sheep_pen', 'cow_pen']);
for (const pen of FARM_PENS) {
    if (!HERDING.pens[pen]) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): FARM_PENS names the pen '${pen}', which has no HERDING.pens row naming its animal.`);
    }
}

// ── A FROZEN SERVER ENDS THE RUN (js_kernel/server_pulse) ─────────────────────────────────────────────
// The server sends its time once a second from its tick loop. warn_ms of silence is said; the end is
// timeout_crash's one limit, and it ends the whole run. self_ms: a body whose own once-a-second check arrives this late was itself frozen.
const SERVER_SILENCE = Object.freeze({ warn_ms: 5000, self_ms: 2000 });

// ── STRUCTURE PRIORITY: WHICH SITE'S WORK IS PREFERRED, NEVER WHICH SITE MAY START ─────────────────
// Read by `job_ranking` as a third coordinate inside the blueprint band (Law 27); nothing here refuses a job.
// The headframe's stone is pierced until the mine is open (STONE_PIERCE).
// The hive is a support and ranks with the others; a large build, when named, closes the list and ranks last.
const STRUCTURE_PRIORITY = Object.freeze(['headframe', 'waste_pit', 'shallow_shaft', 'spawn_proofing', 'water_pool', 'wheat_field', 'sheep_pen', 'cow_pen', 'cane_field', BOT_HIVE, 'lava_portal_mould', ...(LARGE_BUILD ? [LARGE_BUILD] : [])]);
// THE ALPHA PHASE (phase 1): the home, the pit beside it and the mine's shaft under it, supplied before any support. The
// shaft's torches are its own order (assessors/mining MINE_TORCH_FUEL), so their charcoal ranks here too.
const ALPHA_PHASE = Object.freeze(['headframe', 'waste_pit', 'shallow_shaft']);
// ── THE HEADFRAME CLOCK: DAWN TO DUSK ───────────────────────────────────────────────────────────────────────────
// The shell must stand before dusk, so the grade bands are wall-clock seconds from the crew starting work.
const HEADFRAME_CLOCK = Object.freeze({
    structure: 'headframe',
    green_within_sec: 690,   // 11m 30s
    ok_within_sec: 720,      // 12m
    alert_from_sec: 780,     // 13m
    why: 'dawn to dusk — the alpha structure every other building waits on, and the crew\'s shelter for the first night (Law 17)',
    // WHAT STOPS THE CLOCK: the shell, not the last anchor.
    graded_anchor: 2,
});
if (!(HEADFRAME_CLOCK.green_within_sec < HEADFRAME_CLOCK.ok_within_sec && HEADFRAME_CLOCK.ok_within_sec < HEADFRAME_CLOCK.alert_from_sec)) {
    throw new Error('CODING VIOLATION (Law 13): HEADFRAME_CLOCK bands must rise — green < ok < alert.');
}
if (!Number.isInteger(HEADFRAME_CLOCK.graded_anchor) || HEADFRAME_CLOCK.graded_anchor < 0) {
    throw new Error(`CODING VIOLATION (Law 13): HEADFRAME_CLOCK.graded_anchor must be a whole anchor index, got ${HEADFRAME_CLOCK.graded_anchor}.`);
}

if (LARGE_BUILD !== null && (!BUILDS[LARGE_BUILD] || LARGE_BUILD === BOT_HIVE)) {
    throw new Error(`CODING VIOLATION (Law 13): foreman_config.build is '${LARGE_BUILD}'; it is empty or a large build the fleet knows. `
        + `The bot hive is a support every base raises and is never named. `
        + `Known: ${Object.keys(BUILDS).filter(v => v !== BOT_HIVE).map(v => `'${v}'`).join(' | ')} (architect_config.BUILDS).`);
}
if (new Set(STRUCTURE_PRIORITY).size !== STRUCTURE_PRIORITY.length) {
    throw new Error(`CODING VIOLATION (Law 13): STRUCTURE_PRIORITY must be a list of distinct structure names (got ${JSON.stringify(STRUCTURE_PRIORITY)}); `
        + `the large build '${LARGE_BUILD}' may not be a structure the base already raises.`);
}
if (STRUCTURE_PRIORITY[0] !== ALPHA_STRUCTURE) {
    throw new Error(`CODING VIOLATION (Law 13): the alpha structure '${ALPHA_STRUCTURE}' must open STRUCTURE_PRIORITY (got ${JSON.stringify(STRUCTURE_PRIORITY)}).`);
}
if (!ALPHA_PHASE.length || ALPHA_PHASE.some((s, i) => STRUCTURE_PRIORITY[i] !== s)) {
    throw new Error(`CODING VIOLATION (Law 13): ALPHA_PHASE must open STRUCTURE_PRIORITY in the same order, alpha first (got ${JSON.stringify(ALPHA_PHASE)} of ${JSON.stringify(STRUCTURE_PRIORITY)}).`);
}
// The priority lists the fields, the pens and the spawn proofing; support_need raises only those the plan and difficulty need.
// A wheat field copy ranks as the wheat field (job_ranking.measureSiteRank) and is sited as many as critical mass asks, so it is not in the priority.
for (const site of [...FARM_FIELD.keys.filter(k => !FARM_FIELD.copies.includes(k)), ...FARM_PENS, SPAWN_PROOFING]) {
    if (!STRUCTURE_PRIORITY.includes(site)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): the crew sites '${site}', but STRUCTURE_PRIORITY ${JSON.stringify(STRUCTURE_PRIORITY)} does not.`);
    }
}
if (!BUILDS[PLANNED_BUILD] || !STRUCTURE_PRIORITY.includes(BOT_HIVE)) {
    throw new Error(`CODING VIOLATION (Law 13): the planned build '${PLANNED_BUILD}' is a BUILDS row and the hive '${BOT_HIVE}' a support in STRUCTURE_PRIORITY.`);
}
if (SUPPORTS_OFF.some(key => !STRUCTURE_PRIORITY.includes(key) || ALPHA_PHASE.includes(key) || key === BOT_HIVE)) {
    throw new Error(`CODING VIOLATION (Law 13): SUPPORTS_OFF ${JSON.stringify(SUPPORTS_OFF)} may name only supports on STRUCTURE_PRIORITY, never the headframe, the waste pit or the hive.`);
}
if (LARGE_BUILD && STRUCTURE_PRIORITY[STRUCTURE_PRIORITY.length - 1] !== LARGE_BUILD) {
    throw new Error(`CODING VIOLATION (Law 13): the large build '${LARGE_BUILD}' must close STRUCTURE_PRIORITY.`);
}


// The short word a human says, and the item it means.
const ORDER_ALIASES = Object.freeze({
    cobble:  'cobblestone',
    stone:   'stone',
    plank:   'oak_planks',
    oak_log: 'oak_log',
    log:     'oak_log',
    iron:    'iron_ingot',
    gold:    'gold_ingot',
    coal:    'coal',
    torch:   'torch',
    glass:   'glass',
    dirt:    'dirt',
    sand:    'sand',
    wheat:   'wheat',
    bread:   'bread',
    stick:   'stick',
});

// THE GUARANTEE'S HOME IS HERE, not in a test file (the one-test rule).
for (const alias of Object.keys(ORDER_ALIASES)) {
    if (alias !== alias.toLowerCase()) {
        throw new Error(`CODING VIOLATION (Law 13): order alias "${alias}" is not lowercase — a human's words are compared lowercased, so a capital here is a word no human can ever match.`);
    }
}

module.exports = {
    HERDING, HERD_WHEAT_KEEP, WILD_WOOL, PHANTOM_REST, LEAF_PAIRS,
    DYES, COLOR_SWAP, DECORATION_LOCATE, WOOL_COLORS, DYE_STOCK, INGREDIENT_KEEP,
    WORLD_DEPTH_FLOOR_Y,
    SPAWN_PROTECTION_RADIUS,
    BASE_CLEAR_OF_SPAWN,
    SERVER_MINECRAFT_VERSION,
    SERVER_ENDPOINT,
    BOT_SENIORITY,
    FOREMAN_NAME,
    CREW,
    PORTAL_MOULD,
    PORTAL_SITING,
    SUPPORTS_OFF,
    STRUCTURE_PRIORITY,
    ALPHA_PHASE,
    BUILDS,
    DIFFICULTIES,
    CREW_DIFFICULTY,
    LARGE_BUILD,
    PLANNED_BUILD,
    PLANNED_BUILDS,
    SUPPORT_REPAIR,
    MAIN_BUILD,
    HIVES,
    BOT_HIVE,
    HOME_FIXTURES,
    ALPHA_STRUCTURE,
    SHAFT_HEAD,
    BLUEPRINT_SPACING,
    WATER_CLEARANCE,
    WET_DEPTH,
    BASE_LIGHTS,
    STONE_PIERCE,
    SPAWN_PROOFING,
    SIGNED_OUT_ITEMS,
    ARMOR,
    WASTE_PIT_SITING,
    WHEAT_FIELD_SITING,
    PEN_SITING,
    HIVE_SITING,
    LARGE_SITING,
    FARM_FIELD,
    WHEAT_CRITICAL_MASS,
    FARM_PENS,
    TREE_FARM,
    TERMINATOR_POSTS,
    TERMINATOR_SEATS,
    THREAT_ZONE_B,
    CANE_CRITICAL_MASS,
    WILD_CANE,
    SERVER_SILENCE,
    HEADFRAME_CLOCK,
    JOB_TYPE,
    JOB_CATEGORY_OF,
    JOB_STAGE_OF,
    JOB_AHEAD_OF_SITES,
    CATEGORY_NAMES,
    CATEGORY_INDEX,
    BAND_POLICY,
    PRE_BAND,
    PRE_BAND_MEMBERS,
    STAGES,
    STAGE_INDEX,
    BONE_MEAL_MAX_CROP_STAGE,
    SOURCE_BIOMES,
    COMPOST_RUN_ITEM,
    COMPOST_SEED_KEEP,
    COMPOST_DENSITY,
    BONE_MEAL_PER_VISIT,
    COMPOST_BATCH_MIN,
    CHEST_HOUSEKEEPING,
    BASE_SWEEP,
    MINING_LAST_PICKAXE,
    SHAFT_PICKAXES,
    SHAFT_TURNS,
    DEEP_ORES,
    DEEP_SEAT_FACTOR,
    SECTOR_SCAN,
    SURVEY_CATEGORIES,
    SURVEY_ORE_ITEM,
    WASTE_PIT,
    MINE_LAYOUT,
    CREEPER_FOOTWORK,
    MINING_PASSES_PER_DISPATCH,
    isNightTime,
    isDuskTime,
    DUSK_LEAD_TICKS,
    isPeacefulWorld,
    GATHER_REACH,
    GATHER_KEEPOUT,
    GATHER_KEEPOUT_GROUND,
    SURFACE_TREE_MARGIN,
    HEADFRAME_SAFE_RADIUS,
    PREDATOR_GUARD,
    AGGRO_RANGE,
    MOB_AGGRO_RANGE,
    AGGRO_VERTICAL_RANGE,
    aggroRangeFor,
    MOB_SIGHT_REACH,
    engageRangeFor,
    aggroCastRange,
    withinAggroRange,
    DISENGAGE_RANGE,
    TORCH_NETWORK,
    HUNGER_EAT_THRESHOLD,
    HUNGER_MUST_EAT_THRESHOLD,
    HUNGER_FULL,
    TYPE_COORDINATES,
    TYPE_BLUEPRINT_PASTED,
    TYPE_STRUCTURE_COMPLETE,
    BUILDING_REQUIREMENTS,
    TANDEM_PAIRS,
    STOCK_THRESHOLDS,
    BANNED_BIOMES,
    settles,
    BASE_BIOMES,
    BUILD_WOOD,
    SEA_LEVEL,
    LANDING_SURFACE_SLACK,
    LANDING_MAX_ABOVE_SEA,
    FUEL_PREFERENCES,
    WOOD_FUEL_ONLY_FOR,
    COPPER_FOR_IRON,
    STAND_INS,
};
