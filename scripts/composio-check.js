/**
 * Composio connectivity check — runs against the live API through the app's own
 * provider, not curl, so it proves the wiring rather than the service.
 *
 *   npm run composio:check              list toolkits and run a no-auth tool
 *   npm run composio:check -- gmail     also start a connection for a toolkit
 *
 * Needs COMPOSIO_API_KEY in the environment or in .env (which is gitignored).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT = path.join(__dirname, '..');
require('../src/main/env').load(PROJECT);

const DATA_DIR = path.join(os.tmpdir(), 'chorus-composio-check');
fs.mkdirSync(DATA_DIR, { recursive: true });

const electronPath = require.resolve('electron', { paths: [PROJECT] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => DATA_DIR },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: (url) => console.log(`\n  would open: ${url}`) }
  }
};

const registry = require('../src/main/integrations/core/registry');
require('../src/main/integrations/providers/composio');

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

(async () => {
  const composio = registry.require('composio');
  const wanted = process.argv[2];

  if (!process.env.COMPOSIO_API_KEY) {
    console.error('\nCOMPOSIO_API_KEY is not set. Put it in .env or export it, then run again.');
    process.exitCode = 1;
    return;
  }

  console.log('\n--- reachable toolkits ---');
  const toolkits = await composio.listToolkits({ limit: 500 });
  const noAuth = toolkits.filter((toolkit) => !toolkit.needsAuth);
  console.log(`  ${toolkits.length} toolkits, ${noAuth.length} of them usable without connecting an account`);
  for (const toolkit of noAuth.slice(0, 6)) {
    console.log(`  ${dim('·')} ${toolkit.slug.padEnd(18)} ${toolkit.toolCount ?? '?'} tools`);
  }

  console.log('\n--- a real tool call, no account needed ---');
  const result = await composio.executeTool('HACKERNEWS_SEARCH_POSTS', {
    arguments: { query: 'show hn desktop app', size: 3 }
  });
  const hits = result?.results || result?.hits || [];
  console.log(`  ${green('HACKERNEWS_SEARCH_POSTS')} returned ${Array.isArray(hits) ? hits.length : 0} results`);
  for (const hit of (Array.isArray(hits) ? hits : []).slice(0, 3)) {
    console.log(`  ${dim('·')} ${(hit.title || hit.story_title || '').slice(0, 68)}`);
  }

  console.log('\n--- capability discovery, read from the live tool list ---');
  for (const slug of ['gmail', 'reddit', 'instagram']) {
    try {
      const { capabilities } = await composio.toolkitCapabilities(slug);
      const send = capabilities.sendMessages;
      const post = capabilities.post;
      console.log(
        `  ${slug.padEnd(10)} send: ${send.status === 'supported' ? green('yes') : 'no'}   ` +
          `post: ${post.status === 'supported' ? green('yes') : 'no'}` +
          (send.status === 'supported' ? `   ${dim(send.tool)}` : '')
      );
    } catch (error) {
      console.log(`  ${slug.padEnd(10)} could not read: ${error.message}`);
    }
  }

  if (wanted) {
    console.log(`\n--- starting a connection for ${wanted} ---`);
    const connection = await composio.initiateConnection({ toolkitSlug: wanted });
    console.log(`  connection id: ${connection.connectedAccountId}`);
    console.log(`  status:        ${connection.status}`);
    console.log(`\n  Authorise it here:\n  ${connection.redirectUrl}\n`);
    console.log('  Then run:  npm run composio:check -- ' + wanted + ' --wait');

    if (process.argv.includes('--wait')) {
      console.log('  waiting for the authorisation to complete…');
      const active = await composio.pollConnection(connection.connectedAccountId);
      console.log(`  ${green('connected')} — ${active.toolkit}`);
    }
  } else {
    console.log('\n' + dim('  Pass a toolkit slug to start a connection, e.g. npm run composio:check -- gmail'));
  }

  console.log('');
})().catch((error) => {
  console.error(`\n${error.code ? `[${error.code}] ` : ''}${error.message}\n`);
  process.exitCode = 1;
});
