// arena_set — the Roman colosseum the filmed fights are staged in: one design, read by the Studio draft, the placement
// and lanista's arena mode alike (Law 16: one set of blocks, three readers).
//
// A SET, NOT A BUILD. No crew builds it and the fleet never reads it; it is placed whole over the server console. It
// exists for the camera, so its proportions answer to two rules and nothing else:
//   · every gate pen sits inside a creeper's aggro range of the centre stand (architect_config.aggroRangeFor), so a
//     mob summoned behind a gate is already in the fight's radius the moment the gate opens (lanista's presence gate
//     refuses a round otherwise);
//   · the roof is a velarium high enough for a moving camera, closed overhead, with the arcades open beneath it for
//     daylight. No sky column reaches the sand: an undead mob burns by day wherever the full sky light falls on it.
//
// SET COORDINATES: x east, z south, y up. (0,0,0) is the sand cell under the centre stand, so the fighter's feet stand
// at (0,1,0). `r(x,z)` is the ellipse radius in x-units: the arena is a slight oval, long on x, like the original.
//
// Usage (developer door open, the copy's seat server up):
//   node arena_set.js --place=<x>,<y>,<z>     # place the whole set; <x,y,z> is the world cell of the centre sand block
//   node arena_set.js --place=<x>,~,<z>       # the same, the sand replacing the top of the ground at <x,z>
//   node arena_set.js --gates=open|closed      # the four gates' iron bars, at the placed set (or --at=<x>,<y>,<z>)
//   node arena_set.js --show                   # the placed set's named points in world coordinates
//   node arena_set.js --cameras                # the set's fixed cameras put at their shots for the placed set
//   node arena_set.js --save-cameras=4,5       # Cam_4 and Cam_5 as they stand now, kept as shots of the set
// The placed centre is kept in ARENA_BOOK, keyed by the world's name, so lanista --arena finds it without coordinates.
//
// THE SET'S CAMERAS ARE PART OF THE SET, so no shot is tied to one seed's ground. ARENA_CAMERAS keeps each fixed camera as an offset from the centre sand block
// and a facing, so the shots travel with the set to any seed, seat or server. Placing the set, `--cameras` and lanista
// --arena write them into this machine's saved angles (camera_spots) at the placed centre, and move a camera already
// standing there. Frame a shot by hand once (fly the seat), then `--save-cameras=<n>` keeps it as the set's.
// Exit codes: 0 done · 1 could not run.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/arena_set.js');

const fs = require('fs');
const path = require('path');

// ── THE PROPORTIONS ─────────────────────────────────────────────────────────────────────────────────
const OVAL = 9.5 / 8.5;          // x-radius over z-radius: the slight oval
const FLOOR_R = 9.5;             // sand
const FENCE_R = 10.5;            // the podium's inner band: gate bars below, the spectators' fence on top
const PODIUM_R = 12.5;           // the podium's outer edge; its top is the spectators' walkway
const PODIUM_TOP = 4;            // the podium is 4 high, so the walkway's feet stand at y 5
const PEN_R = 13.5;              // a gate's passage runs from FENCE_R to here: the pen
const CAVEA_R = 20;              // stepped seating, rising one block per block outward
const WALL_R = 21.5;             // the outer arcade wall
const WALL_TOP = 25;             // attic top
const VELARIUM_Y = 26;           // the awning
const MEDALLION_R = 1.5;         // the awning's gold centre, where the stripes meet
const GATE_HALF = 1;             // a gate passage is 3 wide
const GATE_H = 3;                // and 3 high (y 1..3)
const BAY = 5;                   // the arcade's bay, measured along the wall

// The four gates, on the axes. The emperor's box sits over the north gate.
const GATES = [
  { name: 'north', axis: 'z', sign: -1 },
  { name: 'south', axis: 'z', sign: 1 },
  { name: 'west', axis: 'x', sign: -1 },
  { name: 'east', axis: 'x', sign: 1 },
];

const r = (x, z) => Math.hypot(x, z * OVAL);
const outward = (x, z) => (Math.abs(x) >= Math.abs(z * OVAL) ? (x >= 0 ? 'east' : 'west') : (z >= 0 ? 'south' : 'north'));
const facingIn = { east: 'west', west: 'east', north: 'south', south: 'north' };

