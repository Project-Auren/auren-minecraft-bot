// lanista — the arena master: places both combatants, arms them, and reports what the server says
// happened (Law 23 — every authored input is read back).
//
// Makes no recording of its own; `monitoring/combat_lens` is the one reader of the combat journal
// (Law 16). Outside the construct (Law 19, Law 26): authors inputs, reads outputs. Proves the
// engagement, not the encounter (Law 25) — `trace_monitor --combat` says why.
//
// ── WHERE THE CODE LIVES ────────────────────────────────────────────────────────────────────────────
//   lanista_shared  NODE_PATH bootstrap, requires, config. Require it first from anywhere.
//   lanista_biome   find ground in a named biome.
//   lanista         (this file) stage one fight and say what the world did.
//   lanista_ladder  the tier × wave table and the run loop.
//
// Usage:
//   node lanista.js --bot=AurenBot                          # one zombie, ~12 blocks out
//   node lanista.js --bot=AurenBot --mob=creeper --rounds=3  # three fights, re-sited each time
//   node lanista.js --bot=AurenBot --mob=skeleton --hand=minecraft:bow --range=15
//   node lanista.js --bot=AurenBot --mob=zombie --count=3    # three at once, spread across bearings
//   node lanista.js --bot=AurenBot --wave=zombie:1,spider:1,skeleton:1@bow    # one MIXED wave
//   node lanista.js --bot=AurenBot --kit=wooden_sword,wooden_axe --at=-8,65,16 # author the body too
//   node lanista.js --bot=AurenBot --mob=skeleton --hand=minecraft:bow --moat=3 --kit=stone_sword,shield,oak_planks*32
//                                                            # an opponent no walk reaches (carveMoat)
//   node lanista.js --bot=AurenBot --moat=3 --flood --kit=stone_sword,oak_planks*32   # a water moat one under the banks
//   node lanista.js --bot=AurenBot --moat=6 --flood=level --kit=stone_sword          # a water moat level with them: swum, no bridge
//   node lanista.js --bot=AurenBot --swim --mob=zombie --after=30 --kit=stone_sword   # the body afloat, the mob on land
//   node lanista.js --bot=AurenBot --pool --mob=drowned --kit=stone_sword             # the body on land, the mob in water
//   node lanista.js --bot=AurenBot --swim --swim-radius=9 --range=6 --mob=drowned --kit=stone_sword   # both in one pool
//   node lanista.js --bot=AurenBot --wave=zombie:1,skeleton:1@bow --opposed   # the two on opposite sides
//   node lanista.js --bot=AurenBot --mob=enderman --provoke  # a neutral mob turned on the body first
//   node lanista.js --bot=AurenBot --buddy=TessaBot --buddy-gap=1 --kit=iron_axe,shield,iron_helmet,iron_chestplate,iron_leggings,iron_boots
//                                                            # two bodies, same kit, side by side (0 stacks them)
//   node lanista.js --bot=Striker --striker --mob=creeper --kit=stone_sword --rounds=5
//                                                            # a body with no mind that never moves: it swings on
//                                                            # cooldown at whatever comes into reach (lanista_striker)
//   node lanista.js --bot=AurenBot --mob=witch --follow=zombie:2,skeleton:1@bow --follow-after=4
//                                                            # a second wave into the same fight, no heal between
//   node lanista.js --bot=AurenBot --wave=skeleton:2@bow --loot   # after each wave: what the body picked up, what it left
//   node lanista.js --bot=VedaBot --arena --time=noon --wave=creeper:1 --rounds=12 --escalate --stage=6 --kit=iron_sword
//                                                            # the filming set (arena_set): the body on the centre stand,
//                                                            # each wave staged behind the four gates, round n is n× the wave,
//                                                            # the run ends the round the body falls
//   node lanista.js --bot=VedaBot --arena --time=noon --show=emperor --emperor --crowd=10 --kit=iron_sword
//                                                            # the filmed show (arena_show): the show's rounds in order,
//                                                            # each staged until the emperor presses release in his box;
//                                                            # ten spectator puppets raise the verdict banners (the operator's npc module, workstation.findNpc)
//   node lanista.js --cleanup                                # kill anything this tool left behind
// Then: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=AurenBot
// Exit codes: 0 every round ran · 2 a round could not be run (terrain, arming, or the bot out of range)
//             1 could not run at all (no scout / no rcon).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/lanista.js');

const {
  ARENA_TAG, SCOUT_NAME, SITING, WORLD, AGGRO_RANGE, AGGRO_VERTICAL_RANGE, engageRangeFor,
  arena, createScout, fmt, log, pathfinding, rconLink, round2, sleep,
} = require('./lanista_shared');
// The bot's combat record has exactly one reader; this is it (Law 16).
const combatLens = require('../../monitoring/combat_lens');
// The filmed show's rounds, the emperor's controls and the TNT (the colosseum, arena_set).
const crowdShow = require('./arena_show');
// The show's people (crowd, guards, ruler) are not the bot's and do not ship: the module the workstation file names, or null.
const npcModule = () => { const file = require('@utils/workstation').findNpc(); return file ? require(file) : null; };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // `ceilingSeconds`: the point past which an unfinished fight stops counting as a fight (Law 7).
  // `lift: 2`: default mob elevation above the bot, in blocks — forces a sprint jump.
  const a = { bot: process.env.BOT_ID || 'AurenBot', mob: 'zombie', count: 1, range: 12, ceilingSeconds: 60, lift: 2, rounds: 1, cleanup: false };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'cleanup': a.cleanup = true; break;
      case 'bot': a.bot = v; break;
      case 'mob': a.mob = v; break;
      case 'hand': a.hand = v; break;          // what the mob carries in its main hand
      case 'count': a.count = parseInt(v, 10); break;
      case 'range': a.range = parseFloat(v); break;
      case 'ceiling': a.ceilingSeconds = parseInt(v, 10); break;
      case 'lift': a.lift = parseInt(v, 10); break;
      case 'rounds': a.rounds = parseInt(v, 10); break;
      case 'wave': a.wave = parseWave(v); break;
      case 'kit': a.kit = v.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'at': a.at = parseCell(v); break;
      case 'biome': a.biome = v; break;
      case 'moat': a.moat = parseInt(v, 10); break;     // trench width, see carveMoat
      case 'pool': a.pool = true; break;                // a sunk water pool under each mob's cell, for a drowned in water
      case 'pillar': a.pillar = true; break;            // a cover column toward the mob, see carveMoat
      case 'flood': a.flood = v === 'level' ? 'level' : 'under'; break; // the moat filled with water, see carveMoat
      case 'bare': a.bare = true; break;                // the island cleared above its floor, see carveMoat
      case 'swim': a.swim = v === 'under' ? 'under' : 'level'; break; // a pool sunk under the body's own stand, see sinkSwim
      case 'swim-radius': a.swimRadius = parseInt(v, 10); break;      // that pool's half-width, see sinkSwim
      case 'after': a.after = parseInt(v, 10); break;
      case 'follow': a.follow = parseWave(v); break;          // a second wave summoned into the round, see FOLLOW
      case 'follow-after': a.followAfter = parseFloat(v); break; // seconds into the round it arrives (default 5)   // seconds the body is watched once its wave ends, see watchAfter
      case 'hold': a.hold = parseInt(v, 10); break;     // seconds the field stands after the wave, see runWave
      case 'opposed': a.opposed = true; break;          // each mob on the bearing farthest from the others, see siteMobCells
      case 'hp': a.hp = parseFloat(v); break;         // the round opens on a body wounded to this health, see woundBot
      case 'provoke': a.provoke = true; break;          // every arena mob summoned angry at the bot, see angerNbt
      case 'same-ground': a.sameGround = true; break;   // later rounds reuse the first round's arena, see runWave
      case 'buddy': a.buddies = v.split(',').filter(Boolean); break; // more bodies in the same fight, see placeBuddy
      case 'buddy-gap': a.buddyGap = parseFloat(v); break; // blocks between the two at the opening, 0 stacks them
      case 'striker': a.striker = true; break;          // lanista brings the body itself, see lanista_striker
      case 'lead': a.lead = parseInt(v, 10); break;     // the striker judges reach at the mob's predicted position, see lanista_striker
      case 'loot': a.loot = true; break;                // what the body picked up after the wave and what it left, see readSpoils
      case 'arena': a.arena = v === undefined ? true : parseCell(v); break; // fight in the placed filming set, see ARENA SET
      case 'time': a.time = v; break;                   // the time of day the world is pinned to (default WORLD.time)
      case 'stage': a.stage = parseFloat(v); break;     // seconds a wave stands behind the closed gates, see ARENA SET
      case 'escalate': a.escalate = true; break;        // round n fights n× the wave; the run ends when the body falls
      case 'show': a.show = v; break;                   // the rounds are a declared show (arena_show.SHOWS); ends when the body falls
      case 'emperor': a.emperor = true; break;          // each staged wave waits for the emperor's release button, see arena_show
      case 'crowd': a.crowd = v === undefined ? 10 : parseInt(v, 10); break; // spectator puppets on the set's row, see NPC_bot
      case 'guard': a.guard = true; break;              // two armoured guards either side of the throne, see NPC_bot
      case 'ruler': a.ruler = true; break;              // ArchitectBot on the throne in gold armour, see NPC_bot
      case 'board': a.board = v === undefined ? true : parseInt(v, 10); a.emperor = true; break; // the When Board, see when_board
      case 'tnt': a.tnt = parseInt(v, 10); break;       // how many TNT the board's drop lets fall (default TNT_DEFAULT)
      default: break;
    }
  }
  // A round is always a list of (mob, count, hand) groups (Law 16). --wave wins over the single-mob dials.
  // `--show`: the run's species are the show's, one of each, so the checks made before the rounds (daylight) read them.
  const show = a.show && crowdShow.SHOWS[a.show];
  if (!a.wave && show) a.wave = [...new Set(show.flatMap(r => parseWave(r.wave).map(g => g.mob)))].map(mob => ({ mob, count: 1 }));
  if (!a.wave) a.wave = [{ mob: a.mob, count: a.count, hand: a.hand }];
  return a;
}

// A mob must be sited within the aggro range the bot honours for that species — `engageRangeFor` /
// architect_config's per-species table is the one route for that number (Law 16). Checked at parse time,
// before any placement, purge, survey or summon is spent (Law 13).
//
// Siting band: `range ± 2` (`SITE_BAND_SLACK`).
const SITE_BAND_SLACK = 2;
// Gap between two summons landing on the same cell.
const STACKED_SUMMON_GAP_MS = 500;
// Margin between the cell filter (sited cell centre) and the presence gate (live position after landing).
const AGGRO_SITE_MARGIN = 1.0;

function rangeFitsAggro(wave, range) {
  if (!(range > 0)) return { ok: true };
  // The tightest species in the wave decides (Law 25).
  let worst = null;
  for (const g of wave) {
    const r = engageRangeFor(g.mob);
    if (!worst || r < worst.r) worst = { r, mob: g.mob };
  }
  const max = worst.r - SITE_BAND_SLACK;
  if (range + SITE_BAND_SLACK <= worst.r) return { ok: true, max, tightest: worst };
  return {
    ok: false, max, tightest: worst,
    why: `--range=${range} does not fit inside the aggro radius. The siting band is ±${SITE_BAND_SLACK}b, so this asks for a `
      + `${worst.mob} as far out as ${range + SITE_BAND_SLACK}b, and the bot honours a ${worst.mob} to ${worst.r}b. `
      + `The most this wave can ask for and still be certain of a fight is --range=${max}.`,
  };
}

// parseWave — "zombie:1,spider:1,skeleton:1@bow" → the group list. `@item` rides on the GROUP, not the
// wave. A malformed group throws (Law 13).
function parseWave(spec) {
  const groups = [];
  for (const raw of String(spec || '').split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^([a-z_]+)(?::(\d+))?(?:@([a-z_:]+))?$/i.exec(s);
    if (!m) throw new Error(`lanista: '${s}' is not a wave group — expected mob[:count][@item], e.g. skeleton:2@bow`);
    groups.push({ mob: m[1].toLowerCase(), count: m[2] ? parseInt(m[2], 10) : 1, hand: m[3] || undefined });
  }
  if (!groups.length) throw new Error('lanista: --wave was given but named no mobs');
  return groups;
}

function parseCell(text) {
  const p = String(text || '').split(',').map(Number);
  if (p.length !== 3 || p.some(n => !Number.isFinite(n))) throw new Error(`lanista: --at must be x,y,z (got '${text}')`);
  return { x: Math.floor(p[0]), y: Math.floor(p[1]), z: Math.floor(p[2]) };
}

// waveLabel — the one place a wave becomes prose (Law 16).
const waveLabel = wave => wave.map(g => `${g.count}×${g.mob}${g.hand ? `@${g.hand.replace(/^minecraft:/, '')}` : ''}`).join(' + ');

// ── Server reads (RCON, never the scout) ────────────────────────────────────────────────────────────
// The server's NBT is the authority on whether a body exists, where it is, and what it holds (Law 25) —
// the scout is a spectator client, and mineflayer gives a spectator no health for another player.

const NBT_VALUE = /entity data:\s*(.*)$/s;
const DEATH_OBJECTIVE = 'auren_lanista_deaths';

async function readBotVitals(rcon, botName) {
  const reply = (await rcon.command(`data get entity ${botName} Health`) || '').trim();
  const hm = NBT_VALUE.exec(reply);
  const health = hm ? parseFloat(hm[1]) : NaN;
  // A miss stays a miss, never a defaulted 0 (Law 13).
  if (!Number.isFinite(health)) return { known: false, alive: false, health: null, position: null };
  const posReply = (await rcon.command(`data get entity ${botName} Pos`) || '').trim();
  const pm = NBT_VALUE.exec(posReply);
  const nums = pm ? pm[1].match(/-?\d+(\.\d+)?/g) : null;
  const position = nums && nums.length >= 3
    ? { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) }
    : null;
  // health > 0 is the SERVER's own definition of alive.
  return { known: true, alive: health > 0, health, position };
}

// readAir — the body's breath off its own NBT (300 full, 0 drowning), or null when unread (Law 13).
async function readAir(rcon, botName) {
  const m = NBT_VALUE.exec((await rcon.command(`data get entity ${botName} Air`) || '').trim());
  const air = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(air) ? air : null;
}

