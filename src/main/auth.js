// Local accounts.
//
// Username and password, no email, no server. Chorus stores research, drafts and
// tokens for connected accounts; on a shared machine those should not all be
// visible to whoever opens the app.
//
// The password is never stored. What is stored is scrypt(password, salt) — a
// deliberately slow derivation, so a stolen data.json cannot be brute-forced at
// speed. Node ships scrypt, so this needs no dependency.
//
// Signing in also decides identity: each account gets its own ownerId, and every
// connected social account is stamped with it. The ownership checks that already
// guard the action router stop being theoretical the moment there are two users.

const crypto = require('crypto');
const db = require('./db');

// OWASP's floor for scrypt. Roughly 100ms on a normal laptop — slow enough to
// matter to an attacker, fast enough not to matter when signing in.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIN_PASSWORD = 8;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// The handful that appear at the top of every breach corpus. Not a policy that
// nags about symbols — just a refusal to accept the passwords that are tried
// first, always.
const OBVIOUS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyui', 'letmein1', 'iloveyou', 'admin123', 'welcome1',
  'chorus123', 'abc12345', '11111111', '00000000'
]);

// Session lives in memory only. Closing the app signs you out, which is the
// behaviour people expect from something holding their credentials.
let session = null;

function users() {
  return db.collection('users');
}

function normalise(username) {
  return String(username || '').trim().toLowerCase();
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function validateUsername(username) {
  const clean = normalise(username);
  if (clean.length < 3) return 'Pick a username of at least 3 characters.';
  if (clean.length > 32) return 'Usernames cannot be longer than 32 characters.';
  if (!/^[a-z0-9._-]+$/.test(clean)) {
    return 'Usernames can use letters, numbers, dots, dashes and underscores.';
  }
  return null;
}

function validatePassword(password, username) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (value.length > 200) return 'That password is longer than 200 characters.';
  if (OBVIOUS.has(value.toLowerCase())) return 'That password is one of the first anyone would try.';
  if (username && value.toLowerCase().includes(normalise(username))) {
    return 'The password should not contain your username.';
  }
  return null;
}

function toClient(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

/** True when nobody has signed up yet — the app shows sign-up rather than log-in. */
function isFirstRun() {
  return users().length === 0;
}

function findUser(username) {
  const clean = normalise(username);
  return users().find((user) => user.username === clean) || null;
}

async function signUp({ username, password, displayName }) {
  const usernameProblem = validateUsername(username);
  if (usernameProblem) throw new Error(usernameProblem);

  const passwordProblem = validatePassword(password, username);
  if (passwordProblem) throw new Error(passwordProblem);

  const clean = normalise(username);
  if (findUser(clean)) throw new Error('That username is taken.');

  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt);

  const user = {
    id: crypto.randomUUID(),
    username: clean,
    displayName: (displayName || '').trim() || clean,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    failedAttempts: 0,
    lockedUntil: null
  };

  users().push(user);
  db.persist();

  session = { userId: user.id, since: Date.now() };
  return toClient(user);
}

async function logIn({ username, password }) {
  const user = findUser(username);

  // Same message and roughly the same work whether or not the user exists, so
  // this cannot be used to discover which usernames are real.
  const genericFailure = 'That username and password do not match.';

  if (!user) {
    await derive(String(password || ''), crypto.randomBytes(16));
    throw new Error(genericFailure);
  }

  if (user.lockedUntil && Date.now() < user.lockedUntil) {
    const minutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw new Error(`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }

  const attempt = await derive(String(password || ''), Buffer.from(user.salt, 'base64'));
  const stored = Buffer.from(user.hash, 'base64');

  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a mismatch rather than returning false.
  const matches = attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);

  if (!matches) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    if (user.failedAttempts >= MAX_ATTEMPTS) {
      user.lockedUntil = Date.now() + LOCKOUT_MS;
      user.failedAttempts = 0;
    }
    db.persist();
    throw new Error(genericFailure);
  }

  user.failedAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date().toISOString();
  db.persist();

  session = { userId: user.id, since: Date.now() };
  return toClient(user);
}

async function changePassword({ currentPassword, newPassword }) {
  const user = requireUserRecord();

  const current = await derive(String(currentPassword || ''), Buffer.from(user.salt, 'base64'));
  const stored = Buffer.from(user.hash, 'base64');
  if (current.length !== stored.length || !crypto.timingSafeEqual(current, stored)) {
    throw new Error('The current password is wrong.');
  }

  const problem = validatePassword(newPassword, user.username);
  if (problem) throw new Error(problem);

  const salt = crypto.randomBytes(16);
  user.salt = salt.toString('base64');
  user.hash = (await derive(newPassword, salt)).toString('base64');
  db.persist();
  return true;
}

function logOut() {
  session = null;
  return true;
}

function currentUser() {
  if (!session) return null;
  const user = users().find((entry) => entry.id === session.userId);
  return toClient(user);
}

function requireUserRecord() {
  if (!session) throw new Error('Sign in first.');
  const user = users().find((entry) => entry.id === session.userId);
  if (!user) {
    session = null;
    throw new Error('That account no longer exists.');
  }
  return user;
}

/**
 * The identity every connected account is stamped with. Falls back to the
 * installation id so a database written before accounts existed keeps working.
 */
function ownerId() {
  return session ? session.userId : db.ownerId();
}

function isSignedIn() {
  return Boolean(session);
}

function listUsers() {
  return users().map((user) => ({ username: user.username, displayName: user.displayName }));
}

module.exports = {
  isFirstRun,
  signUp,
  logIn,
  logOut,
  changePassword,
  currentUser,
  isSignedIn,
  ownerId,
  listUsers,
  validateUsername,
  validatePassword,
  MIN_PASSWORD
};