// gateAt(x, z) → the gate whose passage holds this column, or null. A passage is the 3-wide strip on the gate's axis.
function gateAt(x, z) {
  for (const g of GATES) {
    const along = g.axis === 'x' ? x : z, across = g.axis === 'x' ? z : x;
    if (Math.sign(along) === g.sign && Math.abs(across) <= GATE_HALF) return g;
  }
  return null;
}

// The emperor's box: over the north gate, x -3..3, on the podium band.
const inBox = (x, z) => z < 0 && Math.abs(x) <= 3 && r(x, z) > FLOOR_R && r(x, z) <= PODIUM_R + 1;

// ── THE DESIGN ──────────────────────────────────────────────────────────────────────────────────────
// design() → { voxels: [[x,y,z,block,state?]], points, bounds }. Pure: the same blocks every call.
function design() {
  const cells = new Map();
  const put = (x, y, z, block, state) => cells.set(`${x},${y},${z}`, [x, y, z, block, state]);
  const del = (x, y, z) => cells.delete(`${x},${y},${z}`);
  const ext = Math.ceil(WALL_R) + 1, extZ = Math.ceil(WALL_R / OVAL) + 1;

  for (let x = -ext; x <= ext; x++) for (let z = -extZ; z <= extZ; z++) {
    const d = r(x, z);
    if (d > WALL_R) continue;
    // FOUNDATION under everything, one layer below the sand.
    put(x, -1, z, 'stone_bricks');
    if (d <= FLOOR_R) { put(x, 0, z, 'sand'); continue; }
    put(x, 0, z, 'smooth_sandstone');

    if (d <= PODIUM_R) {
      // THE PODIUM: stone-brick base course, cut sandstone above, chiseled band on top.
      for (let y = 1; y <= PODIUM_TOP; y++) put(x, y, z, y === 1 ? 'stone_bricks' : y === PODIUM_TOP ? 'chiseled_sandstone' : 'cut_sandstone');
      if (d <= FENCE_R) put(x, PODIUM_TOP + 1, z, 'dark_oak_fence');
      continue;
    }
    if (d <= CAVEA_R) {
      // THE CAVEA: empty seating stepping up one block per block outward; the top of each step is a seat facing in.
      const top = PODIUM_TOP + Math.ceil(d - PODIUM_R);
      for (let y = 1; y < top; y++) put(x, y, z, 'sandstone');
      put(x, top, z, 'smooth_sandstone_stairs', { facing: outward(x, z), half: 'bottom', shape: 'straight', waterlogged: 'false' });
      continue;
    }
    // THE OUTER WALL: four storeys of arches, attic on top. A bay is BAY cells along the wall; its first cell is the
    // pier, the rest is the opening, whose top row narrows to an arch.
    const s = Math.atan2(z * OVAL, x) * WALL_R;
    const k = ((Math.floor(s) % BAY) + BAY) % BAY;
    const storeys = [[1, 5], [7, 11], [13, 17], [19, 23]];
    for (let y = 1; y <= WALL_TOP; y++) {
      const storey = storeys.find(([a, b]) => y >= a && y <= b);
      const opening = storey && k !== 0 && (y < storey[1] || (k === 2 || k === 3));
      if (opening && !(y <= 5 && gateAt(x, z))) continue;
      const band = y === 6 || y === 12 || y === 18 || y === 24;
      put(x, y, z, band ? 'chiseled_sandstone' : y === WALL_TOP ? 'smooth_sandstone' : k === 0 ? 'cut_sandstone' : 'sandstone');
    }
  }

  // THE GATES: each passage carved through podium and cavea to PEN_R, closed at the arena face by iron bars, with a
  // lintel above. The pen behind the bars is where a wave is staged.
  const pens = [], gateCells = [];
  for (const g of GATES) {
    const pen = [], bars = [];
    let barsFrom = Infinity;   // the bars' innermost step along the gate's axis, on its centre line
    for (let a = 0; a <= Math.ceil(PEN_R); a++) for (let c = -GATE_HALF; c <= GATE_HALF; c++) {
      const x = g.axis === 'x' ? g.sign * a : c, z = g.axis === 'z' ? g.sign * a : c;
      const d = r(x, z);
      if (d <= FLOOR_R || d > PEN_R) continue;
      if (d <= FENCE_R && c === 0) barsFrom = Math.min(barsFrom, a);
      for (let y = 1; y <= GATE_H; y++) {
        if (d <= FENCE_R) { put(x, y, z, 'iron_bars'); bars.push([x, y, z]); }
        else del(x, y, z);
      }
      if (d > FENCE_R) { put(x, 0, z, 'sand'); pen.push([x, 1, z]); }
      put(x, GATE_H + 1, z, d <= FENCE_R ? 'chiseled_sandstone' : 'cut_sandstone');
    }
    // A lantern at the back of the pen, so the staged mobs read on camera.
    const back = pen.reduce((m, p) => (r(p[0], p[2]) > r(m[0], m[2]) ? p : m), pen[0]);
    put(back[0], GATE_H, back[2], 'lantern', { hanging: 'true', waterlogged: 'false' });
    const penCells = pen.filter(p => !(p[0] === back[0] && p[2] === back[2]));
    pens.push({ gate: g.name, cells: penCells });
    // The mouth: the sand cell just inside the bars, on the gate's centre line, where a mob let through one at a time
    // steps out (lanista's trickle).
    const m = barsFrom - 1;
    gateCells.push({ gate: g.name, cells: bars, mouth: [g.axis === 'x' ? g.sign * m : 0, 1, g.axis === 'z' ? g.sign * m : 0] });
    // Over the gate on the arena face: lanterns either side.
    for (const c of [-2, 2]) {
      const x = g.axis === 'x' ? g.sign * Math.ceil(FLOOR_R + 1) : c, z = g.axis === 'z' ? g.sign * Math.ceil((FLOOR_R + 1) / OVAL) : c;
      if (cells.has(`${x},${PODIUM_TOP + 1},${z}`)) put(x, PODIUM_TOP + 2, z, 'lantern', { hanging: 'false', waterlogged: 'false' });
    }
  }

  // LIGHT ON THE SAND: sea lanterns set flush in the podium's inner face at y 2, every few cells, gates excepted.
  let n = 0;
  for (const [, v] of [...cells]) {
    const [x, y, z] = v;
    if (y !== 2 || v[3] === 'iron_bars') continue;
    const d = r(x, z);
    if (d <= FLOOR_R || d > FLOOR_R + 1.1 || gateAt(x, z)) continue;
    if ((n++ % 3) === 0) put(x, y, z, 'sea_lantern');
  }
  // Lanterns on the spectators' fence, every fourth post.
  n = 0;
  for (const [, v] of [...cells]) if (v[3] === 'dark_oak_fence' && (n++ % 4) === 0 && !cells.has(`${v[0]},${v[1] + 1},${v[2]}`)) put(v[0], v[1] + 1, v[2], 'lantern', { hanging: 'false', waterlogged: 'false' });

  // THE EMPEROR'S BOX, over the north gate: a quartz floor raised over the walkway, gold piers, a purple canopy and a
  // throne facing the sand.
  for (let x = -3; x <= 3; x++) for (let z = -16; z < 0; z++) {
    if (!inBox(x, z)) continue;
    const d = r(x, z);
    put(x, PODIUM_TOP + 1, z, d <= FENCE_R ? 'quartz_pillar' : 'quartz_block', d <= FENCE_R ? { axis: 'y' } : undefined);
    for (let y = PODIUM_TOP + 2; y <= PODIUM_TOP + 6; y++) del(x, y, z);
    if (d <= FENCE_R) put(x, PODIUM_TOP + 2, z, 'quartz_slab', { type: 'bottom', waterlogged: 'false' });
    else put(x, PODIUM_TOP + 2, z, 'purple_carpet');
    if (Math.abs(x) === 3 && (d <= FENCE_R + 0.6 || d > PODIUM_R)) for (let y = PODIUM_TOP + 2; y <= PODIUM_TOP + 5; y++) put(x, y, z, 'gold_block');
    put(x, PODIUM_TOP + 6, z, 'purple_wool');
  }
  const throneZ = -Math.round((PODIUM_R - 0.5) / OVAL);
  put(0, PODIUM_TOP + 2, throneZ, 'quartz_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
  // THE EMPEROR'S CONTROLS, within reach of the throne. No redstone: lanista reads each one's `powered` state over the
  // console (arena_show). The release button sits on a gold block in front of the throne; the verdict levers sit on a
  // lime block at his right hand (thumbs up) and a red one at his left (thumbs down), so the camera reads the colour.
  const controls = {
    release: { at: [0, PODIUM_TOP + 3, throneZ + 1], block: 'polished_blackstone_button', base: 'gold_block' },
    up: { at: [-1, PODIUM_TOP + 3, throneZ], block: 'lever', base: 'lime_concrete' },
    down: { at: [1, PODIUM_TOP + 3, throneZ], block: 'lever', base: 'red_concrete' },
  };
  for (const c of Object.values(controls)) {
    put(c.at[0], c.at[1] - 1, c.at[2], c.base);
    put(c.at[0], c.at[1], c.at[2], c.block, { face: 'floor', facing: 'south', powered: 'false' });
  }

  // THE VELARIUM: a striped awning over the whole bowl, its stripes meeting at a gold medallion, carried on masts at the
  // wall's piers.
  for (let x = -ext; x <= ext; x++) for (let z = -extZ; z <= extZ; z++) {
    const d = r(x, z);
    if (d > WALL_R) continue;
    const stripe = Math.floor(((Math.atan2(z * OVAL, x) + Math.PI) / (2 * Math.PI)) * 24) % 2;
    put(x, VELARIUM_Y, z, d <= MEDALLION_R ? 'gold_block' : stripe ? 'red_wool' : 'white_wool');
    // Hanging lanterns under the awning: three rings.
    const ring = Math.abs(d - 4) < 0.5 || Math.abs(d - 9) < 0.5 || Math.abs(d - 16) < 0.5;
    if (ring && ((x + z) % 4 === 0)) put(x, VELARIUM_Y - 1, z, 'lantern', { hanging: 'true', waterlogged: 'false' });
    if (d > WALL_R - 1.5 && cells.get(`${x},${WALL_TOP},${z}`)) {
      const s = Math.atan2(z * OVAL, x) * WALL_R;
      if ((((Math.floor(s) % (BAY * 2)) + BAY * 2) % (BAY * 2)) === 0) put(x, WALL_TOP, z, 'dark_oak_fence');
    }
  }

  // CONNECTIONS. setblock places a fence or bars exactly as named and does not join it to its neighbours, so every
  // join is written into the state here, from the design's own cells.
  const joins = new Set(['dark_oak_fence', 'iron_bars']);
  for (const [, v] of cells) {
    if (!joins.has(v[3])) continue;
    const at = (dx, dz) => cells.get(`${v[0] + dx},${v[1]},${v[2] + dz}`);
    const joinable = (o) => o && (joins.has(o[3]) || !/lantern|carpet|slab|stairs|sand$/.test(o[3]));
    v[4] = { north: String(!!joinable(at(0, -1))), south: String(!!joinable(at(0, 1))), east: String(!!joinable(at(1, 0))), west: String(!!joinable(at(-1, 0))), waterlogged: 'false' };
  }

  // ── NAMED POINTS ── what a fight needs to know about the set.
  const spectators = [];
  for (const deg of [25, 45, 65, 115, 135, 155, 205, 245, 295, 335]) {
    const t = deg * Math.PI / 180, rad = (FENCE_R + PODIUM_R) / 2 + 0.5;
    const x = Math.round(rad * Math.cos(t)), z = Math.round(rad * Math.sin(t) / OVAL);
    if (!inBox(x, z) && !gateAt(x, z)) spectators.push([x, PODIUM_TOP + 1, z]);
  }
  const voxels = [...cells.values()].map(v => (v[4] ? v : v.slice(0, 4)));
  const bounds = voxels.reduce((b, v) => ({ min: b.min.map((m, i) => Math.min(m, v[i])), max: b.max.map((m, i) => Math.max(m, v[i])) }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  return {
    voxels, bounds,
    points: {
      center: [0, 1, 0],
      pens, gates: gateCells, spectators,
      emperor: [0, PODIUM_TOP + 3, throneZ],
      // The emperor's guards stand on the box's carpet either side of the throne, past the levers (the operator's npc module).
      guards: [[-2, PODIUM_TOP + 2, throneZ], [2, PODIUM_TOP + 2, throneZ]],
      controls: Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, { at: c.at, block: c.block }])),
    },
  };
}

