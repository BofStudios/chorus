/**
 * Local account tests — hashing, lockout, isolation, and the properties that
 * matter more than the happy path: that the password never reaches disk and
 * that a wrong username is indistinguishable from a wrong password.
 *
 *   npm run test:auth
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'chorus-auth-test');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const electronPath = require.resolve('electron', { paths: [PROJECT] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => DATA_DIR },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal() {} }
  }
};

const auth = require('../src/main/auth');
const accounts = require('../src/main/integrations/core/accounts');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expectRefusal(name, fn, fragment) {
  try {
    await fn();
    check(name, false, 'it was allowed');
  } catch (error) {
    check(name, fragment ? error.message.includes(fragment) : true, error.message.slice(0, 50));
  }
}

const PASSWORD = 'correct-horse-42';

(async () => {
  console.log('\n--- what is refused ---');
  check('a fresh install has no accounts', auth.isFirstRun());

  await expectRefusal('a short password', () => auth.signUp({ username: 'bora', password: 'abc' }), 'at least 8');
  await expectRefusal(
    'a password from every breach list',
    () => auth.signUp({ username: 'bora', password: 'password123' }),
    'first anyone would try'
  );
  await expectRefusal(
    'a password containing the username',
    () => auth.signUp({ username: 'bora', password: 'boraborabora' }),
    'not contain your username'
  );
  await expectRefusal(
    'a username with spaces and punctuation',
    () => auth.signUp({ username: 'bad name!', password: PASSWORD }),
    'letters, numbers'
  );
  await expectRefusal(
    'a username of two characters',
    () => auth.signUp({ username: 'ab', password: PASSWORD }),
    'at least 3'
  );

  console.log('\n--- signing up ---');
  const user = await auth.signUp({ username: 'Bora', password: PASSWORD });
  check('the username is stored lowercased', user.username === 'bora');
  check('signing up signs you in', auth.isSignedIn());
  check('the install is no longer fresh', !auth.isFirstRun());
  check('identity comes from the account', auth.ownerId() === user.id);
  await expectRefusal(
    'the same username twice',
    () => auth.signUp({ username: 'bora', password: 'another-good-one' }),
    'taken'
  );

  console.log('\n--- what reaches disk ---');
  const raw = fs.readFileSync(path.join(DATA_DIR, 'data.json'), 'utf8');
  check('the password itself is nowhere on disk', !raw.includes(PASSWORD));
  const stored = JSON.parse(raw).users[0];
  check('a per-account salt was generated', Boolean(stored.salt) && stored.salt.length > 16);
  check('only a derived hash is kept', Boolean(stored.hash) && stored.hash.length > 40);

  console.log('\n--- signing in ---');
  auth.logOut();
  check('logging out ends the session', !auth.isSignedIn());

  await expectRefusal(
    'the wrong password',
    () => auth.logIn({ username: 'bora', password: 'wrong-one-here' }),
    'do not match'
  );
  await expectRefusal(
    'an account that does not exist, with the same wording',
    () => auth.logIn({ username: 'ghost', password: 'whatever-12' }),
    'do not match'
  );

  const back = await auth.logIn({ username: 'BORA', password: PASSWORD });
  check('the username is not case sensitive', back.username === 'bora');
  check('the sign-in is recorded', Boolean(back.lastLoginAt));

  console.log('\n--- changing the password ---');
  await auth.changePassword({ currentPassword: PASSWORD, newPassword: 'a-different-one-9' });
  auth.logOut();
  await expectRefusal(
    'the old password afterwards',
    () => auth.logIn({ username: 'bora', password: PASSWORD }),
    'do not match'
  );
  await auth.logIn({ username: 'bora', password: 'a-different-one-9' });
  check('the new password works', auth.isSignedIn());

  console.log('\n--- isolation between accounts ---');
  const first = auth.currentUser();
  auth.logOut();
  const second = await auth.signUp({ username: 'someone-else', password: 'second-account-77' });
  check('a second account gets a different identity', second.id !== first.id);
  check('and a different ownerId', auth.ownerId() === second.id);
  check("the second account sees none of the first's connections", accounts.list().length === 0);

  console.log('\n--- lockout ---');
  auth.logOut();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await auth.logIn({ username: 'bora', password: 'nope-nope-nope' });
    } catch {
      // expected
    }
  }
  await expectRefusal(
    'the correct password once locked out',
    () => auth.logIn({ username: 'bora', password: 'a-different-one-9' }),
    'Too many attempts'
  );

  const failed = results.filter((entry) => !entry.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nERROR:', error);
  process.exitCode = 1;
});
