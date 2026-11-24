// module: survival_instincts
// purpose: Tick-level autonomous reflexes that keep the bot alive regardless of what task
//          is running. These operate below the signal bus — no payloads, no fragments, no
//          routing. Raw physicsTick handlers that act directly on control state.
//
//          Lives in custom_api/locomotion because survival reflexes produce movement (swimming
//          upward, etc.) and the folder is designed to be self-contained and exportable.
//
// contract:
//  - start(bot) attaches all survival reflexes to the bot's physicsTick event.
//  - stop() detaches them. Logs a Law 17 warning — the caller is accepting drowning risk.
//  - Each reflex is independently toggleable via enable/disable functions.
//  - No signal_bus, no file I/O — pure tick-level reactions. The watcher is its one output: the fall
//    and water survival diagnostics.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { guardExternalSync } = require('@utils/external_library_guard');
const swimming = require('./underwater_swimming');

// ---------------------------------------------------------------------------
// SECTION 1: State
// ---------------------------------------------------------------------------
let attached = false;
let tickHandler = null;
let attachedBot = null;
let lifecycleHandler = null;

// Per-reflex enable flags. All default to ON — survival is opt-out, not opt-in.
const reflexes = {
  antiDrown: true,
  doorHandler: true,
  keepAfloat: true,
  // Door facing is momentary; water survival suppresses it while the body returns to air.
};

// ---------------------------------------------------------------------------
// SECTION 2: Reflex implementations
// ---------------------------------------------------------------------------

// The breath override (underwater_swimming): borrowed dives, and the body taken to air only when its air runs low,
// held there until the breath is full and released. Floating and swimming are the navigator's; nothing is pressed here
// for a body that is breathing.
function antiDrownTick(bot) {
  if (!reflexes.antiDrown) return;
  swimming.tick(bot);
}

// doorHandler: open closed wooden doors when the bot is within reach, close them after
// passing through. Same philosophy as antiDrown — dumb tick-level reflex that makes doors
// transparent to whatever movement system is running. Handles village doors, player-placed
// doors, any wooden door. Iron doors excluded (require redstone, can't open by hand).
//
// Open phase: cardinal neighbor scan. Closed door within 1.5 blocks → activate to open,
//   start tracking its position.
// Close phase: tracked door + bot >2 blocks away → activate to close, clear tracking.
// Already-open doors: tracked for close-behind but never toggled on approach (prevents
//   accidentally closing a door in front of the bot).
const DOOR_BLOCKS = new Set([
  'oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door',
]);

let doorCooldown = false;
let trackedDoor = null;

// False on refusal means "treat it as shut", the safe direction (Law 17 — no predictable
// self-obstruction): the handler may open a door it did not need to, but never records the
// refusal as a measured door state.
function isDoorOpen(block) {
  const props = guardExternalSync('survival_instincts', 'read door properties', () => block.getProperties?.());
  return props.ok && !!props.value && String(props.value.open) === 'true';
}

function doorHandlerTick(bot) {
  if (!reflexes.doorHandler) return;
  if (doorCooldown) return;
  // IN A FIGHT THE DOOR IS THE GUNNER'S: the reflex's look would take the mob-facing yaw, and its click on a door the
  // gunner has just opened for the driver's door edge would shut it again (driver edgeWant, gunner serveTerrain 'open').
  if (require('@api/driver').state().engaged) return;
  const pos = bot.entity?.position;
  if (!pos) return;
  const feet = pos.floored();

  if (trackedDoor) {
    const d = Math.hypot(pos.x - trackedDoor.x - 0.5, pos.z - trackedDoor.z - 0.5);
    if (d > 2.0) {
      const block = bot.blockAt(trackedDoor);
      if (block && DOOR_BLOCKS.has(block.name) && isDoorOpen(block)) {
        doorCooldown = true;
        const closeTarget = trackedDoor;
        trackedDoor = null;
        bot.lookAt(new Vec3(closeTarget.x + 0.5, closeTarget.y + 0.5, closeTarget.z + 0.5), true)
          .then(() => bot.activateBlock(block))
          .catch(() => {})
          .finally(() => { doorCooldown = false; });
      } else {
        trackedDoor = null;
      }
      return;
    }
  }

  if (!bot.controlState?.forward) return;

  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const doorPos = new Vec3(feet.x + dx, feet.y, feet.z + dz);
    const block = bot.blockAt(doorPos);
    if (!block || !DOOR_BLOCKS.has(block.name)) continue;
    const d = Math.hypot(pos.x - doorPos.x - 0.5, pos.z - doorPos.z - 0.5);

    if (!isDoorOpen(block)) {
      if (d < 1.5) {
        doorCooldown = true;
        trackedDoor = doorPos;
        bot.lookAt(new Vec3(doorPos.x + 0.5, doorPos.y + 0.5, doorPos.z + 0.5), true)
          .then(() => bot.activateBlock(block))
          .catch(() => {})
          .finally(() => { doorCooldown = false; });
        return;
      }
    } else {
      if (d < 1.0 && !trackedDoor) {
        trackedDoor = doorPos;
      }
    }
  }
}


