// js_kernel/hive_stack.js
// A HIVE is a shelter built of floors instead of one fixed blueprint. building_blueprints.json holds each floor in its own frame
// (y 0 its slab, y 1..3 its room) in its `floors` section; architect_config.HIVES holds each hive's recipe: its SHELTER (the
// floors every crew of that kind raises first, bottom first), its EXPANSIONS (raised on top of the shelter in order; when
// the hive GROWS the last repeats, so it keeps growing upward) and its roof. Phase 1 is the shelter; phase n adds the first n-1 expansions. Every
// hive on one footprint shares the shell, so two hives look alike outside and differ only in their floors' interiors.
// Pure: recipe and file data in, a building entry out, so a floor's blocks, stands and beds have one statement however many
// hives and phases use it (Law 16). Structure Studio's floor designer stacks the same recipes from the same floors.

'use strict';

const HEIGHT = 4;

const raise = (p, y0) => [p[0], p[1] + y0, p[2], ...p.slice(3)];

// lastPhase(hive) → the highest phase a hive has: none for one that grows.
const lastPhase = hive => hive.grows ? Infinity : hive.expansions.length + 1;

// phaseFloors(hive, phase) → the occupied floors of a hive raised through `phase`, bottom first.
function phaseFloors(hive, phase) {
  if (!Number.isInteger(phase) || phase < 1 || phase > lastPhase(hive)) {
    throw new Error(`[hive_stack] CODING VIOLATION (Law 13): hive phase ${phase} asked for; phases count from 1 to ${lastPhase(hive)}.`);
  }
  const floors = [...hive.shelter];
  for (let i = 0; i < phase - 1; i++) floors.push(...hive.expansions[Math.min(i, hive.expansions.length - 1)].floors);
  return floors;
}

// validateHive(name, hive, pieces) → null, or what is wrong with a hive's recipe against the file's floors. A stack through
// every expansion, and one repeat when it grows, proves every floor is present, stackable and on one footprint.
function validateHive(name, hive, pieces) {
  if (!hive || !Array.isArray(hive.shelter) || !hive.shelter.length) return `has a hive "${name}" with no shelter floors`;
  if (!Array.isArray(hive.expansions)) return `has a hive "${name}" with no expansions list`;
  for (const [i, e] of hive.expansions.entries()) {
    if (!e || typeof e.title !== 'string' || !Array.isArray(e.floors) || !e.floors.length) return `has hive "${name}" expansion ${i + 1} without a title and at least one floor`;
  }
  if (typeof hive.grows !== 'boolean') return `has hive "${name}" without grows: true or false`;
  if (!Number.isInteger(hive.phase) || hive.phase < 1 || hive.phase > lastPhase(hive)) return `has hive "${name}" raised to phase ${hive.phase}; its phases run 1 to ${lastPhase(hive)}`;
  stackFloors(name, pieces, { floors: phaseFloors(hive, hive.expansions.length + (hive.grows ? 2 : 1)), roof: hive.roof, title: hive.title });
  return null;
}

// stackHive(name, hive, pieces, phase) → the hive raised through `phase`, in the shape blueprint_registry serves.
function stackHive(name, hive, pieces, phase) {
  const entry = stackFloors(name, pieces, { floors: phaseFloors(hive, phase), roof: hive.roof, title: hive.title });
  entry.design_intent.phase = phase;
  return entry;
}

// stackFloors(name, pieces, { floors, roof, title }) → the building entry. `floors` names the occupied storeys bottom first;
// the first is a ground piece, whose slab has no stair opening, and the rest are upper pieces. A floor stacked more than once
// (a repeated expansion) gives each copy's stands and workstations their level, so every id stays one station. The frame's
// origin is the footprint's middle cell, the same for every hive of one footprint.
function stackFloors(name, pieces, { floors, roof, title }) {
  const refuse = (why) => new Error(`[hive_stack] CODING VIOLATION (Law 13): "${name}" ${why} Pieces: ${Object.keys(pieces).join(', ')}.`);
  const parts = [...floors, roof];
  for (const part of parts) if (!pieces[part]) throw refuse(`names the floor "${part}", which the file does not hold.`);
  if (!floors.length) throw refuse('names no floors.');
  floors.forEach((part, i) => {
    const kind = pieces[part].kind;
    if (kind !== (i === 0 ? 'ground' : 'floor')) throw refuse(`has the ${kind} piece "${part}" as storey ${i + 1}; storey 1 is a ground piece and the rest are upper pieces, or the stair does not meet.`);
  });
  if (pieces[roof].kind !== 'roof') throw refuse(`has "${roof}" as its roof, which is a ${pieces[roof].kind} piece.`);
  const { w, l } = pieces[floors[0]].dimensions;
  const odd = parts.find(part => pieces[part].dimensions.w !== w || pieces[part].dimensions.l !== l);
  if (odd) throw refuse(`stacks "${odd}" on a ${w} x ${l} footprint it does not share.`);

  const h = parts.length * HEIGHT;
  const origin = { x: Math.floor(w / 2), y: 0, z: Math.floor(l / 2) };
  const anchors = [], beds = [], required_air = [], workstations = [], levels = [];
  // A floor's voxel_accepts (a type → the other blocks that stand for it, blueprint_survey.classifyVoxel) holds for the
  // whole hive: the reading is by type, so the hive's is the union of its floors'.
  const voxel_accepts = {};
  parts.forEach((part, i) => {
    const piece = pieces[part], y0 = i * HEIGHT;
    for (const a of piece.anchors) anchors.push({ ...a, name: `level_${i + 1}_${a.name}`, position: raise(a.position, y0), voxels: a.voxels.map(v => raise(v, y0)) });
    for (const b of piece.beds || []) beds.push({ ...b, id: `bed_${b.foot[0]}_${b.foot[1] + y0}_${b.foot[2]}`, foot: raise(b.foot, y0), head: raise(b.head, y0) });
    for (const p of piece.required_air || []) required_air.push(raise(p, y0));
    for (const s of piece.workstations || []) workstations.push({ ...s, id: `level_${i + 1}_${s.id}`, stand: raise(s.stand, y0), targets: s.targets.map(p => raise(p, y0)) });
    levels.push({ id: `level_${i + 1}`, piece: part, name: piece.title, min: y0, max: y0 + HEIGHT - 1 });
    for (const [type, others] of Object.entries(piece.voxel_accepts || {})) voxel_accepts[type] = [...new Set([...(voxel_accepts[type] || []), ...others])];
  });
  return {
    name, description: `${floors.length} floors and a roof: ${parts.join(', ')}`,
    dimensions: { w, h, l, yMin: 0, yMax: h - 1 },
    build_center: { x: 0, y: 0, z: 0 }, transpose_origin: origin, transpose_origin_cell: origin,
    anchors, unassigned_voxels: [],
    ...(Object.keys(voxel_accepts).length ? { voxel_accepts } : {}),
    design_intent: { title, beds, installed_beds: beds.length, bed_capacity: beds.length, required_air, floors: levels, roof_from: floors.length * HEIGHT, recipe: { floors, roof }, workstations },
  };
}

module.exports = { stackHive, stackFloors, phaseFloors, validateHive, lastPhase, HEIGHT };
