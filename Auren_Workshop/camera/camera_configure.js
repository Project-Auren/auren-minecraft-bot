// camera_configure — every knob the operator controls on the film director, in one place.
// Pure data, no logic (same contract as Thinking_fragments/architect_config.js); camera_rig.js imports
// this and hardcodes no framing number. Distances are world-axis blocks, angles are degrees.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE MODEL IN ONE PARAGRAPH
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The bots are the subject; scenery is a separate deferred camera. One solver (`solveView`) places every
// shot: fires rays outward from the bot to find open sightlines, scores candidates, screens by an air
// box, confirms the best with a 117-ray cone. Position locks at the cut; aim belongs to the gimbal, a
// headless client the camera /spectate's, which holds still until the bot nears the frame edge.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEEKER — how one open direction beats another
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// field.* is the sense step: azSteps azimuths × elevs elevations fired outward from the bot's lens
// plane, each reporting clear distance. Candidates sit along those openings. Rank cast rays by reach
// (furthest first), break ties by rung (lowest first), require a 30° bearing change against the last
// shot, then take the first direction whose lens cell passes the air box and the lens box; if none
// does, take the furthest-reaching one — this rig always returns a shot. A single ray at siting time
// records whether the chosen camera can see the bot (Law 25).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  OCCLUSION — the anti-canopy machinery, in four independent layers
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Canopy is the dominant framing problem; four tests cover it, all measured from the LENS, not the feet
// plane the bot's coordinates sit on: the cone (frustum, lens to subject), the air box (ball on the
// lens), the lens box (tube straight ahead), and the mid-hold re-check. Facts and units for each sit
// beside its own key below.
//
// `visualBlockers`: non-solid blocks (`boundingBox: empty` — sugar cane, tall grass, ferns, vines) that a
// raycast passes through but are opaque on screen, checked by name instead, along the centre line and
// inside the air box. Leaves are `boundingBox: block`, so a raycast already stops on them.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE OPERATOR'S EYE, THE HOST SEAT, and THE TWO MODES
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `architect.*` — spectator cameras a human flies; the rig arms each (spectator, night vision) but never
// commands it, so it never enters the shot list (Law 16, Law 19). Off by default (Law 13); armed only at
// launch (`-Architect` / `--architect`), never by a config edit (Law 26).
// `host.*` — the client a human PLAYS from. Unlike the eye it is a real player, never armed and passed to
// the rig on no list (Law 27), so it can mine, build, die and hire a crew like any other player. Off by
// default, same as the eye.
// `mode.*` — framing (place and cut cameras) and witness (`camera/combat_witness.js`, the server's own
// account of a fight) are independent switches sharing one scout client and one RCON link; either alone,
// both, or neither. Both default off (Law 13); with both off the rig announces which keys to flip and
// exits (Law 8).

'use strict';

const cameraSpots = require('../../js_kernel/utils/camera_spots');

// ── THE LENS ITSELF, NAMED ONCE (Law 16)────────────────────────────────────────────────────────────
// The cone and the site solver both reason in the client's own frustum, so its optics are one pair of
// constants referenced from both. `LENS_FOV_DEG` is VERTICAL field of view (horizontal, ~102° on 16:9,
// is derived).
const LENS_FOV_DEG = 70;
const LENS_ASPECT = 16 / 9;

