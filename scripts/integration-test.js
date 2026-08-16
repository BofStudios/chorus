/**
 * Integration layer tests — capability enforcement, ownership isolation,
 * OAuth state handling, token secrecy and rate limiting.
 *
 *   npm run test:integrations
 *
 * Runs against a throwaway data directory with a stubbed Electron, so no real
 * credentials, no network calls and no effect on your real accounts.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'chorus-integration-test');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.CHORUS_DEV_MOCK = '1';

const opened = [];
const electronPath = require.resolve('electron', { paths: [PROJECT] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => DATA_DIR },
    // Exercise the plaintext fallback path deliberately; the encrypted path is
    // the same code with safeStorage doing the work.
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: (url) => opened.push(url) }
  }
};

const integrations = require('../src/main/integrations');
const accounts = require('../src/main/integrations/core/accounts');
const vault = require('../src/main/integrations/core/vault');
const audit = require('../src/main/integrations/core/audit');
const oauth = require('../src/main/integrations/core/oauth');
const registry = require('../src/main/integrations/core/registry');
const { CODES } = require('../src/main/integrations/core/errors');
const { STATUS } = require('../src/main/integrations/core/capabilities');
const db = require('../src/main/db');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expectError(name, code, fn) {
  try {
    await fn();
    check(name, false, 'no error was thrown');
  } catch (error) {
    check(name, error.code === code, `got ${error.code || error.message}`);
  }
}

(async () => {
  console.log('\n--- capability matrices are honest ---');

  const instagram = registry.require('instagram');
  const igSend = instagram.declaredCapabilities().sendMessages;
  check('Instagram declares sending reply-only, not open', igSend.status === STATUS.CONDITIONAL);
  check('Instagram names the 24-hour window', igSend.reason.includes('24-hour'));
  check('Instagram says outreach is impossible', igSend.reason.includes('outreach'));

  const linkedin = registry.require('linkedin');
  check(
    'LinkedIn declares sending unsupported',
    linkedin.declaredCapabilities().sendMessages.status === STATUS.UNSUPPORTED
  );

  const google = registry.require('google');
  check(
    'Gmail declares sending conditional, not unsupported',
    google.declaredCapabilities().sendMessages.status === STATUS.CONDITIONAL
  );

  const x = registry.require('x');
  check(
    'X declares sending conditional on tier',
    x.declaredCapabilities().sendMessages.reason.includes('paid')
  );

  console.log('\n--- unsupported capabilities are refused before any request ---');

  const fakeAccount = { id: 'nope', scopes: ['instagram_business_basic'] };
  await expectError('Instagram send without the messaging scope is denied', CODES.PERMISSION_DENIED, () =>
    instagram.sendMessage(fakeAccount, { recipient: 'someone', body: 'hi' })
  );
  await expectError('Instagram search is rejected', CODES.CAPABILITY_UNSUPPORTED, () =>
    instagram.search(fakeAccount, { query: 'x' })
  );
  await expectError('LinkedIn sendMessage is rejected', CODES.CAPABILITY_UNSUPPORTED, () =>
    linkedin.sendMessage({ id: 'nope', scopes: ['profile'] }, { recipient: 'a', body: 'b' })
  );

  console.log('\n--- missing scopes downgrade a supported capability ---');

  const scopeless = { id: 'nope', scopes: [] };
  await expectError('Reddit send without privatemessages is denied', CODES.PERMISSION_DENIED, () =>
    registry.require('reddit').sendMessage(scopeless, { recipient: 'u/x', body: 'hi' })
  );
  const resolved = registry.require('reddit').capabilitiesFor(scopeless);
  check('missing scope is reported as such', resolved.sendMessages.status === STATUS.MISSING_SCOPE);

  console.log('\n--- the channels that do work ---');

  const reddit = registry.require('reddit');
  check('Reddit can post', reddit.declaredCapabilities().post.status === STATUS.SUPPORTED);
  check('Reddit can comment', reddit.declaredCapabilities().comments.status === STATUS.SUPPORTED);
  check('Reddit requests the submit scope', reddit.oauth.scopes.includes('submit'));

  check(
    'Instagram can publish with a Professional account',
    instagram.declaredCapabilities().post.status === STATUS.CONDITIONAL
  );
  check(
    'Instagram can manage comments',
    instagram.declaredCapabilities().comments.status === STATUS.CONDITIONAL
  );
  check(
    'Instagram requests the publishing scope',
    instagram.oauth.scopes.includes('instagram_business_content_publish')
  );

  await expectError('Reddit post without submit scope is denied', CODES.PERMISSION_DENIED, () =>
    reddit.post({ id: 'nope', scopes: ['identity'] }, { subreddit: 'test', title: 'hi' })
  );
  await expectError('Instagram post without publish scope is denied', CODES.PERMISSION_DENIED, () =>
    instagram.post({ id: 'nope', scopes: ['instagram_business_basic'] }, { imageUrl: 'https://x/y.jpg' })
  );

  console.log('\n--- OAuth state ---');

  const notConfigured = registry.require('x');
  await expectError('connecting an unconfigured provider fails clearly', CODES.NOT_CONFIGURED, async () => {
    integrations.setCallbackPort(7801);
    return integrations.beginConnection('x');
  });

  registry.setCredential('X_CLIENT_ID', 'test-client-id');
  const started = integrations.beginConnection('x');
  check('authorization URL was opened in the browser', opened.length === 1);
  check('PKCE challenge is present', started.url.includes('code_challenge=') && started.url.includes('S256'));
  check('state is present', started.url.includes('state='));
  check('redirect URI is loopback', started.redirectUri.startsWith('http://127.0.0.1:7801/oauth/callback/x'));
  check('client secret is absent from the authorize URL', !started.url.includes('secret'));

  await expectError('a forged state is rejected', CODES.INVALID_STATE, () =>
    integrations.completeConnection({ providerId: 'x', code: 'abc', state: 'forged-state' })
  );

  const replay = integrations.beginConnection('x');
  oauth.consumeState(replay.state);
  await expectError('a replayed state is rejected', CODES.INVALID_STATE, () =>
    integrations.completeConnection({ providerId: 'x', code: 'abc', state: replay.state })
  );

  await expectError('a provider-side denial is surfaced', CODES.AUTH_REQUIRED, () =>
    integrations.completeConnection({ providerId: 'x', error: 'access_denied' })
  );

  console.log('\n--- connected accounts ---');

  const mock = registry.require('mock');
  const connected = mock.beginConnection();
  const account = accounts.find(connected.accountId);
  check('mock account was created', Boolean(account));
  check('mock account is flagged as mock', account.isMock === true);
  check('mock account has an owner', account.ownerId === db.ownerId());

  const client = accounts.toClient(account);
  check('client shape carries no access token', !('accessToken' in client));
  check('client shape carries no refresh token', !('refreshToken' in client));
  check('client shape carries no token object', !JSON.stringify(client).includes('mock-token'));

  const overview = integrations.overview();
  check('overview exposes no secrets', !JSON.stringify(overview).includes('test-client-id'));
  check('overview lists every provider', overview.providers.length >= 5);
  check(
    'overview marks unconfigured providers',
    overview.providers.some((entry) => entry.configured === false)
  );

  console.log('\n--- ownership isolation ---');

  const otherOwner = 'someone-elses-owner-id';
  await expectError('another user cannot use this account', CODES.OWNERSHIP, async () =>
    accounts.requireOwned(account.id, otherOwner)
  );
  await expectError('another user cannot read credentials', CODES.OWNERSHIP, async () =>
    accounts.credentials(account.id, otherOwner)
  );
  await expectError('an unknown account id is rejected', CODES.NOT_CONNECTED, async () =>
    accounts.requireOwned('made-up-id')
  );

  console.log('\n--- sending through the mock ---');

  const payload = await mock.createMessage(account, { recipient: '@someone', body: 'hello there' });
  const sendResult = await mock.sendMessage(account, payload);
  check('mock send returns a mock-prefixed id', sendResult.providerMessageId.startsWith('mock-'));
  check('mock send does not claim delivery', sendResult.delivered === false);

  await expectError('an empty message is refused', CODES.PROVIDER_ERROR, () =>
    mock.createMessage(account, { recipient: '@a', body: '   ' })
  );
  await expectError('a missing recipient is refused', CODES.INVALID_RECIPIENT, () =>
    mock.createMessage(account, { recipient: '', body: 'hi' })
  );

  console.log('\n--- disconnect leaves nothing usable ---');

  check('vault holds the token before disconnect', vault.has(account.id));
  await integrations.disconnect(account.id);
  check('vault entry is gone after disconnect', !vault.has(account.id));
  check('account record is gone after disconnect', !accounts.find(account.id));

  console.log('\n--- audit log ---');

  const log = audit.list({ limit: 50 });
  check('connection was audited', log.some((entry) => entry.event === 'account.connected'));
  check('disconnection was audited', log.some((entry) => entry.event === 'account.disconnected'));
  check('ownership denial was audited', log.some((entry) => entry.event === 'action.denied'));
  const logText = JSON.stringify(log);
  check('audit log contains no tokens', !logText.includes('mock-token'));
  check('audit log contains no client id', !logText.includes('test-client-id'));

  console.log('\n--- the tool catalogue ---');

  const tools = require('../src/main/integrations/core/tools');
  const catalogue = tools.catalogue();
  check('tools are named and typed', catalogue.length >= 10);
  check('Gmail send is in the catalogue', catalogue.some((tool) => tool.slug === 'GMAIL_SEND_EMAIL'));
  check('Reddit post is in the catalogue', catalogue.some((tool) => tool.slug === 'REDDIT_SUBMIT_POST'));
  check(
    'Instagram publish is in the catalogue',
    catalogue.some((tool) => tool.slug === 'INSTAGRAM_PUBLISH_MEDIA')
  );
  check(
    'there is no Instagram send-message tool',
    !catalogue.some((tool) => tool.slug.startsWith('INSTAGRAM_SEND'))
  );
  check(
    'there is no LinkedIn tool at all',
    !catalogue.some((tool) => tool.provider === 'linkedin')
  );
  check('the catalogue exposes no handlers', !JSON.stringify(catalogue).includes('function'));

  console.log('\n--- argument validation ---');

  const gmail = tools.get('GMAIL_SEND_EMAIL');
  try {
    tools.validate(gmail, { to: 'not-an-email', subject: 'x', body: 'y' });
    check('a malformed address is rejected', false);
  } catch (error) {
    check('a malformed address is rejected', error.message.includes('email address'));
  }
  try {
    tools.validate(gmail, { to: 'a@b.co', subject: 'x', body: 'y', sneaky: 'extra' });
    check('an invented parameter is rejected', false);
  } catch (error) {
    check('an invented parameter is rejected', error.message.includes('not a parameter'));
  }
  try {
    tools.validate(gmail, { to: 'a@b.co', body: 'y' });
    check('a missing required field is rejected', false);
  } catch (error) {
    check('a missing required field is rejected', error.message.includes('required'));
  }

  console.log('\n--- the action router ---');

  const router = require('../src/main/integrations/core/router');
  const mockAccount = registry.require('mock').beginConnection();

  await expectError('an unknown tool is refused', CODES.CAPABILITY_UNSUPPORTED, () =>
    router.execute('MADE_UP_TOOL', { connectedAccountId: mockAccount.accountId, arguments: {} })
  );
  // Re-home the record so it belongs to somebody else, then confirm the router
  // refuses it before it can reach the provider-match check.
  const record = accounts.find(mockAccount.accountId);
  const realOwner = record.ownerId;
  record.ownerId = 'a-different-user';
  await expectError('an account owned by someone else is refused', CODES.OWNERSHIP, () =>
    router.execute('REDDIT_SUBMIT_POST', {
      connectedAccountId: mockAccount.accountId,
      arguments: { subreddit: 'test', title: 'hi' }
    })
  );
  record.ownerId = realOwner;

  const mismatch = await router
    .execute('REDDIT_SUBMIT_POST', {
      connectedAccountId: mockAccount.accountId,
      arguments: { subreddit: 'test', title: 'hi' }
    })
    .then(() => null)
    .catch((error) => error);
  check('a tool cannot run on another provider’s account', mismatch?.code === CODES.PROVIDER_ERROR);

  const dry = await router.check('REDDIT_SUBMIT_POST', {
    connectedAccountId: mockAccount.accountId,
    arguments: { subreddit: 'test', title: 'hi' }
  });
  check('a dry run reports the mismatch without acting', dry.ok === false);

  const actions = router.availableActions();
  const igSendAction = actions.find((action) => action.slug === 'INSTAGRAM_PUBLISH_MEDIA');
  check('unavailable actions explain themselves', igSendAction && !igSendAction.available && igSendAction.reason);
  check(
    'actions never carry credentials',
    !JSON.stringify(actions).includes('token')
  );

  await integrations.disconnect(mockAccount.accountId);

  console.log('\n--- rate limiting ---');

  const limiter = registry.require('reddit').limiter;
  const waitBefore = limiter.waitFor('sendMessages');
  limiter.penalise(5000);
  check('a 429 parks the provider', limiter.cooldownRemaining() > 4000);
  check('wait time grows after a penalty', limiter.waitFor('sendMessages') > waitBefore);

  const failed = results.filter((entry) => !entry.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nERROR:', error);
  process.exitCode = 1;
});
