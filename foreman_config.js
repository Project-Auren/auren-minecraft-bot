// module: foreman_config
// purpose: everything the foreman is given before a run starts, as one ordered sentence, plus the address
//          of the world it runs in. The file most people who download this bot ever need to open.
//
// The first five fields below are that sentence, in order:
//
//     where       local · remote                  which world: the foreman starts yours, or joins one
//     start       rollback · continue             from a clean start, or from where the last run stopped
//     soak        minutes                         how long it runs, then it shuts everything down
//     difficulty  peaceful · normal · hard        the world's difficulty: the night gate, the wheat field and
//                                                 the spawn proofing come with monsters
//     build       none · a large BUILDS entry     a large build apart from the base, raised last
//
// so the default reads as a local world, a rollback start, 15 minutes, normal, no large build. Every crew
// raises the headframe first as its bootstrap, then the base round it, the bot hive among it, then a large
// build when one is named. The foreman reads all
// of it once at start and carries it out with nobody at the keyboard (foreman/foreman_plan.js checks it
// and says the sentence back). Everything after the sentence is the world's address, which most people
// never touch.
//
// After the sentence come the things the foreman adds around the run — the clock, the cameras, and the
// watch that ends the run on an error — and none of them change what the crew does.
//
// ── THE FOREMAN OWNS THE PROCESS ─────────────────────────────────────────────
// `where` decides one thing, and the foreman does the rest:
//   'local'   the foreman starts the Minecraft server in `serverFolder`, writes the settings the bots need
//             into it (and prints each one and why), watches it run, and stops it when the run ends. If
//             the server fails to start, the foreman reads why and says so in words.
//   'remote'  somebody else runs the world. The foreman connects to `host`/`port`, says plainly why it
//             could not if it cannot, and never starts or stops that world.
//
// The foreman stops only a server it started itself, and refuses to start one where a server is already
// answering, because that one belongs to somebody else.
//
// ── ASSUMED PRESENT, A LOUD FAILURE IF IT IS NOT (Law 13) ───────────────────────────────────────────
// Nothing here is guessed. If the world cannot be started or reached, the foreman STOPS and names this
// file and the field to change; it never falls back to another port or address.
//
// ── WHY THESE ARE THE NUMBERS ───────────────────────────────────────────────────────────────────────
// 25565 is Minecraft's own default port and 25575 is the default for RCON, the server's remote console.
// In 'local' mode the foreman reads both off the server's own server.properties instead.
//
// ── PER-COMPUTER ANSWERS GO IN THE ENVIRONMENT ──────────────────────────────────────────────────────
// Each value has an environment variable named beside it, and the environment wins over this file — use
// it when the answer differs per computer, since an edit here travels through git to every machine.

'use strict';

// Validates a port taken from the environment: a bad value falls back to the default below, so the
// foreman's reachability check names where to look (Law 13).
function port(envName, fallback) {
  const raw = parseInt(process.env[envName], 10);
  return (Number.isFinite(raw) && raw > 0 && raw < 65536) ? raw : fallback;
}

// How the run ends — the clock, the goal and the stops — is its own page.
const RUN_END = require('./run_end_config');

