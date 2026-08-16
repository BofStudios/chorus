// Minimal .env loader.
//
// The app has no runtime dependencies and this is not worth adding one for.
// Values already present in the real environment win, so a shell export or a
// CI secret always beats the file on disk.
//
// The file itself is gitignored. Nothing here ever writes secrets back out.

const fs = require('fs');
const path = require('path');

let loaded = false;

function parse(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip matched surrounding quotes, but leave inner ones alone.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load .env from the app root, if one exists. Safe to call more than once. */
function load(root = path.join(__dirname, '..', '..')) {
  if (loaded) return process.env;
  loaded = true;

  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    try {
      const parsed = parse(fs.readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
      }
    } catch {
      // Absent or unreadable .env is the normal case, not an error.
    }
  }

  return process.env;
}

/** Which integration keys are present, without revealing any of them. */
function summary(keys) {
  return keys.map((key) => ({ key, set: Boolean(process.env[key] && process.env[key].trim()) }));
}

module.exports = { load, parse, summary };