// barsState(cell, design) → the iron bars' joined state at one gate cell, read off the design (Law 16).
function cellState(d, cell) {
  const v = d.voxels.find(w => w[0] === cell[0] && w[1] === cell[1] && w[2] === cell[2]);
  return v && v[4] ? `[${Object.entries(v[4]).map(([k, s]) => `${k}=${s}`).join(',')}]` : '';
}

// ── THE BOOK: where the set stands, per world ───────────────────────────────────────────────────────
const ARENA_BOOK = path.join(__dirname, 'arena_set_book.json');
function readBook() { return fs.existsSync(ARENA_BOOK) ? JSON.parse(fs.readFileSync(ARENA_BOOK, 'utf8')) : {}; }
function worldName() {
  require('../workshop_paths').registerAliases();
  return require('@utils/server_settings').levelName(require('@utils/workstation').needServerDir());
}
// placed() → the world cell of the centre sand block of the set placed on this seat's world, or null.
function placed() { const b = readBook()[worldName()]; return b ? b.center : null; }
const toWorld = (c, p) => ({ x: c.x + p[0], y: c.y + p[1], z: c.z + p[2] });

// ── THE SET'S CAMERAS: shots kept relative to the centre sand block ─────────────────────────────────
const ARENA_CAMERAS = path.join(__dirname, 'arena_set_cameras.json');
const round1 = v => Math.round(v * 10) / 10;
function readCameras() { return fs.existsSync(ARENA_CAMERAS) ? JSON.parse(fs.readFileSync(ARENA_CAMERAS, 'utf8')) : {}; }
// cameraShots(center) → { <number>: { pos, rotation } } in world coordinates: the set's shots at this placement.
function cameraShots(center) {
  return Object.fromEntries(Object.entries(readCameras()).map(([n, s]) =>
    [n, { pos: [center.x + s.offset[0], center.y + s.offset[1], center.z + s.offset[2]], rotation: s.rotation }]));
}
// applyCameras(rcon, center) → lines: each shot kept in this machine's saved angles, and a camera already standing
// moved onto it (one not up gets it when it joins).
async function applyCameras(rcon, center) {
  require('../workshop_paths').registerAliases();
  const spots = require('@utils/camera_spots');
  const lines = [];
  for (const [n, s] of Object.entries(cameraShots(center))) {
    spots.put(n, s);
    const said = ((await rcon.command(`tp Cam_${n} ${s.pos.join(' ')} ${s.rotation.join(' ')}`)) || '').trim();
    lines.push(`Cam_${n} at ${s.pos.map(round1).join(', ')} facing ${s.rotation.join(' / ')}${/^Teleported/i.test(said) ? ', moved there' : ', put there when it joins'}`);
  }
  return lines;
}
// saveCameras(center, numbers) → lines: each named camera as it stands now, kept as the set's shot (offset + facing).
async function saveCameras(center, numbers) {
  require('../workshop_paths').registerAliases();
  const spots = require('@utils/camera_spots');
  const book = readCameras(), lines = [];
  for (const n of numbers) {
    const seat = await spots.readSeat(`Cam_${n}`);
    if (!seat.ok) { lines.push(`Cam_${n} NOT saved: ${seat.why}`); continue; }
    const offset = [seat.spot.pos[0] - center.x, seat.spot.pos[1] - center.y, seat.spot.pos[2] - center.z].map(round1);
    book[n] = { shot: (book[n] && book[n].shot) || `camera ${n}`, offset, rotation: seat.spot.rotation.map(round1) };
    spots.put(n, { pos: seat.spot.pos, rotation: seat.spot.rotation });
    lines.push(`Cam_${n} saved as the set's: offset ${offset.join(', ')} from the centre, facing ${book[n].rotation.join(' / ')}`);
  }
  fs.writeFileSync(ARENA_CAMERAS, `${JSON.stringify(book, null, 1)}\n`);
  return lines;
}