// ── THE SPOILS, READ OFF THE SERVER (--loot) ─────────────────────────────────────────────────────────
// readCarry(rcon, bot) → { item: count } over the body's 36 slots, or null when unread (Law 13). Each item compound is
// read from its own braces: the id and the count beside it.
async function readCarry(rcon, botName) {
  const m = NBT_VALUE.exec((await rcon.command(`data get entity ${botName} Inventory`) || '').trim());
  if (!m) return null;
  const text = m[1], carry = {};
  const idRe = /id:\s*"minecraft:([a-z0-9_]+)"/g;
  for (let hit; (hit = idRe.exec(text));) {
    const open = text.lastIndexOf('{', hit.index), close = text.indexOf('}', hit.index);
    const c = /count:\s*(\d+)/.exec(text.slice(open, close < 0 ? undefined : close));
    carry[hit[1]] = (carry[hit[1]] || 0) + (c ? parseInt(c[1], 10) : 1);
  }
  return carry;
}
// SPOILS_RADIUS: a drop lying farther from the body than this is not counted as left by it (drop_collector's walk is 8 b).
const SPOILS_RADIUS = 10;
const SPOILS_WATCH_MS = 30000;
// readSpoils(rcon, bot, before) → { stood, gained, loose }: waits for the watch to stand again (the body's spoils sweep
// runs before its wave hands the body back), then reads what the carry gained since `before` and how many item entities
// still lie within SPOILS_RADIUS of the body. `loose` null = unread.
async function readSpoils(rcon, botName, before) {
  const stood = await awaitStandingWatch(botName, SPOILS_WATCH_MS);
  const after = await readCarry(rcon, botName);
  const gained = {};
  if (after) for (const [k, n] of Object.entries(after)) if (n > (before[k] || 0)) gained[k] = n - (before[k] || 0);
  const reply = (await rcon.command(`execute as ${botName} at @s if entity @e[type=minecraft:item,distance=..${SPOILS_RADIUS}]`) || '').trim();
  const cm = /count:\s*(\d+)/i.exec(reply);
  // The console answers a passed test with its count and a failed one with nothing at all; the empty reply is a zero only
  // when the same console has just answered the carry read.
  const loose = cm ? parseInt(cm[1], 10) : (/failed/i.test(reply) || (reply === '' && after)) ? 0 : null;
  return { stood: stood.ok, gained: after ? gained : null, loose };
}

async function ensureDeathCounter(rcon) {
  // Idempotent: safe to call every run.
  await rcon.command(`scoreboard objectives add ${DEATH_OBJECTIVE} deathCount`);
}

// Three outcomes kept apart: a number, a confirmed ZERO (`none is set`), or genuinely UNREAD (null)
// (Law 25).
async function readDeaths(rcon, botName) {
  const reply = (await rcon.command(`scoreboard players get ${botName} ${DEATH_OBJECTIVE}`) || '').trim();
  const m = /has (-?\d+)/.exec(reply);
  if (m) return parseInt(m[1], 10);
  if (/none is set/i.test(reply)) return 0;
  return null;
}

// ── Authoring the BODY: where it stands and what it holds ───────────────────────────────────────────
// Position and kit are AUTHORED inputs (Law 26), each read back off the server before anything is measured.

// placeBot — teleport, then WAIT FOR THE BODY TO BE THERE (Law 23). Tolerance ±1 x/z, ±3 y matches
// fleet_control's `move`.
async function placeBot(rcon, botName, cell, { tries = 20, waitMs = 250 } = {}) {
  await rcon.command(`tp ${botName} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5}`);
  for (let i = 0; i < tries; i++) {
    await sleep(waitMs);
    const at = await readBotVitals(rcon, botName);
    if (!at.known || !at.position) continue;
    const p = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };
    if (Math.abs(p.x - cell.x) <= 1 && Math.abs(p.z - cell.z) <= 1 && Math.abs(p.y - cell.y) <= 3) {
      return { ok: true, at: p };
    }
  }
  return { ok: false, why: `'${botName}' never landed on ${fmt(cell)} — is it connected, and is that cell loaded?` };
}

// kitBot — the loadout, as an authored input, verified against the server's own inventory NBT.
// The inventory is wiped first (`clear`) so the kit is the body's whole loadout. Slot order is the
// kit's order: `hotbar.0`, `hotbar.1`, …; `shield` goes to the offhand, where the fleet's shield reflex
// reads it from. The verdict is always the server's Inventory NBT, never the command's reply (Law 23/25).
// `item*N` carries a stack of N (`dirt*32`: the blocks a cover wall is set from), or N slots of an item that does not
// stack; a bare item is one.
const OFFHAND_ITEMS = new Set(['shield']);
// Armour is worn, not carried: each piece goes to its own armour slot.
const ARMOR_SLOT = [[/_helmet$/, 'armor.head'], [/_chestplate$/, 'armor.chest'], [/_leggings$/, 'armor.legs'], [/_boots$/, 'armor.feet']];
const wornSlot = (id) => { const hit = ARMOR_SLOT.find(([re]) => re.test(id)); return hit ? hit[1] : null; };
// An item that does not stack (a tool, a weapon) asked for N times is laid one to a slot: a kit carries three pickaxes as
// three pickaxes (terminator_kits' standard kit does).
const UNSTACKABLE = /_(pickaxe|axe|shovel|hoe|sword)$|^minecraft:(shield|bow|crossbow|trident|mace)$/;
async function kitBot(rcon, botName, kit) {
  const stacks = kit.flatMap((spec) => {
    const [name, n] = String(spec).split('*');
    const id = name.startsWith('minecraft:') ? name : `minecraft:${name}`;
    const count = n ? parseInt(n, 10) : 1;
    return UNSTACKABLE.test(id) ? Array.from({ length: count }, () => ({ id, count: 1 })) : [{ id, count }];
  });
  const items = stacks.map(s => s.id);
  await rcon.command(`clear ${botName}`);
  let hotbar = 0;
  for (const { id, count } of stacks) {
    const slot = OFFHAND_ITEMS.has(id.replace(/^minecraft:/, '')) ? 'weapon.offhand' : wornSlot(id) || (hotbar < 9 ? `hotbar.${hotbar++}` : `inventory.${hotbar++ - 9}`);
    await rcon.command(`item replace entity ${botName} ${slot} with ${id} ${count}`);
  }
  // Both halves of the body's carry: the 36 inventory slots and the worn slots (a separate NBT compound).
  const inv = (await rcon.command(`data get entity ${botName} Inventory`) || '').trim();
  const off = (await rcon.command(`data get entity ${botName} equipment`) || '').trim();
  const seen = `${inv} ${off}`;
  const missing = items.filter(id => !seen.includes(id));

  // BARE FISTS IS A KIT, not the absence of one — the empty kit's assay is the OPPOSITE: the server must
  // show nothing held (Law 23).
  if (items.length === 0) {
    const holding = /id:\s*"/.test(seen);
    return {
      ok: !holding, items, missing: [], inventory: inv, offhand: off,
      bare: !holding,
      unclearedDetail: holding ? 'the body still holds items after `clear` — bare fists is UNVERIFIED' : null,
    };
  }
  return { ok: missing.length === 0, items, missing, inventory: inv, offhand: off, bare: false };
}

// ── HEAL THE BODY TO FULL, AND READ BACK THAT IT TOOK ────────────────────────────────────────────────
// `kitBot`'s sibling: opens every trial on a body at full health. Amplifier 20; read off the server
// (Law 23), never inferred from the command not erroring. Duration 1s, finished before wave 1 begins.
async function healBot(rcon, botName) {
  const before = await readBotVitals(rcon, botName);
  // The effect applies on the next server tick. It is given again every few reads: a body still taking a hit (an arrow
  // left in flight, a last blow) can lose health after the first one lands.
  for (let i = 0; i < 10; i++) {
    if (i % 3 === 0) await rcon.command(`effect give ${botName} minecraft:instant_health 1 20 true`);
    await sleep(300);
    const v = await readBotVitals(rcon, botName);
    if (v.known && v.health >= 20) return { ok: true, health: v.health, was: before.known ? before.health : null };
  }
  const last = await readBotVitals(rcon, botName);
  return { ok: false, health: last.known ? last.health : null, was: before.known ? before.health : null };
}

// ── OPEN THE ROUND WOUNDED ───────────────────────────────────────────────────────────────────────────
// `--hp=N`: after the heal, the body is dealt 20 − N generic damage (the server's own /damage), so a round tests the
// body at a health it must defend (self_preservation's flee line). Read back off the server (Law 23).
async function woundBot(rcon, botName, hp) {
  await rcon.command(`damage ${botName} ${20 - hp} minecraft:generic`);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const v = await readBotVitals(rcon, botName);
    if (v.known && v.health <= hp + 0.5) return { ok: true, health: v.health };
  }
  const last = await readBotVitals(rcon, botName);
  return { ok: false, health: last.known ? last.health : null };
}

// ── placeBuddy — THE SECOND BODY, BESIDE THE FIRST, KITTED AND HEALED THE SAME ──────────────────────────
// Each stands `gap` blocks further along x than the last, on the nearest cell the server says is open: two air cells
// on a floor that is neither leaves nor water. A body teleported blind landed inside a trunk and suffocated.
const STAND_SEARCH_X = 6, STAND_SEARCH_Z = 3, STAND_SEARCH_Y = 4;
async function openStand(rcon, x0, y0, z0) {
  for (let dx = 0; dx <= STAND_SEARCH_X; dx++) {
    for (const dz of Array.from({ length: 2 * STAND_SEARCH_Z + 1 }, (_, i) => (i % 2 ? (i + 1) / 2 : -i / 2))) {
      for (const dy of Array.from({ length: 2 * STAND_SEARCH_Y + 1 }, (_, i) => (i % 2 ? (i + 1) / 2 : -i / 2))) {
        const [x, y, z] = [x0 + dx, y0 + dy, z0 + dz];
        const r = (await rcon.command(`execute if block ${x} ${y} ${z} minecraft:air if block ${x} ${y + 1} ${z} minecraft:air `
          + `unless block ${x} ${y - 1} ${z} minecraft:air unless block ${x} ${y - 1} ${z} #minecraft:leaves unless block ${x} ${y - 1} ${z} minecraft:water`)) || '';
        if (/passed/i.test(r)) return { x, y, z };
      }
    }
  }
  return null;
}

async function placeBuddy(rcon, args, name, cell, nth) {
  const watch = await awaitStandingWatch(name);
  if (!watch.ok) return { ok: false, reason: `${name}: ${watch.reason}`, cause: 'bot' };
  const gap = Number.isFinite(args.buddyGap) ? args.buddyGap : 1;
  const stand = gap === 0 ? cell : await openStand(rcon, cell.x + gap * nth, cell.y, cell.z);
  if (!stand) return { ok: false, reason: `no open cell for ${name} near ${cell.x + gap * nth},${cell.y},${cell.z}`, cause: 'terrain' };
  const put = await placeBot(rcon, name, stand);
  if (!put.ok) return { ok: false, reason: put.why, cause: 'terrain' };
  const at = await readBotVitals(rcon, name);
  if (args.kit) {
    const k = await kitBot(rcon, name, args.kit);
    if (!k.ok) return { ok: false, reason: `${name} is missing ${k.missing.join(', ')} after the re-kit`, cause: 'bench' };
  }
  const healed = await healBot(rcon, name);
  if (!healed.ok) return { ok: false, reason: `${name} would not heal to full (hp ${healed.health})`, cause: 'bench' };
  return { ok: true, position: at.position };
}

// readBiome — the fight's biome, off the SCOUT's chunk cache. Returns null when the column is not
// loaded; null is never a biome name (Law 23).
function readBiome(scout, cell) {
  const r = scout.biomeAt(cell);
  return r && r.known ? r.biome : null;
}

// The field: every mob this tool put in the world (by `ARENA_TAG`), and its health. `tag` narrows it to one arena of
// several (colosseum: one tag per body), every one of which also carries ARENA_TAG.
async function readArenaMobs(rcon, tag = ARENA_TAG) {
  const reply = (await rcon.command(`execute as @e[tag=${tag}] run data get entity @s Health`) || '').trim();
  const healths = [...reply.matchAll(/entity data:\s*(-?\d+(?:\.\d+)?)f/g)].map(m => parseFloat(m[1]));
  return { count: healths.length, totalHealth: healths.reduce((a, b) => a + b, 0), healths };
}

// applyWorld — author the conditions, then READ THEM BACK (Law 23). The gamerule goes first, before time.
async function applyWorld(rcon, w) {
  // NO WILD MOBS: lanista is an isolated test, so the world spawns nothing and every hostile in a round is one this
  // tool summoned. The rule's prior value is read first, so `close()` hands the world back as it was found.
  const spawningBefore = ((await rcon.command('gamerule spawn_mobs')) || '').trim();
  await rcon.command('gamerule spawn_mobs false');
  await rcon.command(`gamerule advance_time ${w.daylightCycle}`);
  await rcon.command(`time set ${w.time}`);
  await rcon.command(`weather ${w.weather} 1000000`);
  await rcon.command(`difficulty ${w.difficulty}`);
  // mob_griefing is READ here, not set — authored once at server bring-up by fleet_control's
  // REQUIRED_GAMERULES (Law 16). `combat_lens.detonations` reads the server's `explosion` packet.
  return {
    // 26.1 reads the time of day as the `day` timeline (`time query daytime` is gone).
    time: ((await rcon.command('time query day')) || '').trim(),
    difficulty: ((await rcon.command('difficulty')) || '').trim(),
    cycle: ((await rcon.command('gamerule advance_time')) || '').trim(),
    griefing: ((await rcon.command('gamerule mob_griefing')) || '').trim(),
    spawning: ((await rcon.command('gamerule spawn_mobs')) || '').trim(),
    spawningBefore,
  };
}

// ── Siting: where the mob goes ──────────────────────────────────────────────────────────────────────
// Keeps an uncapped voxel sweep from pinning the event loop the scout's socket needs.
const PACE = () => new Promise(r => setImmediate(r));

// The sightline seam: camera_scout.aggroLineOfSight is the same predicate threat_scanner gates on (Law 16).
const sightlineFor = scout => ({ check: (from, to, maxDist) => scout.aggroLineOfSight(from, to, maxDist) });

// The reachability seam imports the body's own pathfinder (safe from outside the construct — see
// lanista_shared's require), unlike the sightline seam, which the scout copies. Returns `{ known,
// reachable }` (Law 23/25): a box needing more than the cap is declined and reported as unproven, never
// as impassable ground.
const REACH_MAX_NODES = 4000;

// Feet cell → the block stood ON.
const floorOf = c => ({ x: c.x, y: c.y - 1, z: c.z });