module.exports = {

  architect: {
    // One window per saved angle, `Cam_<number>`, each its own spectator. The name is the window title, the
    // player name and the recorded file's prefix. AUREN_SEATS (comma list) replaces the list for one run,
    // e.g. `Cam_1,Cam_4`, or one seat flown for a tour.
    camNames: process.env.AUREN_SEATS
      ? process.env.AUREN_SEATS.split(',').map(s => s.trim()).filter(Boolean)
      : cameraSpots.seatNames(),
    // Each saved seat is put at its spot (feet position, then yaw and pitch) once when it joins, on a rollback
    // or a continue alike, and is never moved to the base. The spots are read off the server while a seat held
    // them, and saved through the foreman (js_kernel/utils/camera_spots.js).
    fixed: cameraSpots.bySeat(),
    enable:   false,
  },

  host: {
    // Window/instance name (Windows, the titler, a recorder) — not what the server knows this seat as.
    camName:    'Cam_Architect_Control',
    // The name the seat joins under; must be opped (MinecraftServer/ops.json) so the presenter can run a
    // command from inside his own window.
    playerName: 'KaptainKrispyjr',
    enable:     false,
  },

  // THE WATCH PAIR — two cameras for the whole crew that move together onto the activity ranked highest on the
  // operator's focus (camera/scout_focus.js, set on the Cutting Room's scout page), read from the bots' ACTIVITY
  // lines (custom_api/activity_log.js) as they are written. A recording is typically three cameras: a static
  // camera (the eye or a saved angle) that never moves, and these two. Not `scout.*` below, which is the headless
  // client that reads the world for every camera and films nothing.
  //
  // `siteSeat.*` — the SITE CAM. It watches the PLACE, never the bot: on each pick it stands at a framed, tilted
  // overhead view of the activity's box (camera/site_framing.js, clear of the canopy by `sites.canopyPad`) and holds
  // it until the next pick. An activity with no box is framed as a `defaultBox`-wide patch around its spot.
  siteSeat: {
    camName:      'Cam_Site',
    minDwellMs:   8000,      // filmed this long before a higher-ranked activity takes the pair; an ended one frees it at once
    elevationDeg: 50,        // how far it looks down at the site: overhead with depth, not a plan view
    bearingDeg:   315,       // compass bearing of the camera from the site (a corner shows three faces)
    fill:         0.55,      // the box fills at most this much of the frame, so the ground round it reads too
    padBlocks:    3,         // added round the box on every side before framing
    defaultBox:   9,         // width of the patch framed round an activity that names no box
    kinds:        ['building'],   // the only activities the site cam frames (a build's blueprint box); the rider
                                  // follows the pair's focus, the site cam picks among these alone
  },
  // `riderSeat.*` — the RIDER CAM. It rides behind whichever bot the pair is on (camera_rider.js, one rider client
  // that changes target), for the length of the activity and after it until the next pick.
  riderSeat: {
    camName:   'Cam_Rider',
    riderKey:  'Seat',       // its rider joins as rider.prefix + this: Rd_Seat
  },

  mode: {
    framing: false,
    witness: false,
  },

  witness: {
    sampleMs:   100,   // sample rate while a fight is open; an idle fleet writes zero lines regardless
    radius:     24,    // how far around an engaged bot the sample looks, wider than aggro range
    noseRadius: 16,    // RCON wide-area check radius, fires only at a bot the scout cannot see
    nosePollMs: 2000,
    maxRecords: 120000, // runaway guard; hitting it is written into the record
  },

  timing: {
    minHoldMs:   5000,    // hard floor between cuts; a heartbeat re-sending identical coords is not a cut
    maxHoldMs:   15000,   // mandatory reposition even on a well-framed shot; paced with the 30° bearing gate
    snapshotMs:  45000,   // silence this long AND subject out of frame → one static reframe
    droughtMs:   180000,  // silence this long → warn the log parser may have drifted
    logPollMs:   500,     // story drain
    posPollMs:   1000,    // RCON position poll (timing and scout anchoring only, never placement)
  },

  frame: {
    undergroundY: 55,
    absorbRadius: 12,    // a new objective this close to what is already on screen does not cut
    maxShotDist:  7,       // hard ceiling on camera→subject distance, every mode
    camHeight:    1.5,     // THE LENS height above the bot's FEET — exact, not a floor. No elevation.
    // Eye height of the entity the picture renders FROM: the camera client /spectate's the gimbal, so
    // it renders from the gimbal's eye. solveView reasons in LENS coordinates end to end; sendCam
    // subtracts this at the teleport, the only place feet are wanted.
    eyeHeight:    1.62,

    // Non-solid blocks that a raycast passes through but a viewer cannot see past.
    visualBlockers: [
      'sugar_cane', 'tall_grass', 'short_grass', 'fern', 'large_fern', 'vine', 'glow_lichen',
      'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant',
      'twisting_vines', 'twisting_vines_plant', 'big_dripleaf', 'small_dripleaf',
      'bamboo', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant',
    ],

    cone: {
      gridH:         13,     // samples ACROSS — more than gridV because the frame is wider than it is tall
      gridV:         9,      // samples DOWN. 13×9 = 117 rays, ~equal world-space spacing on both axes
      fovDeg:        LENS_FOV_DEG,  // must match the client's real vertical FOV
      aspect:        LENS_ASPECT,   // frame width / height — makes the tested region frame-shaped
      frameFraction: 0.7,    // fraction of frame EXTENT that must be canopy-free
      minHalfExtent: 0.9,
      maxHalfExtent: 10,
      // The gate is binary — every ray clear, or rejected. The fraction still returned ranks rejects for
      // the always-return-a-shot fallback and decides nothing else.
    },

    field: {
      azSteps:   32,           // azimuths cast outward per siting
      elevs:     [0, 15, 30],  // rungs above camHeight, ASCENDING (solver ranks by index; rung 0 lowest)
      margin:    2.0,        // stand this far short of what stopped the ray; must exceed `airBox`
      minUsable: 1,          // practical minimum shot distance; a direction offering less is skipped
      airBox:    1,          // radius of the clear ball the lens must centre in: 1 → ~19 cells, 2 → ~81
    },

    // A clear rectangular tube straight out of the lens, `half` blocks to each side, over depths
    // `from`..`to` (clamped short of the subject: backdrop foliage is allowed). Bridges the air box
    // (small, on the camera) and the cone (anchored on the subject). Block lookups only — no rays.
    lensBox: { half: 1, from: 2, to: 5 },

    seek: {
      improve:     0.12,    // beat the current cone score by this to cut mid-hold to a better vantage
      minRoomGain: 4,       // or offer this many more blocks of open room; suppressed during travel shots
    },

    weights: {
      preferredDist:       7,    // target distance the scorer aims for as a bell (too close penalised too)
      minBearingChangeDeg: 30,   // consecutive shots of one subject must differ by at least this in bearing
    },

    objective: {
      idleDroughtMs:      8000,   // silence this long means the bot is idle → the `wide` shot instead
      arrivalRadius:      5,      // travel shot ends once the bot is this close to the destination
      travelDistance:     8,      // clamped to maxShotDist; see wide.distance
      travelCutMinDist:   5,      // leg longer than this frames the destination instead of the walking bot
      travelStageMaxDist: 40,     // beyond this the camera films and follows the bot instead of waiting
      travelMaxHoldMs:    90000,  // stuck-bot safety valve, not a rhythm
    },

    // The see-through (underground) shot: a frozen tripod, no cone, no gimbal — nothing occludes
    // underground and the bot moves slowly enough that swapping cameras on frame-exit is sufficient.
    enclosed: {
      jobPrefixes: ['mine/'],   // job names whose starved above-ground search means ROCK, not thicket
      distance:    7,           // camera→bot
      rise:        3.72,        // LENS height above the bot's FEET — the down-look, not the camera plane
    },

    wide: { distance: 9 },   // idle shot; clamped to maxShotDist like every other mode
    bot:  { aimRise: 0.6, minFramedDist: 2 },   // guaranteed fallback when no candidate can see the subject
  },

  // A camera on a STRUCTURE, not a bot — the swarm is the subject at scale here. Not yet wired into the
  // rig's shot list; `site_framing` reports a shortfall against these criteria (Law 25).
  sites: {
    bearingDeg: 315,   // compass bearing of the camera from the structure; a 45° corner shows three faces
                       //   and reads the same regardless of which way the structure's footprint landed
    fill: 0.80,        // ceiling on how much of the frame the structure's larger apparent axis fills
    elevationDeg: 25,  // how far the lens looks down at the structure's middle
    canopyPad: 3,      // daylight required between the sightline and the highest leaf in the way
    corridorHalfWidth: 8,  // half-width of the swath of columns tested for trees either side of the sightline
    scanTop: 319,      // where the canopy scan starts looking down from (world build ceiling)
  },

  hold: {
    checkHz:           4,
    frameExitDeg:      30,      // frozen-aim fallback only; skipped whenever a gimbal is live
    maxSubjectDist:    40,      // ends a shot when the bot walks off to a speck
    exitGraceMs:       1500,    // frozen-aim fallback only
    heartbeatMs:       1000,    // re-asserts position so a nudge, client drift or respawn snaps back
    occlusionCheckMs:  5000,    // re-test the frame (the 117-ray cone) this often during a hold
    reoccludeScore:    0.35,    // below this (or centre ray blocked) the shot is spoiled → cut
    blockedMinHoldMs:  1200,    // rate limit on the subject-lost cut, so a blocked re-cut cannot machine-gun
    sameShotDist:      1.0,     // a cut landing within this of where the lens already stands is not a cut
    // A sightline blocked within `thrashWindowMs` of the block starting answers first person for
    // `thrashFirstPersonMs` — first person cannot be occluded from its own subject.
    thrashWindowMs:      2000,
    thrashFirstPersonMs: 5000,
  },

  gimbal: {
    enable:            true,
    prefix:            'Gim_',
    deadzoneYawDeg:    22,    // separate from pitch because the frame is far wider than it is tall
    deadzonePitchDeg:  12,
    recenterFrac:      0.35,  // a correction runs until the error is back inside deadzone×this, not
                              //   merely inside the dead zone, so the subject can't sit on the trigger
    easePerTick:       0.12,  // softness of that correction; 1.0 with zero dead zones is a debug setting
    maxRateDegPerTick: 6,     // stops a teleporting bot whipping the camera
    aimRise:           1.2,   // aims at head/upper body
    occlusionMs:       500,   // sightline sample period (camera_gimbal); already the debounce at this rate
    graceChecks:       1,     // consecutive blocked samples before the rig is told
  },

  // THE RIDER (camera_rider.js) — a bot camera that travels WITH its bot instead of cutting between tripods.
  // A headless spectator client travels along the bot's own track, `followBlocks` behind it, at a speed of
  // its own that changes only gradually; it rides as high above the track as the sightline to the bot
  // allows, and looks along the route the bot posts (`[ROUTE] ahead cells=…`), `lookAheadBlocks` ahead of
  // the bot. The camera window /spectate's it and the client in-betweens every move, so the picture is as
  // smooth as the rider's path. `enable: true` puts every bot camera on a rider; the scout seat keeps its
  // tripods.
  rider: {
    enable:          process.env.AUREN_RIDER === 'on',   // off unless the run says AUREN_RIDER=on

    prefix:          'Rd_',
    // SPACING AND SPEED — the rider never copies the bot's moment-to-moment speed.
    followBlocks:    4,      // how far behind the bot, measured along its track
    catchUpSec:      1.2,    // a gap error of N blocks asks for N/catchUpSec blocks per second extra speed
    speedWindowSec:  1.5,    // the bot's speed is its average over this long
    speedEaseSec:    0.6,    // time constant the rider's speed follows the speed it wants with
    maxAccel:        2.5,    // blocks per second², either way: a speed change is never a lurch
    minGapBlocks:    1.5,    // the rider never closes nearer the bot than this along the track
    cornerBlocks:    1.2,    // the track is averaged over ± this many blocks, so corners are arcs
    // HOW NEAR — a distance from the bot itself, across the ground (the gap above is along the track only).
    standoffBlocks:  3.5,    // the lens never stands nearer the bot than this; a lunge moves it back at once
    crowdBlocks:     3.5,    // the track spot this near the bot (it turned back, or stands shuffling) starts a hold-off
                             // (at standoffBlocks, a fight-heavy march holds off nearly always)
    leashMaxBlocks:  6,      // holding off, the lens stays where it is between standoffBlocks and this from the bot
    leashHoldSec:    4,      // holding off lasts this long after the bot last crowded the track spot (a fight: all of it)
    leashBlendSec:   0.8,    // time constant of the hand-over between following the track and holding off
    leashOrbitDegPerSec: 60, // holding off with no clear view, the lens swings round the bot to one at this rate
    leashLookEaseSec: 0.25,  // holding off, the lens looks at the bot and keeps up with it this quickly
    leashTurnDegPerSec: 140, // …and turns this fast at most
    // LOST SIGHT — a bot standing (or fighting) in place behind leaves is not refound by its own motion, so the lens looks for it.
    seekStillBlocks: 1.5,    // the bot moved less than this over the last second: it is standing or fighting in place
    seekAfterMs:     1500,   // the lens has not seen the bot's chest for this long: it starts looking
    seekSearchMs:    1000,   // how often the wider search (every bearing, three distances, every seek height) is run
    seekBearingStepDeg: 20,  // bearings tried outward from the lens's own, both ways, to the far side
    seekHighRise:    4.4,    // heights the search and the sweep reach, above the bot's eye level…
    seekLowRise:     -0.8,   // …and below it (under a canopy the clear view is often low)
    seekDegPerSec:   25,     // the slow turn round the bot, to the view found or in the sweep
    seekSweepDeg:    90,     // with nothing found, the sweep reaches this far to each side of where it began
    seekBobSec:      6,      // …and rises and falls between the seek heights once in this long
    seekRadiusSec:   1.0,    // time constant the distance eases to the found view's with
    botEaseSec:      0.1,    // the bot's position the hold-off measures from, eased so one server tick is no jolt
                             // (the standoffBlocks floor measures from the bot as last heard, so it is exact)
    // HEIGHT — the boom: as high as the sightline allows, lower when something is in the way.
    highRise:        2.6,    // preferred height of the lens above the bot's eye level
    lowRise:         0.4,    // the floor: just above the bot's eye, on ground the bot has just walked
    riseStep:        0.4,    // heights tried between, top down
    // UNDER THE CANOPY: with leaves over the lens or the bot, the lens stays canopyMargin under the lowest leaf and may
    // drop to canopyLowRise (above the bot's eye level, so a found rise stays positive).
    canopyLookAbove: 3,      // blocks above the highest try that a leaf counts as canopy
    canopyMargin:    1.0,    // blocks kept between the lens and the lowest leaf over it
    canopyLowRise:   0.1,    // the lowest the lens goes under a canopy
    boomCheckMs:     250,    // how often the heights are tried
    boomDownSec:     0.3,    // time constant for lowering (an obstruction is coming: be quick)
    boomUpSec:       1.8,    // time constant for rising again (open sky: be slow)
    groundEaseSec:   0.6,    // time constant the lens follows the ground's height with; jumps are ignored
    // AIM
    lookAheadBlocks: 9,      // where the lens points: this far along the posted route ahead of the bot
    aimRise:         1.0,    // that point's height above the route's feet cells
    lookEaseSec:     0.6,    // time constant the look point drifts toward its target with
    maxTurnDegPerSec: 75,    // ceiling on the lens's own turn rate
    pitchMaxDeg:     40,     // the lens never tilts further up or down than this
    offRouteBlocks:  3,      // a bot further than this from its posted route is steered by its motion instead
    regrabBlocks:    8,      // a rider further than this from its spot is put back by the console, not flown
    distanceReportMs: 30000, // how often the rig records how near each rider's lens stood to its bot
    rebindMs:        15000,  // how often the camera is released, carried to its rider and bound again (a client that
                             // dropped its view is reattached only so; a plain re-spectate is a no-op on the server)
  },

  scout: {
    enable:       true,
    username:     'Scout_Cam',

    // Parks directly above the subject's own column: a loaded chunk is a full vertical column, so only
    // the horizontal coordinate decides chunk loading and entity tracking.
    parkRise:     20,     // blocks above the subject; clears a 70° lens from any shot distance in use
    parkRadius:   48,     // re-park once the subject is this far off the current column
    height:       120,    // fallback altitude for the witness-only centroid park (no framing subject)
    reanchorDist: 32,
    settleMs:     2500,   // upper bound on the wait after a re-park; the rig proceeds once chunks read,
                          //   degrading to a blind shot on timeout, never hanging
    // How long a ray loop may run before ceding a macrotask (execution_yield) — under the 50ms
    // one-tick default so this client's packet handlers keep getting heard during a solve.
    scanSliceMs:  8,
  },
};
