/**
 * Builds the Chrome Web Store upload zip.
 *
 *   npm run pack:extension
 *
 * Uses the 7-Zip binary that ships with electron-builder so entries are written
 * with forward slashes — Chrome rejects archives containing backslash paths.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist-extension');
const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const REQUIRED = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

const missing = REQUIRED.filter((file) => !fs.existsSync(path.join(EXT, file)));
if (missing.length) {
  console.error(`Missing from extension/: ${missing.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `chorus-companion-${manifest.version}.zip`);
fs.rmSync(out, { force: true });

if (!fs.existsSync(SEVEN_ZIP)) {
  console.error('7za.exe not found — run npm install first.');
  process.exit(1);
}

execFileSync(SEVEN_ZIP, ['a', '-tzip', '-bso0', '-bsp0', out, './*'], { cwd: EXT });

// Chrome refuses archives whose entry names contain backslashes, so verify.
const raw = fs.readFileSync(out).toString('latin1');
if (/icons\\/.test(raw)) {
  console.error('Archive contains backslash paths — Chrome would reject it.');
  process.exit(1);
}

console.log(`${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
console.log(`version ${manifest.version} · ${REQUIRED.length} required files present`);
console.log('\nUpload at https://chrome.google.com/webstore/devconsole');
console.log('Listing copy is in STORE-LISTING.md');