// ── PLACEMENT ───────────────────────────────────────────────────────────────────────────────────────
// Runs of one block along x become one fill; a fill is capped at 32768 cells by the server.
// ORDER: bottom up, so sand lands on its foundation; and every block that hangs from or rests on another (a lantern, a
// carpet) after everything else, so its support is already there when it is set — set first, it drops as an item.
const ATTACHED = new Set(['lantern', 'purple_carpet', 'lever', 'polished_blackstone_button']);
function commands(d, c) {
  const rows = new Map();
  const solid = d.voxels.filter(v => !ATTACHED.has(v[3])).sort((a, b) => a[1] - b[1]);
  for (const v of solid) { const k = `${v[1]},${v[2]}`; if (!rows.has(k)) rows.set(k, []); rows.get(k).push(v); }
  const out = [], last = [];
  for (const v of d.voxels.filter(w => ATTACHED.has(w[3]))) {
    const w = toWorld(c, v);
    const st = v[4] ? `[${Object.entries(v[4]).map(([k, s]) => `${k}=${s}`).join(',')}]` : '';
    last.push(`setblock ${w.x} ${w.y} ${w.z} minecraft:${v[3]}${st}`);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < row.length;) {
      let j = i;
      const id = row[i][3] + JSON.stringify(row[i][4] || {});
      while (j + 1 < row.length && row[j + 1][0] === row[j][0] + 1 && row[j + 1][3] + JSON.stringify(row[j + 1][4] || {}) === id) j++;
      const st = row[i][4] ? `[${Object.entries(row[i][4]).map(([k, s]) => `${k}=${s}`).join(',')}]` : '';
      const a = toWorld(c, row[i]), b = toWorld(c, row[j]);
      out.push(i === j ? `setblock ${a.x} ${a.y} ${a.z} minecraft:${row[i][3]}${st}` : `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} minecraft:${row[i][3]}${st}`);
      i = j + 1;
    }
  }
  return out.concat(last);
}