function reachabilityFor(scout, maxNodes = REACH_MAX_NODES) {
  return {
    async check(fromFeet, toFeet) {
      const from = floorOf(fromFeet), to = floorOf(toFeet);
      // Same four-field snapshot reader arena_sites hands the box sweep (Law 16).
      const view = { blockAt: p => scout.blockAt(p), entity: { position: from } };
      let res;
      try {
        res = await pathfinding.computeAStar(view, from, { type: 'position', pos: to },
          { maxNodes, allowDig: false, allowPlace: false });
      } catch (e) {
        // A throw is a CODING fault in this adapter, never terrain — reported as unknown (Law 25).
        return { known: false, reachable: false, why: `search threw: ${e.message}` };
      }
      // Empty path = already there.
      if (res && res.path && !res.partial) return { known: true, reachable: true, nodes: res.nodesVisited };
      const complete = !!(res && res.complete);
      if (!complete) return { known: false, reachable: false, why: `search incomplete (${res ? res.nodesVisited : 0}/${maxNodes} nodes)` };
      return { known: true, reachable: false, why: 'no world-preserving route' };
    },
  };
}

// siteMobCells — the whole of "place mob near bot", as one call. Range band ±2 (`SITE_BAND_SLACK`);
// asked and got are both returned (Law 25). The lift stands the mob one bot-height above the bot, a
// CONTROL, with a recorded fallback (`liftFellBack`). Does not choose the anchor — `botCell` arrives
// already decided (see siteArena). `cache` is a cost dial only.
async function siteMobCells(scout, botCell, want, range, lift = 0, cache = null, opposed = false) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const opts = { pace: PACE, ...dials, ...band, ...(cache ? { cache } : {}) };

  const opp = await arena.findOpponentSpawns(arena.readerFromScout(scout), botCell, opts);
  if (!opp.boxes.length) {
    // Names WHAT the ground refused on (Law 25).
    const why = arena.formatRejections(opp.scan.rejections);
    return { cells: [], band: 0, pool: 0, refused: 0,
      detail: `no opponent box in the ${Math.max(2, range - 2)}–${range + 2}b band on this ground (${opp.scan.checked} cell(s) checked: ${why})` };
  }

  const split = await arena.partitionByLineOfSight(opp.boxes, botCell, sightlineFor(scout), opts);
  const pool = SITING.requireSightline ? split.visible : [...split.visible, ...split.hidden];
  const refused = split.unreachable.length + split.unknownReach.length;
  if (!pool.length) {
    // The two walls (unfinished search vs proven impassable) are named apart (Law 25).
    const proven = split.unreachable.length, unproven = split.unknownReach.length;
    return {
      cells: [], band: opp.boxes.length, pool: 0, refused,
      detail: refused === opp.boxes.length
        ? `all ${opp.boxes.length} box(es) in the band failed the reach gate — ${proven} proven impassable, ${unproven} unproven (the search never finished)`
        : `${opp.boxes.length} box(es) in the band, ${refused} refused by the reach gate ` +
          `(${proven} impassable, ${unproven} unproven), none of the rest had a clear line`,
    };
  }

  // Nearest to the asked-for distance first; with no range, spread across DIFFERENT bearings. The lift
  // filter runs after both gates, so it only narrows an already-confirmed set.
  const lifted = lift > 0 ? pool.filter(box => (box.y - botCell.y) >= lift) : pool;
  const liftFellBack = lift > 0 && lifted.length === 0;
  const usable = liftFellBack ? pool : lifted;

  const cells = [];
  if (range > 0 && opposed) {
    // `--opposed`: the first mob takes the box nearest the asked range; each next one takes, among the boxes within
    // 2b of it, the one whose bearing from the body is farthest from every bearing already taken.
    const bearing = (b) => Math.atan2(b.z - botCell.z, b.x - botCell.x);
    const apart = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
    const near = usable.filter((b) => Math.abs(b.distance - range) <= 2)
      .sort((a, b) => Math.abs(a.distance - range) - Math.abs(b.distance - range));
    const taken = [];
    for (let i = 0; i < want && near.length; i++) {
      let best = near[0], bestGap = -1;
      if (taken.length) {
        for (const b of near) {
          const gap = Math.min(...taken.map((t) => apart(bearing(b), t)));
          if (gap > bestGap) { best = b; bestGap = gap; }
        }
      }
      taken.push(bearing(best));
      cells.push({ x: best.x, y: best.y, z: best.z, distance: best.distance });
    }
  } else if (range > 0) {
    const byWanted = usable.slice().sort((a, b) => Math.abs(a.distance - range) - Math.abs(b.distance - range));
    for (let i = 0; i < want; i++) {
      const box = byWanted[i % byWanted.length];
      cells.push({ x: box.x, y: box.y, z: box.z, distance: box.distance });
    }
  } else {
    const stride = Math.max(1, Math.floor(usable.length / want));
    for (let i = 0; i < want; i++) {
      const box = usable[(i * stride) % usable.length];
      cells.push({ x: box.x, y: box.y, z: box.z, distance: box.distance });
    }
  }
  return {
    cells, band: opp.boxes.length, pool: pool.length, refused, detail: null,
    rangeAsked: range > 0 ? range : null,
    rangeGot: cells.length ? Math.round(cells[0].distance * 10) / 10 : null,
    liftAsked: lift > 0 ? lift : null,
    // Measured on the cells that were CHOSEN, not the pool.
    liftGot: cells.length ? Math.min(...cells.map(c => c.y - botCell.y)) : null,
    liftPool: lifted.length,
    liftFellBack,
  };
}

// ── siteArena — FIND THE ARENA FIRST; THE BODY IS MOVED TO IT, NOT ASKED ABOUT ────────────────────────
// Finds a spot without caring where the bot currently is, then moves the bot to spot 1 and the mob to
// spot 2. The body's current stand is not an input to the search (Law 25); built on
// `arena_sites.findArenaPairs` (Law 22 gate 2).
//
// Two passes: pass 1 finds the first proven partner near the origin; pass 2 re-probes that anchor for
// its whole band, on the same cache. The origin is a starting point, not a constraint.
async function siteArena(scout, origin, want, range, lift = 0, opposed = false) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  // The ground dial is passed here, not to `siteMobCells`: this pass chooses WHERE the arena is.
  if (SITING.ground) dials.ground = SITING.ground;
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const cache = arena.createSiteCache();

  const found = await arena.findArenaPairs(
    arena.readerFromScout(scout), origin, sightlineFor(scout),
    { pace: PACE, cache, pairs: 1, ...dials, ...band });

  // A refusal here is a statement about the REGION.
  if (!found.ok) {
    return {
      cells: [], botCell: null, band: 0, pool: 0, refused: 0,
      detail: `no arena anywhere the sweep could reach from ${fmt(origin)} — ${found.detail}`,
    };
  }

  const anchor = found.pairs[0];
  const botCell = { x: anchor.bot.x, y: anchor.bot.y, z: anchor.bot.z };
  const sited = await siteMobCells(scout, botCell, want, range, lift, cache, opposed);

  // NOT AN ENVIRONMENTAL FAILURE — an instrument fault, never reported as terrain (Law 13).
  if (!sited.cells.length) {
    throw new Error(`[lanista] CODING VIOLATION: findArenaPairs proved a partner at the anchor ${fmt(botCell)} ` +
      `and the re-probe of the same anchor, on the same cache, found none — "${sited.detail}". ` +
      `The two passes cannot disagree; one of them is not asking what it says it asks.`);
  }

  return {
    ...sited,
    botCell,
    // Asked and got, for the anchor too (Law 25).
    originDistance: Math.round(anchor.originDistance * 10) / 10,
    arenaSite: anchor.site,
    anchorsTried: found.scan ? found.scan.checked : null,
  };
}

// ── Delivery: putting the mob there ─────────────────────────────────────────────────────────────────
// PersistenceRequired stops the summoned mob despawning mid-fight. NoAI is not set: real approach
// behaviour is the point.

function equipmentNbt(hand) {
  const id = hand.startsWith('minecraft:') ? hand : `minecraft:${hand}`;
  return `,equipment:{mainhand:{id:"${id}",count:1}}`;
}

// ── A SUMMONED MOB ARRIVES WITH NOTHING ─────────────────────────────────────────────────────────────
// `/summon` produces a mob with NO equipment. `--hand` is READ BACK, never trusted (Law 23).
async function summonAt(rcon, mob, cell, hand, extraNbt = '', tag = null) {
  const nbt = `{PersistenceRequired:1b,Tags:["${ARENA_TAG}"${tag ? `,"${tag}"` : ''}]${hand ? equipmentNbt(hand) : ''}${extraNbt}}`;
  const reply = (await rcon.command(`summon minecraft:${mob} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5} ${nbt}`) || '').trim();
  const ok = !/failed|error|unknown|incorrect/i.test(reply);

  let armed = null, held = null;
  if (ok && hand) {
    // Matched on the mob nearest this cell, since every arena mob shares one tag.
    held = (await rcon.command(`data get entity @e[tag=${tag || ARENA_TAG},type=${mob},limit=1,sort=nearest,x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5}] equipment`) || '').trim();
    armed = held.includes(hand.replace(/^minecraft:/, ''));
  }
  return { ok, reply, armed, held };
}

async function clearArena(rcon, tag = ARENA_TAG) {
  return rcon.command(`kill @e[tag=${tag}]`);
}

// ── `--provoke`: A NEUTRAL MOB SUMMONED ANGRY AT THE BOT ────────────────────────────────────────────────
// An enderman struck from the console (`damage … by <bot>`) took the damage and never turned on the bot, so the anger
// is authored where the game keeps it: the neutral mob's saved target and end time, under the field names from
// 1.21.5 on (`angry_at`, `anger_end_time`) and before (`AngryAt`, `AngerTime`). Whether it took is read off the bot's
// own trace (the commander's `via=angered`), never assumed.
const ANGER_TICKS = 1200;
async function angerNbt(rcon, botName) {
  const uuid = /\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/.exec((await rcon.command(`data get entity ${botName} UUID`)) || '');
  const tick = /game time is (\d+)/i.exec((await rcon.command('time query gametime')) || '');
  if (!uuid || !tick) throw new Error(`lanista: --provoke could not read ${botName}'s UUID or the game time`);
  const id = `[I;${uuid.slice(1, 5).join(',')}]`;
  const end = parseInt(tick[1], 10) + ANGER_TICKS;
  log('round', `  provoke: summoned angry at ${botName} ${id} until game tick ${end}`);
  return `,angry_at:${id},anger_end_time:${end}L,AngryAt:${id},AngerTime:${ANGER_TICKS}`;
}

// ── THE MOAT — AN OPPONENT THE BODY CAN SEE AND NO WALK REACHES ────────────────────────────────────
// `--moat=W` carves a square trench ring round the body's stand after the siting proved the opponent reachable:
// cells MOAT_INNER+1 to MOAT_INNER+W out (chessboard distance), from MOAT_DEPTH under the floor up through head
// height, so the body stands on an island with the mob outside it, still in sight. The siting's reach gate is
// what makes the moat the one thing that changed. `--pillar` stands a 3-high stone column two cells toward the
// mob, so a stand behind it is cover in reach. Authored over RCON and read back (Law 23): every trench column's
// floor cell must read air. A rollback start restores the ground; a continue start keeps the trench.
const MOAT_INNER = 3;
const MOAT_DEPTH = 8;
async function carveMoat(rcon, cell, width, mobCell, pillar, bare, flood) {
  const lo = MOAT_INNER + 1, hi = MOAT_INNER + width;
  const y0 = cell.y - 1 - MOAT_DEPTH, y1 = cell.y + 2;
  const box = (x0, z0, x1, z1) => `fill ${cell.x + x0} ${y0} ${cell.z + z0} ${cell.x + x1} ${y1} ${cell.z + z1} minecraft:air`;
  for (const cmd of [box(-hi, -hi, hi, -lo), box(-hi, lo, hi, hi), box(-hi, -MOAT_INNER, -lo, MOAT_INNER), box(lo, -MOAT_INNER, hi, MOAT_INNER)]) {
    await rcon.command(cmd);
  }
  // Read back on the four axis cells of the ring's inner edge, floor level.
  const probes = [[lo, 0], [-lo, 0], [0, lo], [0, -lo]];
  const solid = [];
  for (const [dx, dz] of probes) {
    const r = ((await rcon.command(`execute if block ${cell.x + dx} ${cell.y - 1} ${cell.z + dz} minecraft:air`)) || '').trim();
    if (!/passed/i.test(r)) solid.push(`${cell.x + dx},${cell.y - 1},${cell.z + dz}`);
  }
  // `--flood` (or `--flood=under`): the trench is filled with water to one cell under the floor, so its banks stand one block over the
  // surface (a fight across it swims, and leaves the water only by setting a block: water_bank_out). Read back on the
  // same four cells, at the surface. `--flood=level`: filled to the floor, so the banks stand level with the surface and
  // the body climbs straight out with no block (water_exit).
  if (flood) {
    const top = flood === 'level' ? cell.y - 1 : cell.y - 2;
    const wet = (x0, z0, x1, z1) => `fill ${cell.x + x0} ${y0} ${cell.z + z0} ${cell.x + x1} ${top} ${cell.z + z1} minecraft:water`;
    for (const cmd of [wet(-hi, -hi, hi, -lo), wet(-hi, lo, hi, hi), wet(-hi, -MOAT_INNER, -lo, MOAT_INNER), wet(lo, -MOAT_INNER, hi, MOAT_INNER)]) {
      await rcon.command(cmd);
    }
    for (const [dx, dz] of probes) {
      const r = ((await rcon.command(`execute if block ${cell.x + dx} ${top} ${cell.z + dz} minecraft:water`)) || '').trim();
      if (!/passed/i.test(r)) solid.push(`${cell.x + dx},${top},${cell.z + dz} (not water)`);
    }
  }
  // `--bare`: the island is cleared above its floor (trees, plants), so nothing on it hides the body and the only
  // cover is what the body sets itself.
  if (bare) await rcon.command(`fill ${cell.x - MOAT_INNER} ${cell.y} ${cell.z - MOAT_INNER} ${cell.x + MOAT_INNER} ${cell.y + 8} ${cell.z + MOAT_INNER} minecraft:air`);
  let column = null;
  if (pillar && mobCell) {
    const dx = mobCell.x - cell.x, dz = mobCell.z - cell.z;
    const len = Math.hypot(dx, dz) || 1;
    column = { x: cell.x + Math.round(2 * dx / len), z: cell.z + Math.round(2 * dz / len) };
    await rcon.command(`fill ${column.x} ${cell.y} ${column.z} ${column.x} ${cell.y + 2} ${column.z} minecraft:stone`);
  }
  return { ok: solid.length === 0, solid, ring: [lo, hi], depth: MOAT_DEPTH, column };
}