// fallAlert: a body never falls in normal work — navigation plans no drop past one block (dig_down
// is the deepest), so landing 2+ blocks below the take-off point means something threw it (a
// blast, a hit, a floor that was not there). It warns and changes nothing: the work carries on.
// Measured take-off to landing, so a jump's arc is not counted; water and climbing reset it.
// The alert also carries what the body was doing as it left the ground, so the fall can be told
// apart: the floor under a still body removed (no controls, centre was over a block) or a body
// that walked off an edge (forward held, centre already over air on its last standing tick).
const FALL_ALERT_BLOCKS = 1.5;
let takeoff = null;
let lastStand = null;
function heldControls(bot) {
  const held = ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(c => bot.controlState?.[c]);
  return held.length ? held.join('+') : 'none';
}
// The navigator's step in hand as the body left the ground (navigator stamps bot._navStep per step).
function navStepText(bot) {
  const s = bot._navStep;
  if (!s) return 'no navigator step yet';
  const c = (v) => (v ? `${v.x},${v.y},${v.z}` : '?');
  return `navigator ${s.edge}${s.run >= 2 ? ` (run of ${s.run})` : ''} (${c(s.from)})→(${c(s.to)}) toward (${c(s.goal)})${s.exact ? ' exact' : ''}, stamped ${Date.now() - s.at}ms ago`;
}
function fallAlertTick(bot) {
  const e = bot.entity;
  if (!e || !e.position) return;
  if (e.isInWater || e.isInLava || e.isOnLadder) { takeoff = null; return; }
  if (!e.onGround) {
    if (!takeoff) {
      const hs = Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0);
      takeoff = { pos: e.position.clone(), controls: heldControls(bot), hspeed: hs, stand: lastStand, nav: navStepText(bot) };
    }
    return;
  }
  const under = bot.blockAt(e.position.floored().offset(0, -1, 0));
  lastStand = under ? under.name : 'unloaded';
  if (!takeoff) return;
  const drop = takeoff.pos.y - e.position.y;
  if (drop >= FALL_ALERT_BLOCKS) {
    const f = (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
    watcher.warn('survival_instincts', `FALL ALERT: fell ${drop.toFixed(1)} blocks, (${f(takeoff.pos)}) → (${f(e.position)}) `
      + `| controls ${takeoff.controls}, speed ${takeoff.hspeed.toFixed(2)}, under the centre on the last standing tick: ${takeoff.stand ?? 'unknown'} | ${takeoff.nav}.`);
  }
  takeoff = null;
}