const FOOTING_DEPTH = 40;
// clearDrops(rcon, center) → the server's answer: every dropped item inside the set's box (its bounds, a 2-block margin,
// up to above the awning) removed. The set is a stage; loose items on it are clutter in the shot.
async function clearDrops(rcon, center) {
  const d = design();
  const lo = toWorld(center, d.bounds.min), hi = toWorld(center, d.bounds.max), m = 2;
  const said = ((await rcon.command(`kill @e[type=item,x=${lo.x - m},y=${lo.y - m},z=${lo.z - m},dx=${hi.x - lo.x + 2 * m},dy=${hi.y - lo.y + 6},dz=${hi.z - lo.z + 2 * m}]`)) || '').trim();
  return /No entity/i.test(said) ? 'drops: none on the set' : `drops: ${said}`;
}

async function place(rcon, center) {
  const d = design(), c = center;
  const lo = toWorld(c, d.bounds.min), hi = toWorld(c, d.bounds.max);
  const margin = 2, top = hi.y + 4;
  const fl = `${lo.x - margin} ${lo.z - margin} ${hi.x + margin} ${hi.z + margin}`;
  const said = [];
  const run = async (cmd) => { const body = ((await rcon.command(cmd)) || '').trim(); if (/^(Unknown|Incorrect|Expected|Invalid|Could not|That position)/i.test(body)) said.push(`${cmd} → ${body}`); return body; };
  console.log(`[set] forceloading ${fl}`);
  await run(`forceload add ${fl}`);
  // CLEAR: everything from the foundation up to above the awning, in slabs under the server's fill cap.
  const area = (hi.x - lo.x + 1 + 2 * margin) * (hi.z - lo.z + 1 + 2 * margin), slab = Math.max(1, Math.floor(32768 / area));
  for (let y = lo.y; y <= top; y += slab) {
    await run(`fill ${lo.x - margin} ${y} ${lo.z - margin} ${hi.x + margin} ${Math.min(top, y + slab - 1)} ${hi.z + margin} minecraft:air`);
  }
  // FOOTING: every air cell under the footprint is filled with stone down to FOOTING_DEPTH, so the set never floats over
  // a dip or a hillside; the ground it stands on is left as it was.
  for (let y = lo.y - 1; y >= lo.y - FOOTING_DEPTH; y -= slab) {
    await run(`fill ${lo.x - margin} ${Math.max(lo.y - FOOTING_DEPTH, y - slab + 1)} ${lo.z - margin} ${hi.x + margin} ${y} ${hi.z + margin} minecraft:stone replace air`);
  }
  const cmds = commands(d, c);
  console.log(`[set] placing ${d.voxels.length} blocks in ${cmds.length} commands`);
  let i = 0;
  for (const cmd of cmds) { await run(cmd); if (++i % 1000 === 0) console.log(`[set]   ${i}/${cmds.length}`); }
  // The clearing pops what stood on the cut ground (plants, torches, tree drops) as items; they go before the chunks unload.
  console.log(`[set] ${await clearDrops(rcon, c)}`);
  await run(`forceload remove ${fl}`);
  // READ BACK (Law 23): the centre sand, a gate bar and the throne, asked of the server.
  const probes = [[0, 0, 0, 'sand'], [...d.points.gates[0].cells[0], 'iron_bars'], [...d.points.emperor.map((v, k) => (k === 1 ? v - 1 : v)), 'quartz_stairs'],
    ...Object.values(d.points.controls).map(q => [...q.at, q.block])];
  const misses = [];
  for (const p of probes) { const w = toWorld(c, p); const body = await run(`execute if block ${w.x} ${w.y} ${w.z} minecraft:${p[3]}`); if (!/passed/i.test(body)) misses.push(`${p[3]} at ${w.x} ${w.y} ${w.z} (${body || 'no answer'})`); }
  return { blocks: d.voxels.length, commands: cmds.length, refused: said, misses };
}