// sinkSwim — `--swim`: a water pool sunk under the body's own stand, so the wave opens on a body afloat. `level`
// fills it to the floor (the banks stand level with the surface, a body climbs straight out); `under` fills it one
// under the floor (the banks stand one block over the surface: water_bank_out or a dig). Above the water is cleared
// to three over the floor, so nothing on the ground hides the body. `radius` is the half-width (default 2); one wide
// enough to take the mob cells makes a fight fought water to water. Read back at the body's own column (Law 23).
const SWIM_DEPTH = 4;
async function sinkSwim(rcon, cell, mode, radius) {
  const r = radius > 0 ? radius : 2;
  const top = mode === 'under' ? cell.y - 2 : cell.y - 1;
  const x0 = cell.x - r, x1 = cell.x + r, z0 = cell.z - r, z1 = cell.z + r;
  await rcon.command(`fill ${x0} ${top + 1} ${z0} ${x1} ${cell.y + 3} ${z1} minecraft:air`);
  await rcon.command(`fill ${x0} ${cell.y - 1 - SWIM_DEPTH} ${z0} ${x1} ${top} ${z1} minecraft:water`);
  const surface = ((await rcon.command(`execute if block ${cell.x} ${top} ${cell.z} minecraft:water`)) || '').trim();
  const bottom = ((await rcon.command(`execute if block ${cell.x} ${cell.y - 1 - SWIM_DEPTH} ${cell.z} minecraft:water`)) || '').trim();
  return { ok: /passed/i.test(surface) && /passed/i.test(bottom), top, radius: r, depth: top - (cell.y - 1 - SWIM_DEPTH) + 1 };
}

// ── THE WORLD'S OWN HOSTILES ────────────────────────────────────────────────────────────────────────
// `gamerule spawn_mobs false` stops new spawns only; existing hostiles in loaded chunks are purged here
// (Law 25). Purged by explicit type, never `type=!player`: animals, villagers, item frames, armour
// stands and drops are left standing. `tag=!ARENA_TAG` excludes this tool's own mobs.
const AMBIENT_HOSTILES = [
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin', 'zoglin',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'silverfish', 'endermite',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'breeze',
  'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'vex',
  'piglin', 'piglin_brute', 'hoglin', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker',
];
// Wider than AGGRO_RANGE on purpose, so nothing the world owns can walk in mid-wave.
const PURGE_RADIUS = AGGRO_RANGE * 2;

// THE WILD-MOB CHECK: the round's control is that every hostile near it is this tool's. Counted, never assumed
// (Law 23), inside WILD_CHECK_RADIUS of the fight cell — wider than any aggro range the bot honours, so a mob
// that could walk into the fight is counted; a mob in some other body's chunks far off is not this round's.
const WILD_CHECK_RADIUS = 64;
// countWildHostiles(rcon, cell) → { total, named: ['zombie×2', …] } of untagged hostiles within the radius.
async function countWildHostiles(rcon, cell) {
  const at = `x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5},distance=..${WILD_CHECK_RADIUS}`;
  let total = 0;
  const named = [];
  for (const type of AMBIENT_HOSTILES) {
    const reply = (await rcon.command(`execute if entity @e[type=${type},tag=!${ARENA_TAG},${at}]`) || '');
    const m = /count:\s*(\d+)/i.exec(reply);
    const count = m ? parseInt(m[1], 10) : (/passed/i.test(reply) ? 1 : 0);
    if (count) { total += count; named.push(`${type}×${count}`); }
  }
  return { total, named };
}

// Returns how many were standing there (Law 6).
async function purgeAmbientHostiles(rcon, cell) {
  const at = cell ? `,x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5},distance=..${PURGE_RADIUS}` : '';
  let killed = 0;
  for (const type of AMBIENT_HOSTILES) {
    const reply = (await rcon.command(`kill @e[type=${type},tag=!${ARENA_TAG}${at}]`) || '');
    const m = /Killed (\d+)/.exec(reply);
    if (m) killed += parseInt(m[1], 10);
    else if (/^Killed /.test(reply)) killed += 1;   // the server says "Killed <name>" for exactly one
  }
  return killed;
}

// ── THE SUMMON IS GATED ON THE BOT'S OWN WATCH ──────────────────────────────────────────────────────
// A monster is only spawned when the bot is in sentry mode. A wave the watch was not holding is refused,
// never scored (Law 25), read through the lens, never off the file (Law 26). Three facts: `armed` is the
// operator's mode; `engaged` goes false when the last mob resolves; `standing` is true only while a
// fresh watch loop is turning with no combat opened since.
const WATCH_WAIT_MS = 90000;
const WATCH_POLL_MS = 500;

const SCOUT_SEE_MS = 15000;
const SCOUT_POLL_MS = 400;

// awaitScoutSees — move the scout onto the fight cell, then prove it can READ that cell (Law 23).
// `y + 40`: a spectator vantage above the ground.
// A null (unloaded chunk or void) means this client cannot answer questions about this place.
async function awaitScoutSees(scout, rcon, cell, waitMs = SCOUT_SEE_MS) {
  await rcon.command(`tp ${SCOUT_NAME} ${cell.x + 0.5} ${cell.y + 40} ${cell.z + 0.5}`);
  const until = Date.now() + waitMs;
  for (;;) {
    if (scout.blockAt({ x: cell.x, y: cell.y - 1, z: cell.z })) return true;
    if (Date.now() > until) return false;
    await sleep(SCOUT_POLL_MS);
  }
}

// Returns { ok } or { ok: false, reason } — the reason is written to be printed verbatim as a NOT RUN.
async function awaitStandingWatch(botName, waitMs = WATCH_WAIT_MS) {
  const t0 = Date.now();
  let announced = false;
  let last = null;
  for (;;) {
    last = combatLens.watchState(botName);
    // No journal at all is NOT "not armed" (Law 25).
    if (!last) return { ok: false, reason: `no combat journal for '${botName}' — the bot is not running under that name, so its watch cannot be read (nothing was summoned)` };
    if (!last.armed) return { ok: false, reason: `the bot is NOT IN SENTRY MODE — nothing was summoned. Arm the watch (\`verb sentry\`) before running a ladder` };
    if (last.standing && !last.engaged) return { ok: true, waitedMs: Date.now() - t0 };
    if (!announced) {
      announced = true;
      log('round', `  waiting for the watch to stand — ${last.engaged ? `still fighting ${last.openMobs.length} mob(s)` : 'the body is inside something else (spoils, errand, or a fight that has not reported)'}. Nothing is summoned onto a busy bot.`);
    }
    if (Date.now() - t0 > waitMs) {
      return { ok: false, reason: `the watch never stood down within ${Math.round(waitMs / 1000)}s — ` +
        `${last.engaged ? `a fight is still open on mob(s) ${last.openMobs.join(', ')}` : 'armed but never re-armed a watch loop'}. ` +
        `That is a STALL in the bot, not a slow wave — nothing was summoned` };
    }
    await sleep(WATCH_POLL_MS);
  }
}

// ── The fight: wait, and say what the world did ─────────────────────────────────────────────────────
// Both halves read off the server: bot health from NBT, the field from the tagged-entity count.
// `attributable`: the mobs' total health fell before they vanished (Law 25), counting only health lost
// while the field was still intact. `hpLostAfterClear` separates the bot killing it from it killing
// itself on the bot (Law 25).
//
// No wave timer. Three completions, none waiting for `ceilingMs`: the bot died (death counter), the
// field emptied (tagged-entity count), or the bot said so (`combat_lens.completedBattlesSince`, read
// through the lens, Law 26). The ceiling is a defect reading (`timeout`), not a result; the bot's claim
// may end the waiting and may not decide the outcome (Law 26). A fourth break, the stall: engagement is
// read as an exchange of damage off the server, never proximity or the bot's own claim (Law 26).
// `stallMs = 0` disables it.
const REPORT_WAIT_MS = 12000;
async function observeFight(rcon, botName, ceilingMs, stallMs = 0, buddyNames = [], striker = false) {
  // Counts deaths IN THIS ROUND.
  await ensureDeathCounter(rcon);
  await rcon.command(`scoreboard players set ${botName} ${DEATH_OBJECTIVE} 0`);
  const buddies = [];
  for (const name of buddyNames) {
    await rcon.command(`scoreboard players set ${name} ${DEATH_OBJECTIVE} 0`);
    buddies.push({ name, hpStart: null, hpEnd: null, minHp: Infinity, deaths: 0 });
  }
  const t0 = Date.now();
  const until = t0 + ceilingMs;
  let hpStart = null, hpEnd = null, minHp = Infinity, minAir = null;
  let mobsStart = null, mobsEnd = null, mobHpStart = null, mobHpLowIntact = Infinity;
  let botDied = false, fieldCleared = false, unreadable = 0, samples = 0, deaths = 0;
  // When damage was first exchanged either way, or null; `stalled` is that null still standing at the
  // stall window's close.
  let engagedAt = null, stalled = false;
  // The bot's own report of a finished battle, read through the lens.
  let reportedBattle = null;
  // Reads the bot's own watcher trace.
  const traceReadable = !striker && combatLens.readBotTrace(botName) !== null;
  if (!traceReadable && !striker) {
    log('round', `  ⚠ no watcher trace for '${botName}' — the bot's own disengage report is UNAVAILABLE this wave. ` +
      `A mob that walks away will run to the ${Math.round(ceilingMs / 1000)}s ceiling.`);
  }

  while (Date.now() < until) {
    const v = await readBotVitals(rcon, botName);
    const field = await readArenaMobs(rcon);
    samples++;
    if (mobsStart === null) { mobsStart = field.count; mobHpStart = field.totalHealth; }
    mobsEnd = field.count;
    if (field.count === mobsStart) mobHpLowIntact = Math.min(mobHpLowIntact, field.totalHealth);

    deaths = (await readDeaths(rcon, botName)) || 0;
    for (const buddy of buddies) {
      const bv = await readBotVitals(rcon, buddy.name);
      if (bv.known) {
        if (buddy.hpStart === null) buddy.hpStart = bv.health;
        buddy.hpEnd = bv.health; buddy.minHp = Math.min(buddy.minHp, bv.health);
      }
      buddy.deaths = (await readDeaths(rcon, buddy.name)) || 0;
    }
    if (!v.known) { unreadable++; await sleep(400); continue; }
    const air = await readAir(rcon, botName);
    if (air !== null) minAir = minAir === null ? air : Math.min(minAir, air);
    if (hpStart === null) hpStart = v.health;
    hpEnd = v.health;
    minHp = Math.min(minHp, v.health);

    // Read BEFORE the three completion breaks.
    if (engagedAt === null
        && ((mobHpStart != null && field.totalHealth < mobHpStart) || v.health < hpStart)) {
      engagedAt = Date.now();
    }
    if (stallMs && engagedAt === null && Date.now() - t0 > stallMs) { stalled = true; break; }
    // Checked BEFORE the cleared test.
    if (deaths >= 1 || !v.alive) { botDied = true; break; }
    // 3s floor: a summoned mob takes a tick or two to exist.
    if (field.count === 0 && Date.now() - t0 > 3000) { fieldCleared = true; break; }
    // THE BOT'S OWN REPORT, checked LAST — the observation outranks the claim (Law 26). With more bodies the fight is
    // over when the field empties or the first body dies, not when one of them reports its own wave closed.
    if (traceReadable && !buddies.length) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) { reportedBattle = reported[reported.length - 1]; break; }
    }
    await sleep(400);
  }

  let hpAfterClear = null;
  if (fieldCleared) {
    await sleep(1200);
    const after = await readBotVitals(rcon, botName);
    if (after.known) hpAfterClear = after.health;
    // ── THE SERVER SAYS *THAT* THE FIELD EMPTIED; ONLY THE BOT SAYS *HOW* ─────────────────────────
    // Supplies `reportedBattle` for the case the server ended the wave itself. Read through the lens,
    // never inferred from health (Law 25). Does not re-decide `fieldCleared`.
    // The bot closes its wave a pass or two after the server empties the field, so its report is waited for, up to
    // REPORT_WAIT_MS: read once at once, a fuse death the bot reports a moment later was scored as a clean kill.
    const reportBy = Date.now() + REPORT_WAIT_MS;
    while (traceReadable && !reportedBattle && Date.now() < reportBy) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) reportedBattle = reported[reported.length - 1];
      else await sleep(400);
    }
  }

  const damagedWhileIntact = mobHpStart != null && mobHpLowIntact !== Infinity
    ? round2(mobHpStart - mobHpLowIntact) : null;

  return {
    buddies: buddies.map((b) => ({ ...b, minHp: b.minHp === Infinity ? null : b.minHp })),
    botDied, fieldCleared,
    // Carried BESIDE the other outcomes, never folded into one of them.
    stalled, engagedMs: engagedAt === null ? null : engagedAt - t0,
    hpStart, hpEnd, minHp: minHp === Infinity ? null : minHp, minAir,
    hpLost: hpStart != null && hpEnd != null ? round2(hpStart - hpEnd) : null,
    mobsStart, mobsEnd, mobHpStart,
    mobDamageDealt: damagedWhileIntact,
    attributable: damagedWhileIntact == null ? null : damagedWhileIntact > 0,
    hpAfterClear,
    hpLostAfterClear: hpAfterClear != null && hpEnd != null ? round2(hpEnd - hpAfterClear) : null,
    deaths, samples, unreadable, ms: Date.now() - t0,
    // The bot's side, carried BESIDE the server's numbers, never folded into them (Law 26).
    traceReadable,
    reportedBattle,
    reportedKilled: reportedBattle ? reportedBattle.killed.map(e => `${e.name}#${e.id}`) : [],
    reportedDisengaged: reportedBattle ? reportedBattle.disengaged.map(e => `${e.name}#${e.id}`) : [],
    // The server's own explosion packet, read through the lens.
    reportedDetonated: reportedBattle ? reportedBattle.detonated.map(e => `${e.name}#${e.id}`) : [],
    // A creeper the bot finished after its fuse lit: a fuse death, never a kill (battle_stations FUSED).
    reportedFused: reportedBattle && reportedBattle.fused ? reportedBattle.fused.map(e => `${e.name}#${e.id}`) : [],
    reportedUntouched: reportedBattle ? reportedBattle.untouched.map(e => `${e.name}#${e.id}`) : [],
  };
}

