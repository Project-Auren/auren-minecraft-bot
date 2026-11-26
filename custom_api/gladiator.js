// gladiator — BETWEEN FIGHTS, A GLADIATOR HOLDS ITS POST (designation G, Thinking_fragments/designations).
//
// The operator gives the post with the `sentry` verb that designates the body: the cell it stands on (feet) and the cell it
// bows toward. While the watch stands (await_aggro, a quiet pass), holdPost walks the body to its post through the
// locomotion API, faces the bow cell, and bows: it crouches and holds the crouch. The watch calls rise() before every look
// for a fight and holdPost after a quiet one, so the bow is held until a monster aggros. Where the post is and what
// the body faces are the operator's authored inputs (Law 26); this file walks, turns and bows, and decides nothing else.
//
// A body that is not a gladiator, or a gladiator with no post, holds nothing here.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'gladiator';

// Off the post's centre by more than this (blocks, flat) and the body walks back to it.
const POST_REACH = 1.0;

let _post = null;   // { stand: {x,y,z} feet cell, face: {x,y,z} cell }
let _bowing = false;  // the bow is HELD: crouched from the first quiet pass at the post until rise()

const isCell = c => c && [c.x, c.y, c.z].every(Number.isFinite);

// setPost(post) — the operator's post, or null to clear it. A malformed post is a coding violation (Law 13).
function setPost(post) {
  if (post === null) { _post = null; return; }
  if (!post || !isCell(post.stand) || !isCell(post.face)) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a post is { stand: {x,y,z}, face: {x,y,z} }. Got: ${JSON.stringify(post)}`);
  }
  _post = { stand: { x: Math.floor(post.stand.x), y: Math.floor(post.stand.y), z: Math.floor(post.stand.z) }, face: { ...post.face } };
}
const post = () => _post;

// holdPost(bot) → null (nothing to hold) | 'walked' | 'bowed' | 'off post: <why>'. One step per call. Called on every quiet
// pass, so the body walks back the moment nothing is aggroed or fought: from the post every gate is in its sight.
async function holdPost(bot) {
  if (!_post || !require('@api/combat_board').isGladiator()) return null;
  const p = bot.entity.position, s = _post.stand;
  if (Math.hypot(p.x - (s.x + 0.5), p.z - (s.z + 0.5)) > POST_REACH) {
    const r = await require('@locomotion/locomotion_dispatcher').goTo(s);
    if (r && r.arrived) { watcher.summary(TAG, `GLADIATOR_POST reached (${s.x},${s.y},${s.z})`); return 'walked'; }
    const why = `the walk to (${s.x},${s.y},${s.z}) did not arrive (${(r && r.reason) || 'no verdict'})`;
    watcher.warn(TAG, `GLADIATOR_POST ${why}`);
    return `off post: ${why}`;
  }
  const f = _post.face;
  await guardExternal(TAG, 'face the box', () => bot.lookAt(new Vec3(f.x + 0.5, f.y + 1.6, f.z + 0.5), true));
  if (!_bowing) {
    guardExternalSync(TAG, 'bow down', () => bot.setControlState('sneak', true));
    _bowing = true;
  }
  return 'bowed';
}

// rise(bot) — the bow ends: the body stands before every look for a fight (await_aggro calls it ahead of battleStations),
// so it never fights crouched. A quiet pass bows again at once, inside the same server tick, so the held bow does not flicker.
function rise(bot) {
  if (!_bowing) return;
  _bowing = false;
  guardExternalSync(TAG, 'rise', () => bot.setControlState('sneak', false));
}

module.exports = { setPost, post, holdPost, rise, POST_REACH };
