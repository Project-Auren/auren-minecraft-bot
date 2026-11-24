// utility: death_mark — the words a body says when it dies, and the one test that hears them.
//
// battle_stations says it (a warning: a death is not a fault of the code), and the foreman's hub counts it for the
// run's watch (foreman/utils/run_watch, the `death` wake). One mark, one test (Law 16).

'use strict';

const DIED = '☠️ DIED';
const saysDied = (line) => typeof line === 'string' && line.includes(DIED);

module.exports = { DIED, saysDied };
