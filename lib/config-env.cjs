'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Match the app's key=value format; supplied process environment wins.
function loadProjectEnv(root, env = process.env) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2];
  }
}
module.exports = { loadProjectEnv };
