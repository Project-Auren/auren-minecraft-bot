/*
port_book.js — the ports a seat's runs use: the same ones every run, read off the seat's own server.

A seat is one Minecraft server folder and the records its runs write. Every run on a seat uses the same four ports:
the server's game port and its
console (RCON) port, as its own server.properties says, and the foreman's pair — its hub and the in-game door one
above it — set by the game port's distance from the usual one:

    game 25565 → foreman 3001/3002 · game 25566 → 3003/3004 · game 25567 → 3005/3006

So a downloaded bot with one server on the usual port uses the usual foreman ports, and each seat on this machine
has its own set that no other seat's run takes. A port a run needs that something else holds is refused by name,
never moved: a run that wandered to another port would be a run on a seat nobody can address.

A port is FREE when nothing answers a connect on 127.0.0.1 and this process can open a listener on it; the two are
asked together because a server bound to one address can be missed by a listen on another.

runForemanPort() reads the port the run up in THIS copy took, from its run lock (start_auren.js), else the seat's
own, so the operator's tools (foreman_door, fleet_control) address the foreman of this copy's seat.
*/

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { guardExternalSync } = require('./external_library_guard');

// The foreman's usual port, for the server on the usual game port; the in-game door is the one above it.
const FOREMAN_PORT_USUAL = 3001;
const GAME_PORT_USUAL = 25565;
// How many seats one machine's game ports may span above the usual one; past it the foreman ports would walk into
// other programs' ground.
const SEAT_SPAN = 20;

function answers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function canListen(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

// portFree(port) → Promise<boolean>
async function portFree(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[port_book] CODING VIOLATION (Law 13): portFree needs a port number, got ${port}.`);
  }
  return !(await answers(port)) && canListen(port);
}

// seatPorts(serverDir) → { game, rcon, foreman, door }: the seat's fixed ports. Throws when the server's game port
// lies outside the seat span, because the foreman pair it implies would not be this machine's to take.
function seatPorts(serverDir) {
  // Read with the console link's own parser, the file the server itself reads (server_settings reads the same);
  // the Minecraft defaults stand in for a key the file leaves out.
  const props = require('./rcon_link').parseServerProperties(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'));
  const game = parseInt(props['server-port'], 10) || GAME_PORT_USUAL;
  const rcon = parseInt(props['rcon.port'], 10) || 25575;
  const seat = game - GAME_PORT_USUAL;
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_SPAN) {
    throw new Error(`[port_book] the server in ${serverDir} plays on port ${game}; a seat's game port is ${GAME_PORT_USUAL} to `
      + `${GAME_PORT_USUAL + SEAT_SPAN - 1}, and its foreman ports follow from it. Set server-port in its server.properties.`);
  }
  const foreman = FOREMAN_PORT_USUAL + 2 * seat;
  return { game, rcon, foreman, door: foreman + 1 };
}

// busyPorts(ports) → Promise<number[]>: which of the given ports something already holds.
async function busyPorts(ports) {
  const busy = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  return busy;
}

// runForemanPort() → the foreman port of this copy: the run lock's (start_auren.js) while a run is up, else its
// seat's; null when no server folder is found.
function runForemanPort() {
  const lock = path.join(__dirname, '..', '..', 'run_lock.json');
  if (fs.existsSync(lock)) {
    const read = guardExternalSync('port_book', 'reading the run lock', () => JSON.parse(fs.readFileSync(lock, 'utf8')));
    const port = read.ok && read.value ? read.value.foreman_port : null;
    if (Number.isInteger(port)) return port;
  }
  const serverDir = require('./workstation').findServerDir().dir;
  return serverDir ? seatPorts(serverDir).foreman : null;
}

module.exports = { portFree, busyPorts, seatPorts, runForemanPort, FOREMAN_PORT_USUAL, GAME_PORT_USUAL };