module.exports = {

  // ══ THE SENTENCE ═══════════════════════════════════════════════════════════════════════════════════

  // 1. WHERE — 'local': the foreman starts the server in `serverFolder` and stops it at the end.
  //            'remote': somebody else runs the world at `host`/`port`; the foreman only joins it.
  //                                                   environment override: AUREN_SERVER_WHERE
  where: process.env.AUREN_SERVER_WHERE || 'local',

  // 2. START — 'rollback': the bots start knowing nothing (the fleet's memory is emptied), and on a local
  //            world with a clean copy saved as world_snapshots/<world>/<world>_fresh_start inside the
  //            server folder, the world is put back to that copy first. Without one, the world is used as
  //            it is and the foreman says so.
  //            'continue': nothing is emptied or put back — the bots carry on from the last run.
  //                                                   environment override: AUREN_START
  start: process.env.AUREN_START || 'rollback',

  // 3. SOAK — minutes the run lasts, counted from the moment the crew is working; always above zero.
  //    ENDS — the goal that ends it sooner: 'soak' (none), 'built', 'real'.
  //           Both are set on the run's end page, run_end_config.js, with every other way a run ends.
  soak: RUN_END.minutes,
  ends: RUN_END.goal,

  // 4. DIFFICULTY — 'peaceful': no monster spawns, so the crew works through the night, lights no spawn proofing,
  //                 and grows wheat only where the hive or its pens ask for it.
  //                 'normal' or 'hard': monsters spawn, so darkness closes outdoor work (the night gate), the crew
  //                 grows wheat to eat, and the base's ground is lit against spawns. The foreman writes it into the
  //                 server's server.properties.
  //                                                   environment override: AUREN_DIFFICULTY
  difficulty: process.env.AUREN_DIFFICULTY || 'normal',

  //    COUNT — how many bodies the crew the foreman raises is: 2 through the available roster.
  //                                                   environment override: AUREN_CREW_COUNT
  count: process.env.AUREN_CREW_ONLY ? process.env.AUREN_CREW_ONLY.split(',').filter(Boolean).length
    : process.env.AUREN_CREW_COUNT === undefined ? 15 : Number(process.env.AUREN_CREW_COUNT),
  //    CREW SIZE — the crew the base is built for, the bot hive's beds among it: COUNT, unmoved by ONLY isolating a few bodies.
  crewSize: process.env.AUREN_CREW_COUNT === undefined ? 15 : Number(process.env.AUREN_CREW_COUNT),

  //    ONLY — the roster names raised, and no others, in place of the first COUNT by seniority: one body or a few
  //           isolated in a world the crew built. COUNT is their number. null raises by COUNT.
  //                                                   environment override: AUREN_CREW_ONLY (comma-separated)
  only: process.env.AUREN_CREW_ONLY ? process.env.AUREN_CREW_ONLY.split(',').filter(Boolean) : null,

  // 5. BUILD — a large build, sited apart from the base and raised last: one of architect_config.BUILDS other than
  //            the bot hive, which every base raises as a support. Empty (the default) raises none, and `ends built`
  //            then waits for the hive. A named build is sited outside the whole base and raised once the hive stands:
  //            the hive and the large build each hold their own plan (downloaded_plan_registry.of).
  //                                                   environment override: AUREN_BUILD
  build: process.env.AUREN_BUILD || '',

  //    PLAN — where the large build's BUILD PLAN is. A downloaded building is built from a plan made out of it
  //           once, deciding what it may be made of, how the ground under it is scraped, and how it is split
  //           into the cubes a bot can reach from one stand. Leave blank and the crew looks where the workshop
  //           writes plans; fill in if the plan lives elsewhere. The command that makes one:
  //             node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<build>
  //                                                   environment override: AUREN_BUILD_PLAN
  plan: process.env.AUREN_BUILD_PLAN || '',

  //    LANDING — where a crew the foreman raises itself is put down, on a rollback start.
  //           'usual':  the nearest good ground to world spawn — the same spot every clean start of a world.
  //           'random': a spot rolled new each run, 2 to 4 loaded areas from the usual one (a loaded area
  //                     is what one bot has loaded round itself: 320 blocks across on an ordinary server,
  //                     so 640 to 1,280 blocks away). Ground that will not hold the base is rolled again,
  //                     up to 8 times, and the foreman says what was wrong with each.
  //                                                   environment override: AUREN_LANDING
  landing: process.env.AUREN_LANDING || 'usual',

  //    BUILT CUT STOPS — TEMPORARY. 'on': a route that digs through a building that has stood whole is a coding violation
  //           (Law 13) and stops the run for inspection: with no person in the world to break the base, nothing should
  //           ever leave a body walled in by its own finished building. 'off': the cut is warned and walked (CUTTING THE
  //           BUILD), for the day people share the world and a griefed base may need digging through.
  //                                                   environment override: AUREN_BUILT_CUT_STOPS
  builtCutStops: process.env.AUREN_BUILT_CUT_STOPS || 'on',

  // 6. TEST — 'off': an ordinary run, the crew is raised and the soak runs.
  //           a test name: the foreman does everything up to that test's last step, shuts down without
  //           raising a single bot, and says what the test found — the ordinary startup with its tail left
  //           off, not a second way of starting (Law 16).
  //           'scan': the world comes up, the body finds a standing spot, and the base is sited — the
  //                   headframe, the build and every structure round them. Answers "does siting still
  //                   work" in the time a world takes to come up.
  //           'inspect': for looking over what the last run built. Needs start 'continue'. The world comes
  //                   up as it was left, the one camera window a person flies is opened and put at the
  //                   base (the headframe), and it stays up with no
  //                   bot raised until stopped. The short way: node start_auren.js inspect
  //                                                   environment override: AUREN_TEST
  test: process.env.AUREN_TEST || 'off',

  //    MODULE — 'off': the crew plans its own work. A module name: the crew is raised as usual, but every time a
  //           body would plan (recursive_judge's way to job_board) the judge hands it to the test module
  //           (action_fragments.js/test_module) instead. The module runs its one test under every rule and reports
  //           back to the judge, so one behaviour is watched on its own without waiting for a run to reach it.
  //           'walk': the body walks to the nearest `module_biome`, which the foreman asks the server for, and the
  //                   walk is timed (--finder lens). Raise one body for it: --only <name>.
  //                                                   environment override: AUREN_MODULE, AUREN_MODULE_BIOME
  module: process.env.AUREN_MODULE || 'off',
  module_biome: process.env.AUREN_MODULE_BIOME || 'jungle',
  //           'T-1,T-1A' with --module t1: the terminator kits dealt round the crew in roster order, so the T-1 (the
  //           original fighting) and the T-1A (the prediction engine) march the same night. environment override: AUREN_MODULE_KITS
  module_kits: process.env.AUREN_MODULE_KITS || 'T-1',

  // ══ WHAT THE FOREMAN ADDS AROUND THE RUN ═══════════════════════════════════════════════════════════
  // None of these change what the crew does; they change what the world looks like and who is watching.

  // OBSERVER — a PERSON watching, by the name they log in under. Empty means nobody, the default. Named,
  //            the foreman puts that player in SPECTATOR and teleports them to the same spot as the crew.
  //            It does nothing else to them: they fly, cannot be hit, and cannot place a block, so
  //            watching a run never changes one. Joining late still moves them the moment they arrive; not
  //            logged in is not an error. The world must be in offline mode (the foreman sets that) for a
  //            chosen name to connect.
  //                                                   environment override: AUREN_OBSERVER
  observer: process.env.AUREN_OBSERVER || '',

  // CLOCK — 'dawn': sunrise, and the day runs on.  'day': pinned at midday for the whole run.
  //         'held': the world keeps whatever time it has (a deliberate night run).
  //                                                   environment override: AUREN_CLOCK
  clock: process.env.AUREN_CLOCK || 'dawn',

  // Windows gives fleet computation preference over ordinary desktop work; normal restores ordinary scheduling.
  windowsPriority: process.env.AUREN_WINDOWS_PRIORITY || 'high',
  // One gate owns planning and expensive route workspace; headroom determines the temporary allowance.
  memoryWorkspace: process.env.AUREN_MEMORY_WORKSPACE || 'adaptive',

  // RECORD — 'off': no cameras.  'cameras': a camera window on each bot, nothing written (any screen
  //          recorder can capture a window; each is titled Cam_<Bot>).  'film': cameras plus a recorder
  //          writing files, only on a machine that has one set up.
  //                                                   environment override: AUREN_RECORD
  record: process.env.AUREN_RECORD || 'off',

  // GO — 'now': each body starts work the moment it stands at the build.  'held': every body is raised
  //      and placed at the build first, doing nothing, so the cameras are set up while the crew arrives;
  //      once every body stands, the clock is set back to the run's start and the foreman releases them
  //      one at a time, spaced so the server is never asked to plan for the whole crew at once. The soak
  //      counts from that release. 'held' is the default.
  //                                                   environment override: AUREN_GO
  go: process.env.AUREN_GO || 'held',

  // CAMERAS — how many DIRECTED camera windows `record` raises, the ones the rig frames and cuts between.
  //           'crew': one per body, so every bot is on film.
  //           'none': not one, so the only windows are the seats a person flies (camera_configure's
  //                   `architect`) — watching a run rather than filming it.
  //           'pair':  not one, and no seat to fly: the only windows are the watch pair, the site cam and the
  //                    rider cam (camera_configure siteSeat, riderSeat), which follow the activity ranked highest
  //                    on the scout focus and start on the senior body this run raises.
  //           'rider': the rider cam alone (camera_configure riderSeat), no site cam and no seat to fly. Watched or
  //                    filmed: one window, one file (a one-bot run such as the T-1 night).
  //           a number: that many, framed on the first bots in seniority order.
  //           Read only when `record` is not 'off'. Whichever it is, every window is up and PROVED
  //           before a single bot is raised, so a person is already watching when the crew arrives.
  //                                                   environment override: AUREN_CAMERAS
  cameras: process.env.AUREN_CAMERAS
    ? (['crew', 'none', 'pair', 'rider'].includes(process.env.AUREN_CAMERAS) ? process.env.AUREN_CAMERAS : Number(process.env.AUREN_CAMERAS))
    : 'none',

  // WATCH and WAKE — the stops that end a run early, set on the run's end page (run_end_config.js): `wake` lists
  //        the stops that are on, and `watch` is whether any is.
  watch: Object.values(RUN_END.stops).some(Boolean),
  wake: Object.keys(RUN_END.stops).filter(k => RUN_END.stops[k]),

  // ══ WHERE THE WORLD IS ═════════════════════════════════════════════════════════════════════════════

  // WHERE THE WORLD IS, for 'remote'. A hostname or an IP address. In 'local' mode it is this computer.
  //                                                   environment override: AUREN_SERVER_HOST
  host: process.env.AUREN_SERVER_HOST || 'localhost',

  // The port players connect on — `server-port` in that server's server.properties. In 'local' mode the
  // foreman reads it off the file instead.
  //                                                   environment override: AUREN_SERVER_PORT
  port: port('AUREN_SERVER_PORT', 25565),

  // THE SERVER'S FOLDER, for 'local' — the folder holding server.jar and server.properties, on this computer.
  // This is the one value with no usual answer, so it is the one you fill in.
  //   example (Windows):  serverFolder: 'C:\\Users\\you\\Minecraft\\server',
  //                                                   environment override: AUREN_SERVER_DIR
  serverFolder: process.env.AUREN_SERVER_DIR || '',

  // ── THE SERVER CONSOLE (RCON) ─────────────────────────────────────────────────────────────────────
  // A crew is brought to where you stand through the console, so the bots do not start without it.
  // 'local': leave these alone. The foreman writes a new random password into server.properties each time it
  //          starts the server, and hands it to the bots itself.
  // 'remote': the owner of that world gives you its console port and password, and they go here.
  //                                                   environment override: AUREN_RCON_PORT
  rconPort: port('AUREN_RCON_PORT', 25575),

  //                                                   environment override: AUREN_RCON_PASSWORD
  rconPassword: process.env.AUREN_RCON_PASSWORD || '',
};
