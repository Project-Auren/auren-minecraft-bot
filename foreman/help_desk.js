// foreman/help_desk.js — THE HELP DESK: the foreman picks the one body that terminates the mob a body ran from (the T-2), and
// puts the mob on the threat board the crew's full-time terminators (the T-1s) work, calls first. One way, no repeats.
//
// No body speaks to another, and every word is a handoff the receiver is trusted with:
//   1. A body starts a run and hands the desk one call (help_call: the mob, and every peer it knows ranked by distance to the
//      mob). The desk takes it at once (help_taken): the calling body's part is over, and it never calls on that run again.
//   2. The desk walks the ranked list once, giving the request to one body at a time (help_ask). The request waits on that body
//      until its next inline check, which answers it (help_reply) from the body as it stands then. A body has ANSWER_MS:
//      - "not available" carries its reason, and the request goes to the next body;
//      - no answer: the desk pulls the request from the body (help_withdrawn), waits PULL_GRACE_MS for an answer the body sent
//        before the pull reached it, then gives the request to the next body; the silent body goes to the end of the list, where
//        it is given the request once more;
//      - the first "available" is the terminator: the desk tells it so (help_assign) and the call is over.
//   3. Every body that ends the list with "no" or silence leaves the call over with no T-2 (HELP_NONE).
//
// THE T-1 ALWAYS COMES. The mob goes on the foreman's threat board as a call (toBoard, threat_board.addCall), at the head of
// every T-1's list, so a T-1 takes it when it finishes the target it holds. A body whose chair says it is designated T
// (terminators(): the crew's seat, assessors/terminator_duty) is never asked to be the T-2. The T-2 is the stopgap: when a
// T-1 reaches the mob it tells the desk (help_relieve), and the desk tells the T-2 holding that mob (help_relieved), which
// goes back to its work. The desk keeps each T-2 by its mob for that word alone, up to T2_KEEP_MS.
//
// AN ANSWER TO A REQUEST NOT GIVEN TO THAT BODY NOW IS A CODING VIOLATION (Law 13): after the pull and its grace, the request is
// gone from the body, so no correct body can answer it.
// The desk never asks again, never checks on a terminator and never picks a second one for a call.
//
// The desk holds no socket: the hub hands it send(botId, type, payload) → bool, connected() → [botId], log(line) and later(fn, ms).

'use strict';

// A body answers at its next inline check (help_line.answerAtGate): every step, dig or place of a working body, and every
// second for an idle one (idle_scheduler RECHECK_MS).
const ANSWER_MS = 2000;
// After the pull, the desk waits this long for an answer already on its way: both ends run on this machine.
const PULL_GRACE_MS = 250;
// A T-2 is kept by its mob this long for the T-1's word that it has arrived.
const T2_KEEP_MS = 900000;