// groundAt(rcon, x, z) → the top ground cell at x,z, as the server finds it: a marker is spread onto the surface there
// (spreadplayers lands an entity on the highest block), its position read, and the marker removed.
async function groundAt(rcon, x, z) {
  if (![x, z].every(Number.isInteger)) return null;
  const fl = `${x} ${z} ${x} ${z}`;
  await rcon.command(`forceload add ${fl}`);
  // A forceloaded chunk arrives a moment later; the marker is summoned once the server says it took.
  let said = '';
  for (let i = 0; i < 20 && !/summoned/i.test(said); i++) {
    await new Promise(res => setTimeout(res, 250));
    said = (await rcon.command(`summon minecraft:armor_stand ${x + 0.5} 300 ${z + 0.5} {Tags:["arena_set_probe"],Invisible:1b}`)) || '';
  }
  const spread = (await rcon.command(`spreadplayers ${x + 0.5} ${z + 0.5} 0 1 false @e[tag=arena_set_probe]`)) || '';
  const body = (await rcon.command('data get entity @e[tag=arena_set_probe,limit=1] Pos')) || '';
  await rcon.command('kill @e[tag=arena_set_probe]');
  await rcon.command(`forceload remove ${fl}`);
  const m = body.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*\]/);
  if (!m) throw new Error(`arena_set: the server did not say where the ground is at ${x},${z} (summon: ${said.trim() || 'no answer'}; spread: ${spread.trim() || 'no answer'}; read: ${body.trim() || 'no answer'})`);
  return { x, y: Math.floor(Number(m[2])) - 1, z };
}