// watchAfter — `--after=<sec>`: the body is watched once its wave ends, mob gone or not: the span a fight hands back
// to nobody, a body afloat with nothing driving it. A death here is one more than the wave's own counter saw. Reports
// the lowest air and hp, and where the body ended.
async function watchAfter(rcon, botName, seconds, deathsBefore) {
  const until = Date.now() + seconds * 1000;
  let minAir = null, minHp = null, died = false, last = null;
  while (Date.now() < until) {
    const v = await readBotVitals(rcon, botName);
    const air = await readAir(rcon, botName);
    if (air !== null) minAir = minAir === null ? air : Math.min(minAir, air);
    if (v.known) { minHp = minHp === null ? v.health : Math.min(minHp, v.health); last = v.position; }
    const deaths = (await readDeaths(rcon, botName)) || 0;
    if (deaths > deathsBefore || (v.known && !v.alive)) { died = true; break; }
    await sleep(500);
  }
  return { seconds, minAir, minHp, died, endAt: last };
}

// ── One wave ────────────────────────────────────────────────────────────────────────────────────────
// Place the body → gate on the biome → site → summon every group → check the bot can see the fight →
// wait → clear. Anything refused is reported as NOT RUN (Law 25). Re-placed per wave; does NOT heal or
// re-kit — attrition across waves is what is measured.
//
// ── standBot — GET THE BODY ONTO THE SPOT AND THE EYES ONTO THE BODY. Everything before a summon. ────
// Spawn, teleport to spot, spawn monster, in that order (Law 16). Returns `{ ok:false, reason }` in the
// vocabulary runWave reports NOT RUN in.
async function standBot(scout, rcon, args, label) {
  // FIRST, BEFORE ANYTHING TOUCHES THE BODY.
  // A striker has no watch: lanista raised it and it fights only while a round is open.
  const watch = args.striker ? { ok: true, waitedMs: 0 } : await awaitStandingWatch(args.bot);
  if (!watch.ok) return { ok: false, reason: watch.reason, cause: 'bot' };
  if (watch.waitedMs > 1000) log(label, `  the watch is standing (waited ${Math.round(watch.waitedMs / 1000)}s for the body to come free).`);

  if (args.at) {
    const put = await placeBot(rcon, args.bot, args.at);
    if (!put.ok) return { ok: false, reason: put.why, cause: 'terrain' };
  }

  const at = await readBotVitals(rcon, args.bot);
  if (!at.known || !at.position) return { ok: false, reason: `the server will not answer for '${args.bot}' — is it connected?`, cause: 'bot' };
  if (!at.alive) return { ok: false, reason: 'the bot is dead — nothing to pit anything against', cause: 'bot' };
  const cell = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };

  // THE SCOUT HAS TO BE AT THE FIGHT, AND HAS TO PROVE IT CAN SEE IT (Law 23).
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — it was moved there and the chunk never arrived, so every terrain read would be a guess (nothing was summoned)` };
  }

  // THE BIOME GATE runs at the cell the fight actually happens on, not once at setup (Law 25).
  const biome = readBiome(scout, cell);
  if (args.biome && args.biome !== 'any') {
    if (biome === null) return { ok: false, reason: `the scout cannot read the biome at ${fmt(cell)} — the column is not loaded, so the control is unverified` };
    if (biome !== args.biome) return { ok: false, reason: `the fight cell is '${biome}', not the declared '${args.biome}' — the body has left its own experiment` };
  }

  // AFTER placement, BEFORE siting: placement is what loads the chunks around the stand.
  const ambient = await purgeAmbientHostiles(rcon, cell);
  if (ambient) log('purge', `${label}: ${ambient} hostile(s) the world owned were standing within ${PURGE_RADIUS}b of the fight cell — removed before the wave was placed.`);

  return { ok: true, cell, biome, ambient };
}

// ── sweepOrigin — WHERE THE SEARCH STARTS. Not where the fight is. ──────────────────────────────────
// The body's position is the SEED of a sweep, not the fight cell — only the scout needs to see it. The
// body is not moved here, even when `--at` is authored (Invariant B).
async function sweepOrigin(scout, rcon, args, label) {
  let cell;
  if (args.at) {
    cell = { x: Math.floor(args.at.x), y: Math.floor(args.at.y), z: Math.floor(args.at.z) };
  } else {
    const at = await readBotVitals(rcon, args.bot);
    if (!at.known || !at.position) return { ok: false, reason: `the server will not answer for '${args.bot}' — is it connected?`, cause: 'bot' };
    if (!at.alive) return { ok: false, reason: 'the bot is dead — nothing to pit anything against', cause: 'bot' };
    cell = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };
  }

  // Unread is not empty (Law 23).
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — the chunk never arrived, so the arena sweep would be reading nothing (nothing was summoned)`, cause: 'bench' };
  }
  return { ok: true, cell };
}

