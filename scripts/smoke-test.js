/**
 * Smoke test for the discovery sources.
 *
 * Runs github.js and hackernews.js against the live APIs with a stubbed Electron,
 * so it executes under plain Node without launching the app. Use it to check that
 * an endpoint has not changed shape under you.
 *
 *   npm run test:sources
 *
 * Unauthenticated it uses ~10 of your 60 hourly GitHub requests.
 */

const os = require('os');
const path = require('path');

// Stub the parts of Electron that store.js touches at require time.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => path.join(os.tmpdir(), 'chorus-smoke-test') },
    safeStorage: { isEncryptionAvailable: () => false }
  }
};

const github = require('../src/main/sources/github');
const hn = require('../src/main/sources/hackernews');

function heading(title) {
  console.log(`\n[36m--- ${title} ---[0m`);
}

(async () => {
  heading('parseRepo');
  const inputs = [
    'BofStudios/chorus',
    'https://github.com/electron/electron',
    'https://github.com/vercel/next.js.git',
    'nonsense'
  ];
  for (const input of inputs) {
    console.log(`  ${input.padEnd(42)} -> ${JSON.stringify(github.parseRepo(input))}`);
  }

  heading('repoInfo + readme');
  const info = await github.repoInfo('sindresorhus', 'got');
  console.log(`  ${info.fullName} | ${info.language} | ${info.stars}* | ${info.topics.slice(0, 5).join(', ')}`);
  const readme = await github.readme('sindresorhus', 'got');
  console.log(`  readme: ${readme.length} chars`);

  heading('searchRepos');
  const repos = await github.searchRepos('topic:http-client stars:>200', { limit: 5 });
  for (const repo of repos) {
    console.log(`  ${repo.fullName.padEnd(34)} ${String(repo.stars).padStart(7)}* ${repo.ownerType}`);
  }
  if (!repos.length) throw new Error('searchRepos returned nothing');

  heading('contributors');
  const [owner, name] = repos[0].fullName.split('/');
  const people = await github.contributors(owner, name, { limit: 6 });
  console.log('  ' + people.map((person) => `${person.login}(${person.contributions})`).join(', '));
  if (!people.length) throw new Error('contributors returned nothing');

  heading('searchIssueAuthors');
  const authors = await github.searchIssueAuthors('http client retry in:title state:open', { limit: 5 });
  for (const author of authors) {
    console.log(`  @${author.login.padEnd(22)} ${author.evidence.label.slice(0, 58)}`);
  }

  heading('userProfile + userRepos');
  const profile = await github.userProfile(people[0].login);
  console.log(
    `  @${profile.login} | ${profile.name || '-'} | ${profile.followers} followers | email: ${profile.email || '-'}`
  );
  for (const repo of await github.userRepos(profile.login, { limit: 4 })) {
    console.log(`    ${repo.fullName.padEnd(38)} ${(repo.language || '-').padEnd(12)} ${(repo.pushedAt || '').slice(0, 10)}`);
  }

  heading('hacker news');
  for (const thread of await hn.relevantThreads(['http client', 'fetch retry'], { limit: 4 })) {
    console.log(`  ${String(thread.points).padStart(4)}p  ${thread.title.slice(0, 64)}`);
  }

  console.log('\n[32mAll sources responded as expected.[0m');
})().catch((error) => {
  console.error(`\n[31mFAILED: ${error.message}[0m`);
  process.exit(1);
});