// setGates(rcon, center, open, only) → cells set: the bars of every gate, or only of the gates named in `only`, taken
// away (open: the gate disappears) or put back.
async function setGates(rcon, center, open, only = null) {
  const d = design();
  const gates = only ? d.points.gates.filter(g => only.includes(g.gate)) : d.points.gates;
  const cmds = gates.flatMap(g => g.cells.map(cell => { const w = toWorld(center, cell); return `setblock ${w.x} ${w.y} ${w.z} ${open ? 'minecraft:air' : `minecraft:iron_bars${cellState(d, cell)}`}`; }));
  for (const cmd of cmds) await rcon.command(cmd);
  if (open) for (const g of gates) {
    const w = toWorld(center, g.cells[0]);
    await rcon.command(`playsound minecraft:block.iron_door.open block @a ${w.x} ${w.y} ${w.z} 2 0.6`);
    await rcon.command(`particle minecraft:poof ${w.x} ${w.y + 1} ${w.z} 1 1 1 0.02 20`);
  }
  return cmds.length;
}

async function main() {
  const { rconLink, fmt } = require('./lanista_shared');
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
  const cell = (s) => { const [x, y, z] = String(s).split(',').map(Number); return [x, y, z].every(Number.isInteger) ? { x, y, z } : null; };
  const rcon = await rconLink.open(rconLink.readServerProperties());
  const { withCleanup } = require('../../js_kernel/utils/external_library_guard');
  return withCleanup('arena_set', 'main', async () => {
    if (args.place) {
      // `--place=<x>,~,<z>`: the sand replaces the top block of the ground there, read off the server.
      const [px, py, pz] = String(args.place).split(',');
      const c = py === '~' ? await groundAt(rcon, Number(px), Number(pz)) : cell(args.place);
      if (!c) { console.error('--place needs the world cell of the centre sand block, as <x>,<y>,<z> (or <x>,~,<z> for the ground there).'); return 1; }
      const out = await place(rcon, c);
      const book = readBook(); book[worldName()] = { center: c, placedAt: new Date().toISOString() };
      fs.writeFileSync(ARENA_BOOK, `${JSON.stringify(book, null, 1)}\n`);
      console.log(`[set] placed ${out.blocks} blocks (${out.commands} commands) centred on ${fmt(c)}; book: ${path.basename(ARENA_BOOK)}`);
      for (const s of out.refused.slice(0, 20)) console.log(`[set] ⚠ REFUSED ${s}`);
      for (const m of out.misses) console.log(`[set] ⚠ READ BACK FAILED: ${m}`);
      for (const line of await applyCameras(rcon, c)) console.log(`[set] camera ${line}`);
      return out.refused.length || out.misses.length ? 1 : 0;
    }
    const c = args.at ? cell(args.at) : placed();
    if (!c) { console.error(`No set is placed on world '${worldName()}'. Place one with --place=<x>,<y>,<z>, or name it with --at.`); return 1; }
    if (args.cameras) {
      for (const line of await applyCameras(rcon, c)) console.log(`[set] camera ${line}`);
      return 0;
    }
    if (args['save-cameras']) {
      const numbers = String(args['save-cameras']).split(',').map(s => s.trim()).filter(s => /^[1-9]\d*$/.test(s));
      if (!numbers.length) { console.error('--save-cameras needs camera numbers, as --save-cameras=4,5'); return 1; }
      const lines = await saveCameras(c, numbers);
      for (const line of lines) console.log(`[set] ${line}`);
      return lines.some(l => /NOT saved/.test(l)) ? 1 : 0;
    }
    if (args.gates) {
      const n = await setGates(rcon, c, args.gates === 'open');
      console.log(`[set] gates ${args.gates}: ${n} cells`); return 0;
    }
    const d = design(), p = d.points;
    console.log(`centre stand  ${fmt(toWorld(c, p.center))}`);
    for (const pen of p.pens) console.log(`pen ${pen.gate.padEnd(5)}     ${pen.cells.map(q => fmt(toWorld(c, q))).join(' ')}`);
    console.log(`emperor seat  ${fmt(toWorld(c, p.emperor))}`);
    for (const [k, q] of Object.entries(p.controls)) console.log(`control ${k.padEnd(7)} ${q.block} ${fmt(toWorld(c, q.at))}`);
    for (const g of p.gates) console.log(`mouth ${g.gate.padEnd(7)}  ${fmt(toWorld(c, g.mouth))}`);
    console.log(`spectators    ${p.spectators.map(q => fmt(toWorld(c, q))).join(' ')}`);
    return 0;
  }, () => rcon.close());
}

if (require.main === module) main().then(code => process.exit(code || 0));

module.exports = { design, placed, toWorld, setGates, clearDrops, applyCameras, GATES, ARENA_BOOK, ARENA_CAMERAS };