function createHelpDesk({ send, connected, log, later, terminators, toBoard }) {
  const walks = new Map();         // call id → the walk in progress
  const t2s = new Map();           // mob id → { botId, call, at } — the T-2 holding it, until a T-1 relieves it
  let seq = 0;

  const label = (w) => `${w.mob.name}#${w.mob.id}`;
  const violation = (what) => { throw new Error(`[help_desk] LAW 13 VIOLATION: ${what}`); };

  function askNext(w) {
    while (w.queue.length) {
      const b = w.queue.shift();
      if (!connected().includes(b)) { w.answers.push(`${b}:gone`); continue; }
      const askId = ++seq;
      if (!send(b, 'help_ask', { call: w.id, ask_id: askId, mob: w.mob, by: w.caller })) { w.answers.push(`${b}:send failed`); continue; }
      log(`HELP_ASK call=${w.id} mob=${label(w)} bot=${b} ask=${askId}${w.skipped.has(b) ? ' (second time)' : ''}`);
      w.ask = { botId: b, askId, pulled: false, at: Date.now() };
      later(() => pull(w, askId), ANSWER_MS);
      return;
    }
    walks.delete(w.id);
    log(`HELP_NONE call=${w.id} mob=${label(w)} caller=${w.caller} answers=${w.answers.join(' | ') || 'no body to ask'}`);
  }

  // pull(w, askId) — the window closed with no answer: the request is pulled from the body, and given on after the grace.
  function pull(w, askId) {
    if (walks.get(w.id) !== w || !w.ask || w.ask.askId !== askId) return;
    w.ask.pulled = true;
    send(w.ask.botId, 'help_withdrawn', { call: w.id, ask_id: askId });
    log(`HELP_PULL call=${w.id} mob=${label(w)} bot=${w.ask.botId} ask=${askId} — no answer in ${ANSWER_MS} ms; waiting ${PULL_GRACE_MS} ms`);
    later(() => giveOn(w, askId), PULL_GRACE_MS);
  }

  function giveOn(w, askId) {
    if (walks.get(w.id) !== w || !w.ask || w.ask.askId !== askId) return;
    const b = w.ask.botId;
    w.ask = null;
    if (!w.skipped.has(b)) { w.skipped.add(b); w.queue.push(b); w.answers.push(`${b}:silent`); } else w.answers.push(`${b}:silent again`);
    log(`HELP_SILENT call=${w.id} mob=${label(w)} bot=${b} ${w.answers[w.answers.length - 1].endsWith('again') ? 'passed for good' : 'to the end of the list'}`);
    askNext(w);
  }

  // call(botId, { request_id, mob: { id, name, pos }, ranked: [botId], why }) — one run, one call.
  function call(botId, payload) {
    const mob = payload && payload.mob;
    if (!mob || typeof mob.id !== 'number') violation(`help_call from ${botId} names no mob`);
    const id = ++seq;
    send(botId, 'help_taken', { call: id, mob: mob.id, request_id: payload.request_id });
    const online = connected();
    const now = Date.now();
    for (const [mobId, t] of [...t2s]) if (now - t.at > T2_KEEP_MS) t2s.delete(mobId);
    const t1s = terminators().filter((b) => b !== botId && online.includes(b)).sort();
    const ranked = (payload.ranked || []).filter((b) => b !== botId && online.includes(b) && !t1s.includes(b));
    const rest = online.filter((b) => b !== botId && !ranked.includes(b) && !t1s.includes(b)).sort();
    const w = { id, mob, caller: botId, queue: [...ranked, ...rest], skipped: new Set(), answers: [], ask: null, t1s };
    walks.set(id, w);
    log(`HELP_CALL call=${id} mob=${label(w)} caller=${botId} why=${payload.why || 'none'} t1=${t1s.join('+') || 'none'} ask_order=${w.queue.join(',') || 'none'}`);
    toBoard(mob, botId, id);
    log(`HELP_BOARD call=${id} mob=${label(w)} t1=${t1s.join('+') || 'none'}`);
    askNext(w);
  }

  // reply(botId, { call, ask_id, available, reason }) — the answer to the request the desk gave this body.
  function reply(botId, payload) {
    const w = payload && walks.get(payload.call);
    if (!w || !w.ask || w.ask.botId !== botId || w.ask.askId !== payload.ask_id) {
      violation(`${botId} answered request ${payload && payload.call}/${payload && payload.ask_id}, which the desk is not giving it`);
    }
    const crossed = w.ask.pulled;
    const ms = Date.now() - w.ask.at;
    w.ask = null;
    if (payload.available === true) {
      walks.delete(w.id);
      send(botId, 'help_assign', { call: w.id, ask_id: payload.ask_id, mob: w.mob, by: w.caller, t1: w.t1s });
      t2s.set(w.mob.id, { botId, call: w.id, at: Date.now() });
      log(`HELP_ASSIGN call=${w.id} mob=${label(w)} terminator=${botId} role=T-2 t1=${w.t1s.join('+') || 'none'} caller=${w.caller} answer_ms=${ms}${crossed ? ' (answer crossed the pull)' : ''} after=${w.answers.join(' | ') || 'first asked'}`);
      return;
    }
    const reason = payload.reason ? String(payload.reason) : 'refused without a reason';
    if (!payload.reason) log(`HELP_REPLY_NO_REASON call=${w.id} from=${botId} — a refusal must carry its reason`);
    w.answers.push(`${botId}:${reason}`);
    log(`HELP_DECLINE call=${w.id} mob=${label(w)} bot=${botId} answer_ms=${ms} reason=${reason}${crossed ? ' (answer crossed the pull)' : ''}`);
    askNext(w);
  }

  // relieve(botId, { call, mob: { id, name } }) — a T-1 has reached the mob: the T-2 holding it is told, and the desk forgets it.
  function relieve(botId, payload) {
    const m = payload && payload.mob;
    if (!m || typeof m.id !== 'number') violation(`help_relieve from ${botId} names no mob`);
    const t = t2s.get(m.id);
    if (!t) { log(`HELP_RELIEVE call=${payload.call} mob=${m.name}#${m.id} t1=${botId} — no T-2 holds it`); return; }
    t2s.delete(m.id);
    const sent = send(t.botId, 'help_relieved', { call: t.call, mob: m, by: botId });
    log(`HELP_RELIEVED call=${t.call} mob=${m.name}#${m.id} t1=${botId} t2=${t.botId} held_ms=${Date.now() - t.at}${sent ? '' : ' send failed'}`);
  }

  // open() → the walks in progress, for the read door.
  function open() {
    return [...walks.values()].map((w) => ({ call: w.id, mob: label(w), caller: w.caller, asking: w.ask ? w.ask.botId : null, pulled: !!(w.ask && w.ask.pulled), left: w.queue.length }));
  }

  return { call, reply, relieve, open };
}

module.exports = { createHelpDesk, ANSWER_MS, PULL_GRACE_MS, T2_KEEP_MS };
