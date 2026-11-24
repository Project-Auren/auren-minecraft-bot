// api: battle_ledger — WHERE THE CREW FIGHTS, COUNTED BY THE BASE'S ANCHORS.
//
// Every battle a body of the crew opens is counted once, to the nearest anchor (architect_config.TERMINATOR_POSTS.anchors:
// the sited structures the crew works round). A battle is a claim on the combat road: this body's own (combat_board.setClaim)
// or a peer's heard in its note (combat_board.receive), placed where the claiming body stood. A claim is counted the first
// time it is seen; the same body holding the same mob is the same battle, and so is a body's next claim within BATTLE_GAP_MS
// and BATTLE_SPAN_B of its last: a pack fought in one place is one battle, however many mobs it held.
//
// Every body keeps the count, so a body that becomes a terminator already knows where the crew has fought. The count is a
// record: no post is chosen from it today (the terminator idles at the park spot). The terminator's planner reads this
// body's own last battle (action_fragments.js/terminator_planner) and holds its place for TERMINATOR_POSTS.after_battle_ms.
// The counts are kept for lighting the places fights recur and for a base spread too wide for one park spot. Kept in
// memory: a restart begins the count again.
//
// Logged as BATTLE on a terminator's trace, one line per battle counted.

'use strict';

const watcher = require('@kernel/watcher');

const TAG = 'battle_ledger';
const SEEN_KEEP_MS = 600000;   // a claim is remembered this long, so a claim renewed on every note is not counted again
const BATTLE_GAP_MS = 30000;   // a body's claim this soon after its last, and
const BATTLE_SPAN_B = 16;      // this near it, is the same battle

const _seen = new Map();       // `${by}:${mobId}` → when first seen
const _counts = new Map();     // anchor name → battles counted to it
let _lastOwn = null;           // { pos, at, anchor }: this body's own last battle
const _lastBy = new Map();     // body → { pos, at }: its last claim, to join a pack's claims into one battle

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const me = () => process.env.BOT_ID || 'default';

// anchors() → [{ name, x, z }] for every anchor sited so far, in the TERMINATOR_POSTS order: the centre of its footprint.
function anchors() {
  const { TERMINATOR_POSTS } = require('@thinking/architect_config');
  const { buildingRoomKey } = require('@kernel/bot_mandate');
  const boxes = require('@action/find_buildingspot').getExistingFootprints(0);
  const out = [];
  for (const name of TERMINATOR_POSTS.anchors) {
    const b = boxes.find((x) => x.key === buildingRoomKey(name));
    if (b) out.push({ name, x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });
  }
  return out;
}

// nearest(pos, list) → the anchor in `list` nearest pos.
function nearest(pos, list) {
  return list.reduce((best, a) => (!best || flat(pos, a) < flat(pos, best) ? a : best), null);
}

// note({ by, id, pos }, now) — a battle seen: counted once to its nearest anchor. Nothing is counted before an anchor is sited.
function note({ by, id, pos }, now = Date.now()) {
  if (id === undefined || id === null || !pos) return;
  const key = `${by}:${id}`;
  if (_seen.has(key)) return;
  for (const [k, t] of _seen) if (now - t > SEEN_KEEP_MS) _seen.delete(k);
  _seen.set(key, now);
  const prev = _lastBy.get(by);
  _lastBy.set(by, { pos: { x: pos.x, z: pos.z }, at: now });
  if (prev && now - prev.at <= BATTLE_GAP_MS && flat(prev.pos, pos) <= BATTLE_SPAN_B) {
    if (by === me() && _lastOwn) _lastOwn = { ..._lastOwn, at: now };
    return;
  }
  const list = anchors();
  if (!list.length) return;
  const a = nearest(pos, list);
  _counts.set(a.name, (_counts.get(a.name) || 0) + 1);
  if (by === me()) _lastOwn = { pos: { x: pos.x, z: pos.z }, at: now, anchor: a.name };
  if (require('@api/combat_board').isTerminator()) {
    watcher.summary(TAG, `BATTLE anchor=${a.name} d=${Math.round(flat(pos, a))} by=${by} mob=#${id} at=(${Math.floor(pos.x)},${Math.floor(pos.z)})`
      + ` counts=${JSON.stringify(counts())}`);
  }
}

// counts() → { anchor: battles } for every anchor counted so far.
function counts() { return Object.fromEntries(_counts); }

// lastOwnBattle() → { pos, at, anchor } of this body's own last battle, or null.
function lastOwnBattle() { return _lastOwn; }

module.exports = { note, counts, anchors, lastOwnBattle };