// ── THE WHEN BOARD'S CUES (when_board) ──────────────────────────────────────────────────────────────
// Each cue is a press on a unit that already owns the act; nothing here decides how. Recording reaches OBS only through
// workstation.findRecorder() (the one hook), in a child process, so a seconds-long OBS call never stalls the show's
// own loop or the puppets' connections. A machine with no recorder shows the two recording cues grey.
const TNT_DEFAULT = 16;
const OBS_CHECK_MS = 5000;
function showCues(rcon, args) {
  const emperor = args.emperorConsole;
  let recording = false, obsUp = null, tntDropped = 0;
  // What the crowd holds, read off the puppets' own hands (the lever in the box and the round's verdict move them too).
  const held = () => {
    const hands = (args.crowdBody || []).map(p => (p.bot.heldItem ? p.bot.heldItem.name : null));
    const up = hands.filter(h => h === 'green_banner').length, down = hands.filter(h => h === 'red_banner').length;
    return up + down === 0 ? null : up >= down ? 'up' : 'down';
  };
  const recorderFile = require('@utils/workstation').findRecorder();
  const { execFile } = require('child_process');
  const recorderCall = (fn) => new Promise((resolve) => {
    execFile(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(recorderFile)}).${fn}()))`],
      { cwd: require('path').resolve(__dirname, '..', '..', '..'), windowsHide: true, maxBuffer: 1 << 24 },
      (err, stdout) => resolve({ ok: !err, said: String(stdout || '').trim().split('\n').pop() }));
  });
  if (recorderFile) {
    const look = () => recorderCall('isRunning').then(r => { obsUp = r.said.endsWith('true'); });
    look();
    args.obsWatch = setInterval(look, OBS_CHECK_MS);
  }
  const recReady = () => (!recorderFile ? { state: 'unavailable', words: 'no recorder on this machine' }
    : obsUp === null ? { state: 'unavailable', words: 'asking whether OBS is up…' }
      : !obsUp ? { state: 'unavailable', words: 'OBS is not up (start the run with record film)' } : null);
  const verdict = (k) => () => emperor.press(k);
  return [
    { id: 'release', label: 'Release', group: 'The show',
      read: () => (emperor.waiting() === 'wave' ? { state: 'on', words: 'a wave is staged: press to let it out' }
        : emperor.waiting() === 'dismiss' ? { state: 'on', words: 'the show is over: press to dismiss the crowd' }
          : { state: 'idle', words: 'nothing staged yet' }),
      fire: () => emperor.press('release') },
    { id: 'thumbs-up', label: 'Thumbs up', group: 'The crowd',
      read: () => (!args.crowdBody ? { state: 'unavailable', words: 'no crowd (add --crowd)' } : held() === 'up' ? { state: 'on', words: 'green banners are up' } : { state: 'off', words: 'press to raise green' }),
      fire: verdict('up') },
    { id: 'thumbs-down', label: 'Thumbs down', group: 'The crowd',
      read: () => (!args.crowdBody ? { state: 'unavailable', words: 'no crowd (add --crowd)' } : held() === 'down' ? { state: 'on', words: 'red banners are up' } : { state: 'off', words: 'press to raise red' }),
      fire: verdict('down') },
    { id: 'lower', label: 'Lower banners', group: 'The crowd',
      read: () => (!args.crowdBody ? { state: 'unavailable', words: 'no crowd (add --crowd)' } : held() ? { state: 'on', words: `${held() === 'up' ? 'green' : 'red'} is up: press to lower` } : { state: 'idle', words: 'hands are empty' }),
      fire: async () => { await npcModule().crowdHolds(rcon, null); return 'banners lowered'; } },
    { id: 'tnt', label: 'Drop the TNT', group: 'The ceiling', confirm: true,
      read: () => (tntDropped ? { state: 'on', words: `${tntDropped} dropped: the set needs placing again after this show` } : { state: 'off', words: `${args.tnt || TNT_DEFAULT} lit TNT from the awning (press twice)` }),
      fire: async () => { const r = await crowdShow.dropTnt(rcon, args.arenaSet.stand, args.tnt || TNT_DEFAULT); tntDropped += r.summoned; return `${r.summoned} summoned, ${r.read == null ? 'some' : r.read} falling`; } },
    { id: 'record-start', label: 'Start recording', group: 'Recording',
      read: () => recReady() || (recording ? { state: 'on', words: 'recording' } : { state: 'off', words: 'not recording' }),
      fire: async () => { const r = await recorderCall('roll'); recording = recording || r.said.endsWith('true'); return r.said.endsWith('true') ? 'rolling: every camera writing' : 'OBS did not confirm every camera writing'; } },
    { id: 'record-stop', label: 'Stop recording', group: 'Recording', confirm: true,
      read: () => recReady() || (recording ? { state: 'on', words: 'press twice to cut and save the take' } : { state: 'idle', words: 'not recording' }),
      fire: async () => { const r = await recorderCall('cut'); recording = false; return r.said.endsWith('true') ? 'cut, and the take is saved' : 'stopped; the take was not saved, see the show terminal'; } },
  ];
}

// ── ARENA SET: the filming set (arena_set) instead of sited ground ──────────────────────────────────
// `--arena` fights in the colosseum arena_set placed on this world: the body on the centre stand, the wave in the four
// gate pens, one cell from each pen in turn. The set's design is the one source of where those are (Law 16). The set
// is read back before it is trusted: a rollback puts back a world without it, and the book would still name it.
const ARENA_STAGE_SEC = 6;
// Mobs that burn under open sky by day. The set's oculus is open sky over the centre of the sand.
const SUN_BURNS = new Set(['zombie', 'skeleton', 'stray', 'drowned', 'zombie_villager', 'phantom', 'bogged']);
async function openSet(rcon, args) {
  const set = require('./arena_set');
  const center = args.arena === true ? set.placed() : args.arena;
  if (!center) return { ok: false, why: 'no colosseum is placed on this world — place it with arena_set.js --place=<x>,<y>,<z>' };
  const d = set.design();
  const at = p => set.toWorld(center, p);
  const throne = [d.points.emperor[0], d.points.emperor[1] - 1, d.points.emperor[2]];
  for (const [p, block] of [[[0, 0, 0], 'sand'], [throne, 'quartz_stairs']]) {
    const w = at(p);
    if (!/passed/i.test((await rcon.command(`execute if block ${w.x} ${w.y} ${w.z} minecraft:${block}`)) || '')) return { ok: false, why: `the colosseum is not standing at ${fmt(center)} (read back ${fmt(w)}) — place it again with arena_set.js --place` };
  }
  // One cell from each pen in turn, so every wave comes from every side.
  // Each pen cell knows its gate (pens and gates are listed in the same order), so a trickle lets a mob out of its own gate.
  const pens = d.points.pens.map((pen, g) => pen.cells.map(p => ({ ...at(p), gate: g })));
  const mouths = d.points.gates.map(g => at(g.mouth));
  const cells = [];
  for (let i = 0; i < Math.max(...pens.map(p => p.length)); i++) for (const pen of pens) if (pen[i]) cells.push(pen[i]);
  const stand = at(d.points.center);
  // THE SET IS NOT GROUND TO BE CRATERED: mob griefing is off while the set is fought in, and handed back as it was
  // found when the run closes (colosseum's rule, the same reason).
  const griefingBefore = /true/.test((await rcon.command('gamerule mob_griefing')) || '') ? 'true' : 'false';
  await rcon.command('gamerule mob_griefing false');
  if (!/false/.test((await rcon.command('gamerule mob_griefing')) || '')) return { ok: false, why: 'the server would not turn mob griefing off, and a creeper blast would crater the set' };
  for (const c of cells) c.distance = Math.round(Math.hypot(c.x - stand.x, c.z - stand.z) * 100) / 100;
  return {
    ok: true, center, stand, mouths, set,
    spectators: d.points.spectators.map(at),
    guards: d.points.guards.map(at),
    throne: at(d.points.emperor),
    sited: { cells, botCell: stand, band: 0, refused: 0, pool: cells.length, originDistance: 0, anchorsTried: 0, arenaSite: { tags: ['colosseum'], notes: `the filming set centred on ${fmt(center)}` } },
    gates: open => set.setGates(rcon, center, open),
    restore: () => rcon.command(`gamerule mob_griefing ${griefingBefore}`),
  };
}

// EVERY REFUSAL BELOW CARRIES A `cause` (Law 25):
//   terrain  the ground could not host it.
//   bot      the body was not fit to fight.
//   bench    the server or the summon itself refused.
async function runWave(scout, rcon, args, n) {
  const wave = args.wave;
  const want = wave.reduce((s, g) => s + g.count, 0);

  // Find the arena, THEN move the body into it.
  const origin = await sweepOrigin(scout, rcon, args, `wave ${n}`);
  if (!origin.ok) return { run: false, reason: origin.reason, cause: origin.cause };

  // `--same-ground`: every round of this run is fought on the first round's arena, so the search is paid once.
  const sited = args.arenaSet ? args.arenaSet.sited
    : (args.sameGround && args.sitedGround)
    || await siteArena(scout, origin.cell, want + (args.follow || []).reduce((s, g) => s + g.count, 0), args.range, args.lift, !!args.opposed);
  if (args.sameGround && sited.cells.length) args.sitedGround = sited;
  if (!sited.cells.length) return { run: false, reason: sited.detail, cause: 'terrain', band: sited.band, refused: sited.refused };

  // Every gate standBot owns runs at the cell the fight is on. `at` is overridden: the sweep's answer is
  // what the body is placed on (Law 16).
  const stand = await standBot(scout, rcon, { ...args, at: sited.botCell }, `wave ${n}`);
  if (!stand.ok) return { run: false, reason: stand.reason, cause: stand.cause || 'bench' };
  const { cell, biome, ambient } = stand;

  // The moat goes in after the body stands and before any mob exists, so no summon lands in the trench.
  if (args.moat > 0) {
    const moat = await carveMoat(rcon, cell, args.moat, sited.cells[0], args.pillar, args.bare, args.flood || null);
    if (!moat.ok) return { run: false, cause: 'bench', reason: `the moat did not take — floor still solid at ${moat.solid.join(' ')}`, biome };
    log('round', `  moat carved ${moat.ring[0]}–${moat.ring[1]} cells round ${fmt(cell)}, ${moat.depth} deep — the opponent is in sight and no walk reaches it` +
      (args.flood === 'level' ? '; flooded to the floor, so the body reaches it by swimming and climbing straight out'
        : args.flood ? '; flooded one under the floor, so the body reaches it only by swimming and setting a block to climb out' : '') +
      (moat.column ? `; cover column at (${moat.column.x},${cell.y}..${cell.y + 2},${moat.column.z})` : ''));
  }

  if (args.swim) {
    const pool = await sinkSwim(rcon, cell, args.swim, args.swimRadius);
    if (!pool.ok) return { run: false, cause: 'bench', reason: `the swim pool did not take at ${fmt(cell)}`, biome };
    log('round', `  swim pool under the body, ${pool.radius * 2 + 1} wide, ${pool.depth} deep, surface at y ${pool.top}` +
      (args.swim === 'under' ? ' — the banks stand one block over it' : ' — level with the banks'));
  }

  if (args.pool) {
    for (const c of sited.cells) await rcon.command(`fill ${c.x - 2} ${c.y - 3} ${c.z - 2} ${c.x + 2} ${c.y - 1} ${c.z + 2} minecraft:water`);
    log('round', `  pool sunk under ${sited.cells.length} mob cell(s), 5 wide and 3 deep`);
  }

  // EVERY ROUND OPENS ON THE SAME BODY: the kit is laid again (a round spends blocks and arrows hit) and the body is
  // healed to full, both read back, so no round inherits the last one's wounds or pocket.
  if (args.kit) {
    const k = await kitBot(rcon, args.bot, args.kit);
    if (!k.ok) return { run: false, cause: 'bench', biome, reason: `${args.bot} is missing ${k.missing.join(', ')} after the re-kit` };
  }
  const healed = await healBot(rcon, args.bot);
  if (!healed.ok) return { run: false, cause: 'bench', biome, reason: `the body would not heal to full (hp ${healed.health}) — the round would open wounded` };
  if (Number.isFinite(args.hp) && args.hp < 20) {
    const hurt = await woundBot(rcon, args.bot, args.hp);
    if (!hurt.ok) return { run: false, cause: 'bench', biome, reason: `the body would not take the wound to ${args.hp} hp (hp ${hurt.health})` };
  }

  for (const [i, name] of (args.buddies || []).entries()) {
    const b = await placeBuddy(rcon, args, name, cell, i + 1);
    if (!b.ok) return { run: false, cause: b.cause, biome, reason: b.reason };
  }

  // THE CONTROL, LAST THING BEFORE THE SUMMON: every hostile the world holds is removed (the teleport and the scout
  // have loaded new chunks, and their mobs with them), then the fight's surroundings are counted empty.
  await purgeAmbientHostiles(rcon, null);
  const wildBefore = await countWildHostiles(rcon, cell);
  if (wildBefore.total) {
    return { run: false, cause: 'bench', biome,
      reason: `the control is polluted — ${wildBefore.named.join(', ')} still within ${WILD_CHECK_RADIUS}b of ${fmt(cell)} after the purge (nothing was summoned)` };
  }

  // ARENA SET: the gates are shut before anything is summoned, so the wave is staged behind the bars.
  if (args.arenaSet) await args.arenaSet.gates(false);

  // The sited cells are spent IN ORDER across the groups, spread across the same bearings a single-species
  // wave would use.
  const placed = [];
  const unarmed = [];
  const stacked = new Map();   // cell key → how many mobs have already been summoned onto it
  const anger = args.provoke ? await angerNbt(rcon, args.bot) : '';
  let next = 0;
  for (const g of wave) {
    // ── ONLY CELLS THE BOT CAN ACTUALLY SEE THIS MOB FROM ───────────────────────────────────────────
    // Filtered per species: `engageRangeFor` is architect_config's one route (Law 16). The filter measures
    // the same shape the gate does: the real 3-D drop from the cell the body stands on, not the flat x/z
    // distance, as a cylinder matching the gate's own shape (Law 16 — one measure of range).
    const dropTo = (c) => ((cell && typeof cell.y === 'number' && typeof c.y === 'number') ? (c.y - cell.y) : 0);
    const flatTo = (c) => (typeof c.distance === 'number' ? c.distance : Infinity);
    const gapTo = (c) => (Number.isFinite(flatTo(c)) ? Math.hypot(flatTo(c), dropTo(c)) : Infinity);
    const radius = engageRangeFor(g.mob) - AGGRO_SITE_MARGIN;
    const inRange = sited.cells.filter(c =>
      flatTo(c) <= radius && Math.abs(dropTo(c)) <= AGGRO_VERTICAL_RANGE - AGGRO_SITE_MARGIN);
    // No cell inside the radius is a TERRAIN answer (Law 25) — falls through to the full list and lets
    // the presence gate refuse the round by name.
    const byGap = (a, b) => gapTo(a) - gapTo(b);
    // In the set the pens are already in order, one cell from each gate in turn, so a wave comes from every side.
    const pool = args.arenaSet ? (inRange.length ? inRange : sited.cells.slice()) : (inRange.length ? inRange : sited.cells.slice()).sort(byGap);
    for (let i = 0; i < g.count; i++) {
      const c = pool[next++ % pool.length];
      const key = `${c.x},${c.y},${c.z}`;
      const already = stacked.get(key) || 0;
      // Lets the first mob WALK OFF the cell before the second arrives.
      if (already > 0) await sleep(STACKED_SUMMON_GAP_MS);
      stacked.set(key, already + 1);
      // ARENA SET: a staged mob is held still (NoAI) behind the bars. Left awake, it sees the body, fails to path through the
      // bars, and is still waiting out its failed path when the gates open, standing where it was summoned.
      const r = await summonAt(rcon, g.mob, c, g.hand, anger + (args.arenaSet ? ',NoAI:1b' : ''));
      // The 3-D gap, matching the presence gate's own measure.
      if (r.ok) placed.push({ mob: g.mob, cell: c, distance: round2(gapTo(c)), armed: r.armed });
      // A mob asked to carry something and not carrying it is a DIFFERENT OPPONENT (Law 25).
      if (r.ok && g.hand && r.armed === false) unarmed.push(`${g.mob}: ${r.held || '(nothing)'}`);
    }
  }
  if (unarmed.length) {
    await clearArena(rcon);
    return { run: false, cause: 'bench', reason: `${unarmed.length} mob(s) summoned UNARMED — server says: ${unarmed.join(' | ')}`, biome };
  }
  if (!placed.length) {
    return { run: false, cause: 'bench', reason: 'every summon was refused by the server', biome };
  }

  log('round', `${n}: ${waveLabel(wave)} in ${biome || 'an unread biome'} — ` +
    placed.map(p => `${p.distance}b ${fmt(p.cell)}`).join(', '));
  log('round', `  band ${sited.band} box(es), ${sited.refused} refused by the reach gate, ${sited.pool} usable` +
    // Asked-vs-got, always both (Law 25).
    (sited.rangeAsked ? ` — asked ${sited.rangeAsked}b, got ${sited.rangeGot}b${Math.abs(sited.rangeGot - sited.rangeAsked) > 1.5 ? ' ⚠ THE TERRAIN DID NOT HAVE THE RANGE' : ''}` : ''));
  // `arenaSite` is arena_sites.describeSite's object ({tags, relief, notes}), rendered in full for the log.
  const siteLabel = sited.arenaSite && sited.arenaSite.tags && sited.arenaSite.tags.length
    ? `${sited.arenaSite.tags.join('/')} — ${sited.arenaSite.notes}`
    : (sited.arenaSite && sited.arenaSite.notes) || 'unlabelled ground';
  log('round', `  arena ${fmt(sited.botCell)} on ${siteLabel} — ` +
    `${sited.originDistance}b from the sweep origin ${fmt(origin.cell)}, ${sited.anchorsTried == null ? 'an unrecorded number of' : sited.anchorsTried} anchor(s) tried`);
  // The lift is a control: a fallback is a different experiment, and it says which.
  if (sited.liftAsked) {
    log('round', sited.liftFellBack
      ? `  ⚠ LIFT FELL BACK — no confirmed box stood ≥${sited.liftAsked}b above the bot, so this wave is FLAT (mob ${sited.liftGot >= 0 ? '+' : ''}${sited.liftGot}b). The sprint-jump is not under test here.`
      : `  lift asked ≥${sited.liftAsked}b, got +${sited.liftGot}b — ${sited.liftPool} of ${sited.pool} confirmed box(es) stood high enough. The approach has to climb.`);
  }

  // PRESENCE, CHECKED AFTER THE SUMMON AND BEFORE THE CLOCK: is the bot close enough for a fight to be
  // possible at all. A round failing this is NOT RUN, not a timeout. Per species: `engageRangeFor`,
  // architect_config's one route (Law 16), measured as a cylinder matching the gate's own shape.
  const atSummon = await readBotVitals(rcon, args.bot);
  const gapTo = p => Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.y - atSummon.position.y, p.cell.z + 0.5 - atSummon.position.z);
  const seenBy = (p) => Math.abs(p.cell.y - atSummon.position.y) <= AGGRO_VERTICAL_RANGE &&
    Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.z + 0.5 - atSummon.position.z) <= engageRangeFor(p.mob);
  const unseen = atSummon.known && atSummon.position
    ? placed.map(p => ({ p, gap: gapTo(p), radius: engageRangeFor(p.mob), seen: seenBy(p) })).filter(x => !x.seen)
    : placed.map(p => ({ p, gap: Infinity, radius: engageRangeFor(p.mob), seen: false }));
  // ANY mob out of its own radius fails the round, not just the nearest one (Law 25).
  if (unseen.length) {
    await clearArena(rcon);
    const named = unseen.map(x => `${x.p.mob} ${x.gap === Infinity ? 'unreadable' : `${x.gap.toFixed(1)}b`} (honoured to ${x.radius}b)`).join(', ');
    return { run: false, cause: 'terrain', reason: `${unseen.length} of ${placed.length} mob(s) outside the radius the bot honours for them: ${named} — it would measure a fight the bot cannot see`, biome };
  }


  // ARENA SET: the wave stands staged behind the bars for --stage seconds (the narration's beat), then every gate opens
  // at once and the clock starts. The body is in range of every pen throughout, so what it does while the bars hold is
  // its own response to mobs it can see and not reach.
  let trickle = null;
  if (args.arenaSet) {
    // `--emperor`: the wave stands staged until the emperor presses the release button; otherwise for --stage seconds.
    if (args.emperorConsole) {
      log('round', '  staged behind the gates, waiting for the emperor to release it');
      if (!await args.emperorConsole.awaitRelease()) {
        await clearArena(rcon);
        return { run: false, cause: 'bench', reason: 'the emperor never pressed release; the staged wave was cleared', biome };
      }
      if (args.crowdBody) await npcModule().crowdHolds(rcon, null);
      await rcon.command('title @a times 5 40 10');
      await rcon.command(`title @a subtitle {"text":"${waveLabel(wave)}${args.trickleEvery ? `, one every ${args.trickleEvery}s` : ''}","color":"white"}`);
      await rcon.command(`title @a title {"text":"ROUND ${n}","color":"gold"}`);
    } else {
      const stage = Number.isFinite(args.stage) ? args.stage : ARENA_STAGE_SEC;
      log('round', `  staged behind the gates for ${stage}s`);
      await sleep(stage * 1000);
    }
    if (args.trickleEvery) {
      // THE TRICKLE: the gates stay shut; the staged mobs are let out one at a time, `every` seconds apart, each through
      // its own gate onto the sand at the gate's mouth and woken there. The cells were filled one per pen in turn, so
      // the mobs come from the gates in turn. It stops the moment the fight ends.
      trickle = { stop: false, out: 0 };
      trickle.done = (async () => {
        for (const p of placed) {
          if (trickle.stop) break;
          const m = args.arenaSet.mouths[p.cell.gate];
          const sel = `@e[tag=${ARENA_TAG},type=${p.mob},x=${p.cell.x + 0.5},y=${p.cell.y},z=${p.cell.z + 0.5},distance=..1,limit=1,sort=nearest]`;
          await rcon.command(`execute as ${sel} run tp @s ${m.x + 0.5} ${m.y} ${m.z + 0.5}`);
          await rcon.command(`execute as @e[tag=${ARENA_TAG},type=${p.mob},x=${m.x + 0.5},y=${m.y},z=${m.z + 0.5},distance=..1,limit=1,sort=nearest] run data merge entity @s {NoAI:0b}`);
          await rcon.command(`playsound minecraft:block.iron_door.open block @a ${m.x} ${m.y} ${m.z} 2 0.6`);
          await rcon.command(`particle minecraft:poof ${m.x + 0.5} ${m.y + 0.5} ${m.z + 0.5} 0.5 0.5 0.5 0.02 15`);
          trickle.out++;
          await sleep(args.trickleEvery * 1000);
        }
      })();
      log('round', `  trickle: ${placed.length} let out one every ${args.trickleEvery}s through the gates in turn`);
    } else {
      await args.arenaSet.gates(true);
      await rcon.command(`execute as @e[tag=${ARENA_TAG}] run data merge entity @s {NoAI:0b}`);
      log('round', '  gates open');
    }
  }

  // The carry the wave opens on, read last before the clock (--loot, readSpoils).
  const carryBefore = args.loot ? await readCarry(rcon, args.bot) : null;
  const waveAt = Date.now();
  if (args.strikerBody) args.strikerBody.begin();
  // ── FOLLOW: A SECOND WAVE INTO THE SAME FIGHT ── `--follow=<wave>` is summoned `--follow-after` seconds into the round,
  // with no heal and no re-kit between: the body meets it wounded and carrying what the first wave left on it (a witch's
  // poison). Its cells are the sited ones, each within its own mob's radius of where the body stands when it arrives.
  const follow = args.follow ? (async () => {
    await sleep((Number.isFinite(args.followAfter) ? args.followAfter : 5) * 1000);
    const at = await readBotVitals(rcon, args.bot);
    if (!at.known || !at.position) { log('round', '  ⚠ FOLLOW NOT SUMMONED — the body could not be read'); return []; }
    const out = [];
    let k = 0;
    for (const g of args.follow) {
      const all = sited.cells
        .map((c) => ({ c, d: Math.hypot(c.x + 0.5 - at.position.x, c.z + 0.5 - at.position.z), dy: Math.abs(c.y - at.position.y) }))
        .sort((a, b) => a.d - b.d);
      // In the mob's own radius and not on top of the body; the body may have walked off the sited band chasing the
      // first wave, so with none left the sited cells are used as they stand.
      const fit = all.filter((x) => x.d >= 5 && x.d <= engageRangeFor(g.mob) - AGGRO_SITE_MARGIN && x.dy <= AGGRO_VERTICAL_RANGE - AGGRO_SITE_MARGIN);
      const apart = all.filter((x) => x.d >= 3);
      const near = fit.length ? fit : apart.length ? apart : all;
      for (let i = 0; i < g.count; i++) {
        const pickCell = near.length ? near[k++ % near.length] : null;
        if (!pickCell) { out.push(`${g.mob}: no cell in range`); continue; }
        const r = await summonAt(rcon, g.mob, pickCell.c, g.hand, anger);
        out.push(r.ok ? `${g.mob} ${round2(pickCell.d)}b${g.hand && r.armed === false ? ' UNARMED' : ''}` : `${g.mob}: refused`);
      }
    }
    log('round', `  follow at +${round2((Date.now() - waveAt) / 1000)}s, bot hp ${at.health}: ${out.join(', ')}`);
    return out;
  })() : null;
  // A trickle's fight lasts at least as long as the letting-out, so its ceiling is stretched by that time.
  const ceilingMs = (args.ceilingSeconds + (trickle ? placed.length * args.trickleEvery : 0)) * 1000;
  const outcome = await observeFight(rcon, args.bot, ceilingMs,
    (args.stallSeconds || 0) * 1000, args.buddies || [], !!args.strikerBody);
  if (follow) outcome.followed = await follow;
  if (trickle) { trickle.stop = true; await trickle.done; outcome.trickledOut = trickle.out; }
  // Whether the wave held a mob that blows up: only then can health lost after the field cleared be read as a blast.
  outcome.blastCapable = (wave || []).concat(args.follow || []).some((g) => BLAST_MOBS.has(g.mob));
  // The striker's side: its swings and the server's blast packet it received, beside the server's reads (Law 26).
  if (args.strikerBody) {
    outcome.striker = args.strikerBody.finish();
    outcome.reportedDetonated = outcome.striker.explosions.length
      ? outcome.striker.mobs.filter((m) => m.name === 'creeper').map((m) => `creeper#${m.id}`) : [];
  }
  // `--hold=<sec>`: the field stands that much longer after the wave resolves, so what the bot does with a mob it
  // left standing (a mob no route reaches, shooting on) is seen; every wave it reports in that time is listed.
  let heldWaves = null;
  if (args.hold > 0 && !outcome.botDied && !outcome.fieldCleared) {
    await sleep(args.hold * 1000);
    heldWaves = combatLens.completedBattlesSince(waveAt, { bot: args.bot })
      .map(b => ({ outcome: b.outcome, rel: round2((b.at - waveAt) / 1000) }));
    const v = await readBotVitals(rcon, args.bot);
    outcome.hpAfterHold = v.known ? v.health : null;
  }
  if (args.after > 0 && !outcome.botDied) {
    outcome.afterWatch = await watchAfter(rcon, args.bot, args.after, outcome.deaths || 0);
  }
  // `--loot`: once the watch stands again (the spoils sweep is inside the wave), what the body carries that it did not
  // carry when the wave opened, and the drops still lying near it (readSpoils).
  if (args.loot && carryBefore && !outcome.botDied && !args.strikerBody) {
    outcome.spoils = await readSpoils(rcon, args.bot, carryBefore);
  }
  // Read again at the end: a wild hostile there now may have been in the fight, so the round is not a clean result.
  const wildAfter = await countWildHostiles(rcon, cell);
  await clearArena(rcon);
  // Each body's own side of the fight, off its own trace, beside the server's numbers.
  const tallies = (args.buddies || []).length
    ? Object.fromEntries([args.bot, ...args.buddies].map((id) => [id, combatLens.fightTallySince(id, waveAt)]))
    : null;
  return {
    run: true, placed: placed.length, biome, cell, tallies,
    polluted: wildAfter.total ? wildAfter.named : null,
    wave: waveLabel(wave),
    ambientPurged: ambient,
    rangeAsked: sited.rangeAsked, rangeGot: sited.rangeGot,
    liftAsked: sited.liftAsked, liftGot: sited.liftGot, liftFellBack: sited.liftFellBack,
    // Read off the body at the moment the wave opened.
    standY: cell.y,
    heldWaves,
    ...outcome,
  };
}