// ── THE BODY IS KEPT AFLOAT WHEN NOTHING ELSE MOVES IT ──────────────────────────────────────────────────────────
// In water a body that presses nothing sinks. Two spans leave it pressing nothing:
//   thinking  waiting in line for the planning gate, or inside it planning or searching a route (foreman_link.thinking:
//             every navigator search runs in the gate's workspace phase). NicoBot sank from y 61.4 to 57.3 through a 3 s
//             wait and a 5 s route search, and LOW_AIR came before it moved again.
//   unowned   no movement key held by anyone for UNOWNED_MS: a job working in place, a body between two steps, an idle
//             body. A body dropped in a moat sank 66→63.3 while its job worked, and a walk whose water exit failed sank
//             on every retry, LOW_AIR every ~20 s for four minutes.
// For either span this reflex floats it with the navigator's own treadWater (Law 16): jump held while the eye is under,
// released on every exit. It stands aside for the breath override and a dive (survival's modes other than floating),
// for an open fight (the driver keeps the head up itself), and, when the span is `unowned`, for the first movement key
// anyone else presses: a walker that starts a swim owns the body again.
const TREAD_STRETCH_MS = 60000;   // one treadWater call's ceiling; a body still afloat with no owner is taken up again next tick
const UNOWNED_MS = 250;           // keys released this long is a body nobody drives, not the gap between two presses
const TREAD_SAY_MS = 1000;        // a stretch this long or longer is said; the many short ones between steps are counted
const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'sneak'];
let treading = null;              // { span, since, fromY } while a stretch runs
let unownedSince = null;
let shortStretches = 0;
function fightOpen() { return require('@api/driver').state().engaged; }
function othersMove(bot) { return MOVE_KEYS.some((k) => bot.controlState?.[k]); }
function survivalFloating(bot) { const s = swimming.status(bot); return s.mode === 'floating' && !s.pending; }
function keepAfloatTick(bot) {
  if (!reflexes.keepAfloat || treading) return;
  if (!bot.entity?.isInWater || bot.health <= 0 || !survivalFloating(bot) || fightOpen()) { unownedSince = null; return; }
  const link = require('@kernel/foreman_link');
  const phase = link.thinking();
  const now = Date.now();
  let span = null;
  if (phase) span = phase;
  else if (!othersMove(bot) && !bot.controlState?.jump) {
    if (unownedSince === null) unownedSince = now;
    if (now - unownedSince >= UNOWNED_MS) span = 'unowned';
  } else unownedSince = null;
  if (!span) return;
  const p = bot.entity.position;
  treading = { span, since: now, fromY: p.y };
  const thinkingSpan = span !== 'unowned';
  const done = () => !bot.entity?.isInWater || !survivalFloating(bot) || fightOpen()
    || (thinkingSpan ? !link.thinking() : (othersMove(bot) || !!link.thinking()));
  require('@locomotion/navigator').treadWater(bot, { until: done, ms: TREAD_STRETCH_MS }).then(() => {
    const q = bot.entity?.position;
    const held = Date.now() - treading.since;
    const why = !bot.entity?.isInWater ? 'left_water' : !survivalFloating(bot) ? 'breath_override_or_dive' : fightOpen() ? 'fight_opened'
      : thinkingSpan ? (!link.thinking() ? 'thought_done' : 'stretch_ceiling')
        : link.thinking() ? 'began_thinking' : othersMove(bot) ? 'walker_took_it' : 'stretch_ceiling';
    if (held >= TREAD_SAY_MS) {
      watcher.summary('survival_instincts', `KEEP_AFLOAT span=${treading.span} held=${held}ms why=${why} y ${treading.fromY.toFixed(1)}→${q ? q.y.toFixed(1) : '?'}`
        + (shortStretches ? ` (+${shortStretches} short stretch(es) since the last said)` : ''));
      shortStretches = 0;
    } else shortStretches++;
    treading = null;
    unownedSince = null;
  }, (e) => {
    watcher.warn('survival_instincts', `KEEP_AFLOAT threw: ${e && e.message} — taken up again next tick if still afloat with no owner`);
    treading = null;
    unownedSince = null;
  });
}

// ---------------------------------------------------------------------------
// SECTION 3: Tick dispatcher
// ---------------------------------------------------------------------------

// A survival return owns facing until breathing is restored; door work waits for that boundary.
function onPhysicsTick(bot) {
  antiDrownTick(bot);
  if (swimming.status(bot).mode === 'floating') doorHandlerTick(bot);
  keepAfloatTick(bot);
  fallAlertTick(bot);
}

// ---------------------------------------------------------------------------
// SECTION 4: Public API
// ---------------------------------------------------------------------------

function start(bot) {
  if (attached) return;
  tickHandler = () => onPhysicsTick(bot);
  attachedBot = bot;
  lifecycleHandler = () => swimming.reset(bot);
  bot.on('spawn', lifecycleHandler);
  bot.on('death', lifecycleHandler);
  bot.on('physicsTick', tickHandler);
  attached = true;
  console.log('[survival_instincts] Started — anti-drown, door-handler, keep-afloat, fall-alert active.');
}

function stop() {
  if (!attached || !tickHandler) return;
  console.log('[survival_instincts] WARNING: Stopping survival reflexes. The bot can now drown (Law 17 risk accepted by caller).');
  attachedBot.removeListener('physicsTick', tickHandler);
  attachedBot.removeListener('spawn', lifecycleHandler);
  attachedBot.removeListener('death', lifecycleHandler);
  lifecycleHandler = null;
  swimming.reset(attachedBot);
  attachedBot = null;
  tickHandler = null;
  attached = false;
}

// Silent by design: a toggle fires on every combat engage/disengage, so a log line here floods the
// console with no diagnostic value. The state flip is the whole job; the caller already logs the
// engagement it's suppressing a reflex for. Toggling a name not in `reflexes` is a deliberate
// no-op so old callers don't break.
function disableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = false;
}

function enableReflex(name) {
  if (!(name in reflexes)) return;
  reflexes[name] = true;
}

// isDoorOpen is exported for the combat driver's door edge, which asks the gunner to open a shut door (Law 16).
module.exports = { start, stop, disableReflex, enableReflex, isDoorOpen };
