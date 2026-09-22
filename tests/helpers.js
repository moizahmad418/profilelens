// Loads the browser libraries into a fresh global SIT namespace for Node tests.
const path = require('path');

function loadSIT() {
  delete globalThis.SIT;
  for (const file of ['common.js', 'x-parser.js', 'li-parser.js', 'stats.js']) {
    const full = path.join(__dirname, '..', 'src', 'lib', file);
    delete require.cache[require.resolve(full)];
    require(full);
  }
  return globalThis.SIT;
}

module.exports = { loadSIT };