// The headline states WHAT WAS MEASURED. A detonation is named for what it is, distinct from
// "field cleared BY THE BOT" (Law 25). One decider for how the wave ended, read by both the human
// sentence and the ledger's word (Law 16). The words are the ledger's vocabulary: `disengaged` and
// `unattributable` bucket under `timeout`.
// The mobs that blow up. Health lost after the field cleared is read as a blast only in a wave holding one: after a witch
// the body's poison goes on ticking once the witch is dead.
const BLAST_MOBS = new Set(['creeper']);
function waveVerdict(r) {
  if (r.botDied) return 'died';
  if (r.stalled) return 'stalled';
  if (!r.fieldCleared) return r.reportedBattle ? 'disengaged' : 'timeout';
  // The server's own announcement first, the health inference second (Law 23).
  if (r.reportedDetonated.length || (r.blastCapable && r.hpLostAfterClear > 0)) return 'blown';
  if ((r.reportedFused && r.reportedFused.length) || (r.striker && r.striker.mobs.some(m => m.everSwelled))) return 'fused';
  if (r.attributable) return 'cleared';
  return 'unattributable';
}

function headline(r) {
  // A RENDERER over `waveVerdict`, never a second decider.
  switch (waveVerdict(r)) {
    case 'died':
      return `💀 BOT DIED (${r.deaths}× this round)`;
    case 'stalled':
      return `🚫 STALL — no damage exchanged either way in ${Math.round(r.ms / 1000)}s. The wave was set up and never happened; this measures the BENCH, not the bot`;
    case 'disengaged':
      return `🚶 DISENGAGED — the bot reports the battle over with the field still standing` +
        `${r.reportedDisengaged.length ? ` (${r.reportedDisengaged.join(', ')} walked)` : ''}` +
        `${r.reportedKilled.length ? `, ${r.reportedKilled.join(', ')} killed` : ''}`;
    case 'timeout':
      return '⏱️  timed out';
    case 'blown':
      return r.reportedDetonated.length
        ? `💥 MOB DETONATED — the server announced the blast; the bot did not kill it ` +
          `(${r.reportedDetonated.join(', ')}${r.reportedKilled.length ? `, ${r.reportedKilled.join(', ')} killed` : ''})`
        : `💥 MOB DETONATED — the bot did not kill it (${r.mobDamageDealt} of its ${r.mobHpStart} hp taken off first)`;
    case 'fused':
      return `❌ FUSE DEATH — the fuse lit before the bot finished it (${(r.reportedFused || []).join(', ') || 'seen by the striker'})`;
    case 'cleared':
      return '✅ field cleared BY THE BOT';
    default:
      return '⚠️  field emptied — NOT the bot (no damage dealt)';
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────

// waitForScout: proves the scout SPAWNED, and nothing more. IT DOES NOT PROVE CHUNKS — that question
// belongs to `awaitScoutSees`.
async function waitForScout(scout, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (scout.isReady()) return true;
    await sleep(500);
  }
  return false;
}

// cleanupOnly — the one verb that must work when everything else is broken (Law 8). It needs no scout.
async function cleanupOnly() {
  let link;
  try { link = await rconLink.open(rconLink.readServerProperties()); }
  catch (e) {
    console.error(`Cannot reach the server over RCON (${e.code || e.message}). Nothing was cleaned up. ` +
      `Arena mobs are tagged '${ARENA_TAG}' and will still be there when it is back.`);
    return 1;
  }
  try { console.log((await link.command(`kill @e[tag=${ARENA_TAG}]`) || '').trim() || '(nothing tagged)'); }
  finally { link.close(); }
  return 0;
}

// openArena — connect the scout, open RCON, author the world, clear the field. One implementation
// (Law 16). Returns { ok:false, why }; never throws.
async function openArena({ quiet = false, time = null } = {}) {
  const asked = time ? { ...WORLD, time } : WORLD;
  const scout = createScout({
    // This seat's own server, as its file says: a copy on the second seat must not reach the main seat's world.
    host: '127.0.0.1', port: require('@utils/server_settings').serverPort(require('@utils/workstation').needServerDir()), version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, username: SCOUT_NAME,
    // The arena is sited on the fleet's own world: inside the spawn-protected square the body reads bedrock, so
    // no arena may stand there.
    fleetView: true,
    onReady: () => log('scout', 'connected'),
    onEnd: why => log('scout', `down — ${why}`),
    log: (lvl, m) => log('scout', m),
  });
  if (!scout.available) {
    return { ok: false, why: `mineflayer unavailable to the scout (${scout.reason}). Install the bot's packages, from Auren_Bot\\:\n`
      + '  .\\Auren_Workshop\\scripts\\npm.ps1 install' };
  }
  if (!await waitForScout(scout)) { scout.end(); return { ok: false, why: 'the scout never spawned — is the server up?' }; }

  let rcon;
  try { rcon = await rconLink.open(rconLink.readServerProperties(), () => { log('rcon', 'link lost: the server is gone, no round can run, stopping now'); process.exit(1); }); }
  catch (e) { scout.end(); return { ok: false, why: `cannot reach the server over RCON (${e.code || e.message})` }; }

  // Park the scout in spectator: cannot fall, die, or take a mob's attention.
  await rcon.command(`gamemode spectator ${SCOUT_NAME}`);
  const world = await applyWorld(rcon, asked);
  if (!/false/.test(world.spawning)) {
    rcon.close(); scout.end();
    return { ok: false, why: `the world would not stop spawning mobs (${world.spawning || 'no answer'}) — every round would be fought among wild ones` };
  }
  if (!quiet) {
    log('world', `${world.spawning} — no wild mob spawns while this runs; every hostile in a round is summoned here.`);
    log('world', `${world.time}, ${world.difficulty}, daylight cycle ${world.cycle} — ` +
      `asked for ${asked.time}/${asked.difficulty}.${asked.time === WORLD.time ? ' Skeletons and zombies do not burn here.' : ''}`);
    // Named as a FAULT when griefing is on.
    log('world', /set to: false/.test(world.griefing)
      ? `${world.griefing} — creeper blasts leave the terrain intact, so every rung is fought on the same ` +
        `ground. The bot still takes the full damage; only the terrain is spared.`
      : `⚠ ${world.griefing} — blasts will CRATER the ground the next wave is sited on, so this trial is ` +
        `not comparable to one run with it off. fleet_control sets this at bring-up; a server started ` +
        `another way did not get it.`);
  }
  await clearArena(rcon);
  // Global (no cell): nobody knows yet where the fight will be. runWave re-purges around the actual stand.
  const ambient = await purgeAmbientHostiles(rcon, null);
  if (!quiet && ambient) {
    log('purge', `${ambient} hostile(s) the world already owned were removed from the loaded chunks. ` +
      `spawn_mobs=false stops new ones; it does not touch these.`);
  }

  return {
    ok: true, scout, rcon, world,
    // Terminates with whoever raised it (Law 8); runs even on a failure path.
    async close() {
      try { await rcon.command(`kill @e[tag=${ARENA_TAG}]`); } catch (_) {}
      // The world is handed back spawning as it was found.
      const was = /true/.test(world.spawningBefore) ? 'true' : /false/.test(world.spawningBefore) ? 'false' : null;
      if (was) { try { await rcon.command(`gamerule spawn_mobs ${was}`); } catch (_) {} }
      rcon.close();
      scout.end();
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cleanup) return cleanupOnly();

  // BEFORE THE SERVER IS EVEN OPENED — arithmetic against the bot's own aggro table, nothing moved yet.
  const fit = rangeFitsAggro(args.wave, args.range);
  if (!fit.ok) { console.error(`Cannot run: ${fit.why}`); return 2; }

  // A day fight with a mob the sun burns ends for a reason that is not the fight (Law 25): the oculus is open sky.
  const burns = args.time && args.time !== WORLD.time && args.wave.concat(args.follow || []).filter(g => SUN_BURNS.has(g.mob));
  if (burns && burns.length) { console.error(`Cannot run: ${burns.map(g => g.mob).join(', ')} burn in daylight, and --time=${args.time} is not night. Fight them at the default time.`); return 2; }

  const arenaLink = await openArena({ time: args.time || null });
  if (!arenaLink.ok) { console.error(`Cannot run: ${arenaLink.why}`); return 1; }
  const { scout, rcon } = arenaLink;
  if ((args.show || args.emperor || args.crowd || args.guard || args.ruler) && !args.arena) { console.error('Cannot run: --show, --emperor, --board, --crowd, --guard and --ruler belong to the colosseum; add --arena'); await arenaLink.close(); return 2; }
  if ((args.crowd || args.guard || args.ruler) && !npcModule()) { console.error('Cannot run: --crowd, --guard and --ruler are the show’s people, which live outside the bot, and this machine names no npc module'); await arenaLink.close(); return 2; }
  if (args.arena) {
    const set = await openSet(rcon, args);
    if (!set.ok) { console.error(`Cannot run: ${set.why}`); await arenaLink.close(); return 2; }
    args.arenaSet = set;
    args.at = set.stand;
    if (args.show) {
      const show = crowdShow.showRounds(args.show, set.sited.cells.length);
      if (!show.ok) { console.error(`Cannot run: ${show.why}`); await set.restore(); await arenaLink.close(); return 2; }
      args.showRounds = show.rounds;
      args.rounds = show.rounds.length;
    }
    if (args.emperor) {
      const emperor = crowdShow.createEmperor(rcon, set.set, set.center);
      const ready = await emperor.check();
      if (!ready.ok) { console.error(`Cannot run: ${ready.why}`); await set.restore(); await arenaLink.close(); return 2; }
      args.emperorConsole = emperor;
      log('arena', `the emperor's controls stand at release ${fmt(emperor.controls.release)}, up ${fmt(emperor.controls.up)}, down ${fmt(emperor.controls.down)}`);
    }
    log('arena', `the colosseum centred on ${fmt(set.center)} — ${set.sited.cells.length} pen cell(s) behind four gates, ` +
      `${Math.min(...set.sited.cells.map(c => c.distance))}–${Math.max(...set.sited.cells.map(c => c.distance))}b from the stand; mob griefing off while it is fought in`);
  }

  let exitCode = 0;
  try {
    if (args.striker) {
      const raised = await raiseStriker(rcon, args);
      if (!raised.ok) { log('striker', `NOT RUN — ${raised.why}`); return 2; }
    }
    if (args.crowd > 0) {
      const raised = await npcModule().raiseCrowd(rcon, {
        host: '127.0.0.1', port: require('@utils/server_settings').serverPort(require('@utils/workstation').needServerDir()),
        version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, spots: args.arenaSet.spectators,
        face: args.arenaSet.stand, watch: args.bot, count: args.crowd, tag: npcModule().CROWD_TAG, sleep,
      });
      if (!raised.ok) { log('crowd', `NOT RUN — ${raised.why}`); return 2; }
      args.crowdBody = raised.puppets;
      log('crowd', `${raised.puppets.length} spectator(s) on the row (${raised.tagged == null ? 'tag count unread' : `${raised.tagged} tagged`}), each with its own habit: ` +
        raised.puppets.map(p => `${p.username} ${p.habit}`).join(', '));
    }
    if (args.guard) {
      const raised = await npcModule().raiseGuards(rcon, {
        host: '127.0.0.1', port: require('@utils/server_settings').serverPort(require('@utils/workstation').needServerDir()),
        version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, spots: args.arenaSet.guards,
        face: args.arenaSet.stand, watch: args.bot, sleep,
      });
      if (!raised.ok) { log('guard', `NOT RUN — ${raised.why}`); return 2; }
      args.guardBody = raised.puppets;
      log('guard', `${raised.puppets.map(p => p.username).join(' and ')} stand either side of the throne; ${raised.kitted}/${raised.puppets.length} read back in diamond`);
    }
    if (args.ruler) {
      const raised = await npcModule().raiseRuler(rcon, {
        host: '127.0.0.1', port: require('@utils/server_settings').serverPort(require('@utils/workstation').needServerDir()),
        version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, seat: args.arenaSet.throne,
        face: args.arenaSet.stand, watch: args.bot, sleep,
      });
      if (!raised.ok) { log('ruler', `NOT RUN — ${raised.why}`); return 2; }
      args.rulerBody = raised.puppets;
      log('ruler', `${raised.puppets[0].username} sits the throne; ${raised.kitted}/1 read back in gold`);
    }
    // The emperor's verdict levers are watched for the whole show; a lever thrown on puts its banner up.
    if (args.emperorConsole) {
      args.emperorConsole.startLevers(async (k) => {
        log('emperor', `thumbs ${k}, the emperor's verdict`);
        if (args.crowdBody) await npcModule().crowdHolds(rcon, k, args.crowdBody.map(p => p.username));
      });
    }
    if (args.board) {
      args.whenBoard = require('./when_board').createWhenBoard({
        title: `The colosseum — ${args.bot}${args.show ? `, show '${args.show}'` : ''}`,
        cues: showCues(rcon, args), port: args.board === true ? undefined : args.board, log,
      });
      if (!await args.whenBoard.ready) return 2;
    }
    if (args.kit) {
      const k = await kitBot(rcon, args.bot, args.kit);
      log('kit', k.ok
        ? `${args.bot} carries ${k.items.join(', ')} — inventory WIPED first, so nothing it earned is in this fight.`
        : `⚠ NOT RUN — ${args.bot} is missing ${k.missing.join(', ')} after the replace; the server says: ${k.inventory || '(empty)'}`);
      if (!k.ok) return 2;
    }

    // ── SPAWN → TELEPORT TO THE SPOT → SPAWN MONSTER, in that order and at the START ───────────────────
    // A failure here is exit 2 and NOT a round (Law 25).
    const opening = await standBot(scout, rcon, args, 'open');
    if (!opening.ok) { log('open', `NOT RUN — ${opening.reason}`); return 2; }
    log('open', `${args.bot} is standing at ${fmt(opening.cell)} in ${opening.biome || 'an unread biome'}, ` +
      `the scout can read the ground, and the field is clear. Monsters next.`);

    const rounds = [];
    for (let n = 1; n <= args.rounds; n++) {
      // `--show`: round n is the show's n-th round. `--escalate`: round n fights n× every group of the wave.
      const step = args.showRounds ? args.showRounds[n - 1] : null;
      const r = await runWave(scout, rcon, step ? { ...args, wave: parseWave(step.wave), trickleEvery: step.every || null }
        : args.escalate ? { ...args, wave: args.wave.map(g => ({ ...g, count: g.count * n })) } : args, n);
      // The round's own verdict goes up on the crowd's banners unless the emperor gives his: cleared → up, fallen → down.
      if (r.run && args.crowdBody) await npcModule().crowdHolds(rcon, r.botDied ? 'down' : 'up', args.crowdBody.map(p => p.username));
      rounds.push(r);
      if (!r.run) {
        log('round', `${n}: NOT RUN — ${r.reason}`);
        exitCode = 2;
        // A body unfit to fight stays unfit: the next round would spend its whole watch wait to hear the same refusal.
        if (r.cause === 'bot') { log('round', `stopping: ${args.rounds - n} round(s) left unrun.`); break; }
        continue;
      }
      log('round', `  → ${headline(r)} · bot hp ${r.hpStart}→${r.hpEnd} (low ${r.minHp}) · ` +
        `mobs ${r.mobsStart}→${r.mobsEnd}, ${r.mobDamageDealt} damage dealt · ${(r.ms / 1000).toFixed(1)}s` +
        // The bot's own word for how its wave ended, beside the server's numbers (Law 26).
        `${r.reportedBattle ? ` · the bot's wave outcome: ${r.reportedBattle.outcome}` : ''}` +
        `${r.polluted ? ` · ⚠ POLLUTED — wild ${r.polluted.join(', ')} within ${WILD_CHECK_RADIUS}b at the end` : ' · no wild hostile near it'}`);
      if (r.minAir !== null && r.minAir < 300) log('round', `  lowest air in the wave ${r.minAir}/300`);
      if (r.spoils) {
        const g = r.spoils.gained;
        log('round', `  spoils: ${r.spoils.stood ? 'watch stood again' : '⚠ the watch did not stand again within ' + SPOILS_WATCH_MS / 1000 + 's'} · ` +
          `picked up ${g == null ? 'UNREAD' : Object.keys(g).length ? Object.entries(g).map(([k, n]) => `${k}×${n}`).join(', ') : 'nothing'} · ` +
          `${r.spoils.loose == null ? 'loose drops UNREAD' : `${r.spoils.loose} drop(s) still on the ground within ${SPOILS_RADIUS}b`}`);
      }
      if (r.striker) {
        const st = r.striker;
        log('round', `  striker: ${st.swings.length} swing(s) with ${args.strikerBody.held()} (${args.strikerBody.cooldownMs()}ms recharge)` +
          ` · ${st.explosions.length} explosion packet(s)`);
        for (const m of st.mobs) {
          log('round', `  ${m.name}#${m.id}: closest ${m.closest}b centre to centre, ${m.closestReach}b eye to box · ` +
            (m.everSwelled ? `❌ FUSE LIT at ${(m.firstSwellAt / 1000).toFixed(2)}s after ${m.litAfterSwings} clean hit(s), swelling for ${m.swellTicks} tick(s)` : '✅ fuse never lit') +
            ` · position updates every ${m.gapMs}ms`);
        }
        log('round', `  swings (time@reach judged/seen, * after the fuse lit): ${st.swings.map((w) => `${(w.at / 1000).toFixed(2)}s@${w.reach}/${w.seen}b${w.lit ? '*' : ''}`).join(' ')}`);
      }
      if (r.afterWatch) {
        const w = r.afterWatch;
        log('round', `  after the wave, ${w.seconds}s watched: ${w.died ? '💀 DIED' : 'alive'} · lowest air ${w.minAir}/300 · lowest hp ${w.minHp}` +
          (w.endAt ? ` · ended at (${w.endAt.x.toFixed(1)}, ${w.endAt.y.toFixed(1)}, ${w.endAt.z.toFixed(1)})` : ''));
      }
      for (const b of r.buddies || []) log('round', `  ${b.name} hp ${b.hpStart}→${b.hpEnd} (low ${b.minHp}), ${b.deaths} death(s)`);
      if (r.tallies) for (const [who, t] of Object.entries(r.tallies)) log('round', `  ${who}: ${JSON.stringify(t)}`);
      if (r.heldWaves) {
        log('round', `  held ${args.hold}s more with the field standing: ${r.heldWaves.length} wave(s) reported — ` +
          `${r.heldWaves.map(w => `${w.outcome}@${w.rel}s`).join(', ') || 'none'} · bot hp at the end ${r.hpAfterHold}`);
      }
      // `--escalate` is one life: the round the body falls is the last.
      if ((args.escalate || args.showRounds) && r.botDied) { log('round', `the body fell in round ${n}; ${args.rounds - n} round(s) left unrun.`); break; }
      if (n < args.rounds) await sleep(2000);
    }
    // THE CROWD HOLDS ITS LAST VERDICT until the emperor dismisses it with one more press of the release button, so the
    // closing shot (the fall and the banners) is there for as long as he needs it.
    if (args.crowdBody && args.emperorConsole) {
      log('emperor', 'the show is over; the crowd holds its verdict until the emperor presses release to dismiss it');
      await sleep(1500);   // the last press must have sprung back before the next one counts
      if (!await args.emperorConsole.awaitRelease('dismiss')) log('emperor', 'the emperor never dismissed the crowd; it leaves now');
    }
    if (args.escalate || args.showRounds) {
      const won = rounds.filter(r => r.run && waveVerdict(r) === 'cleared');
      const kills = rounds.filter(r => r.run).reduce((s, r) => s + Math.max(0, (r.mobsStart || 0) - (r.mobsEnd || 0)), 0);
      log('verdict', `escalation: ${won.length} round(s) cleared · ${kills} opponent(s) gone, killed or detonated · ` +
        `${rounds.some(r => r.botDied) ? `fell in round ${rounds.findIndex(r => r.botDied) + 1}` : 'standing at the end'}`);
    }

    const ran = rounds.filter(r => r.run);
    log('verdict', `${ran.length}/${args.rounds} round(s) run vs ${waveLabel(args.wave)} — ` +
      `${ran.filter(r => waveVerdict(r) === 'cleared').length} cleared · ${ran.filter(r => waveVerdict(r) === 'blown').length} detonated · ` +
      `${ran.filter(r => waveVerdict(r) === 'fused').length} fuse death(s) · ` +
      `${ran.filter(r => r.botDied).length} death(s) · ` +
      `${ran.some(r => r.afterWatch) ? `${ran.filter(r => r.afterWatch && r.afterWatch.died).length} death(s) after the wave · ` : ''}` +
      `${ran.filter(r => r.run && !r.fieldCleared && !r.botDied).length} timed out` +
      `${ran.some(r => r.polluted) ? ` · ${ran.filter(r => r.polluted).length} POLLUTED by wild hostiles` : ''}`);
    // A striker's test: the creeper killed with its fuse never lit. A lit fuse fails the fight whatever follows.
    if (args.striker) {
      const unlit = ran.filter(r => waveVerdict(r) === 'cleared' && r.striker && r.striker.mobs.every(m => !m.everSwelled));
      log('verdict', `striker: ${unlit.length}/${ran.length} killed with the fuse never lit · ` +
        `${ran.filter(r => r.striker && r.striker.mobs.some(m => m.everSwelled)).length} fuse(s) lit`);
    }
    // The bench says WHAT happened; the journal says why (Law 16).
    log('done', `Why it went that way: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=${args.bot}`);
    return exitCode;
  } catch (e) {
    console.error(`lanista failed: ${e.stack || e.message}`);
    return 1;
  } finally {
    if (args.whenBoard) args.whenBoard.close();
    if (args.obsWatch) clearInterval(args.obsWatch);
    if (args.strikerBody) args.strikerBody.end();
    if (args.emperorConsole) args.emperorConsole.stop();
    if (args.crowdBody) args.crowdBody.forEach(p => p.end());
    if (args.guardBody) args.guardBody.forEach(p => p.end());
    if (args.rulerBody) args.rulerBody.forEach(p => p.end());
    if (args.arenaSet) await args.arenaSet.restore();
    await arenaLink.close();
  }
}

// raiseStriker — lanista's own body for `--striker`: joins under --bot's name, is set to survival.
async function raiseStriker(rcon, args) {
  const { createStriker } = require('./lanista_striker');
  const body = createStriker({
    host: '127.0.0.1', port: require('@utils/server_settings').serverPort(require('@utils/workstation').needServerDir()),
    version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, username: args.bot,
    mobs: [...new Set(args.wave.map((g) => g.mob))], leadMs: Number.isFinite(args.lead) ? args.lead : null,
  });
  const until = Date.now() + 30000;
  while (!body.isReady()) {
    if (Date.now() > until) { body.end(); return { ok: false, why: `the striker '${args.bot}' never spawned` }; }
    await sleep(250);
  }
  const mode = (await rcon.command(`gamemode survival ${args.bot}`) || '').trim();
  args.strikerBody = body;
  log('striker', `${args.bot} joined as lanista's own body — ${mode || 'survival asked'}. It never moves; it swings at a ` +
    `${args.wave.map((g) => g.mob).join('/')} in reach once the held weapon is fully recharged.`);
  return { ok: true };
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  ARENA_TAG, DEATH_OBJECTIVE, REACH_MAX_NODES, SITING, WORLD,
  parseArgs, parseWave, parseCell, waveLabel, headline, waveVerdict,
  siteMobCells, siteArena, summonAt, equipmentNbt, reachabilityFor,
  readBotVitals, readDeaths, readArenaMobs, readBiome,
  placeBot, kitBot, healBot, clearArena, applyWorld, waitForScout,
  openArena, cleanupOnly, runWave, carveMoat, sinkSwim, watchAfter, readAir,
  // The opening sequence and the gate in front of it, both testable without a server.
  standBot, rangeFitsAggro, SITE_BAND_SLACK,
  // The parallel bench (colosseum) stages several arenas with these.
  awaitScoutSees, awaitStandingWatch, purgeAmbientHostiles, ensureDeathCounter,
};
