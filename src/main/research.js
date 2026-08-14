const github = require('./sources/github');
const hn = require('./sources/hackernews');
const ai = require('./ai');
const db = require('./db');
const { Progress } = require('./progress');
const { getStore } = require('./store');

// One research run at a time. These pipelines are rate-limit bound, so running
// two in parallel would just make both slower and trip GitHub's secondary limits.
let current = null;

class Cancelled extends Error {
  constructor() {
    super('Research cancelled.');
    this.cancelled = true;
  }
}

function checkCancelled(run) {
  if (run.cancelled) throw new Cancelled();
}

function addEvidence(pool, login, evidence) {
  if (!login) return;
  const key = login.toLowerCase();
  const existing = pool.get(key) || { login, evidence: [] };
  existing.login = existing.login || login;
  // Cap evidence per person; after a few items it stops adding signal.
  if (existing.evidence.length < 6 && !existing.evidence.some((item) => item.url && item.url === evidence.url)) {
    existing.evidence.push(evidence);
  }
  pool.set(key, existing);
}

async function discover(run, project, progress) {
  const { analysis, settings } = project;
  const sources = settings.sources || {};
  const pool = new Map();
  const neighbourRepos = [];

  // Build the full task list up front so the sub-progress bar is honest.
  const tasks = [];
  if (sources.neighbourRepos !== false) {
    for (const query of (analysis.repoQueries || []).slice(0, 5)) tasks.push({ kind: 'repos', query });
  }
  if (sources.issueSearch !== false) {
    for (const query of (analysis.issueQueries || []).slice(0, 4)) tasks.push({ kind: 'issues', query });
  }
  if (sources.userSearch !== false) {
    for (const keyword of (analysis.keywords || []).slice(0, 3)) tasks.push({ kind: 'users', query: keyword });
  }

  let done = 0;
  const advance = (message) => {
    done += 1;
    progress.step(done, tasks.length + 1, message);
  };

  for (const task of tasks) {
    checkCancelled(run);

    if (task.kind === 'repos') {
      const repos = await github.searchRepos(task.query, { limit: 15 }).catch((error) => {
        progress.note(`Repository search failed: ${error.message}`, 'warn');
        return [];
      });
      for (const repo of repos) {
        if (repo.fullName.toLowerCase() === project.repo.fullName.toLowerCase()) continue;
        neighbourRepos.push(repo);
        if (repo.ownerType === 'User') {
          addEvidence(pool, repo.owner, {
            type: 'maintainer',
            label: `maintains ${repo.fullName} (${repo.stars}★) — ${repo.description.slice(0, 90)}`,
            url: repo.url
          });
        }
      }
      advance(`Found ${repos.length} repositories for “${task.query}”`);
    }

    if (task.kind === 'issues') {
      const authors = await github.searchIssueAuthors(task.query, { limit: 30 }).catch(() => []);
      for (const author of authors) {
        addEvidence(pool, author.login, {
          type: 'issue',
          label: `opened “${author.evidence.label}”${author.evidence.repo ? ` in ${author.evidence.repo}` : ''}`,
          url: author.evidence.url
        });
      }
      advance(`${authors.length} people opened issues matching “${task.query}”`);
    }

    if (task.kind === 'users') {
      const query = `${task.query} in:bio ${project.repo.language ? `language:${project.repo.language}` : ''} followers:>20`.trim();
      const users = await github.searchUsers(query, { limit: 25 }).catch(() => []);
      for (const user of users) {
        addEvidence(pool, user.login, {
          type: 'profile',
          label: `profile mentions “${task.query}”`,
          url: `https://github.com/${user.login}`
        });
      }
      advance(`${users.length} profiles mention “${task.query}”`);
    }

    progress.count({ discovered: pool.size });
  }

  // Contributors to the strongest neighbouring projects — the richest source,
  // so it gets its own pass rather than sharing a slot above.
  if (sources.contributors !== false && neighbourRepos.length) {
    const top = [...neighbourRepos]
      .sort((a, b) => b.stars - a.stars)
      .filter((repo) => repo.stars >= 20)
      .slice(0, settings.contributorRepos || 10);

    for (const [index, repo] of top.entries()) {
      checkCancelled(run);
      const [owner, name] = repo.fullName.split('/');
      const people = await github.contributors(owner, name, { limit: 15 });
      for (const person of people) {
        addEvidence(pool, person.login, {
          type: 'contributor',
          label: `${person.contributions} commits to ${repo.fullName}`,
          url: repo.url
        });
      }
      progress.step(
        tasks.length + (index + 1) / top.length,
        tasks.length + 1,
        `${people.length} contributors from ${repo.fullName}`
      );
      progress.count({ discovered: pool.size });
    }
  }

  return { pool, neighbourRepos };
}

function evidenceWeight(evidence) {
  const weights = { contributor: 4, maintainer: 4, issue: 3, profile: 1 };
  return evidence.reduce((total, item) => total + (weights[item.type] || 1), 0);
}

async function profile(run, project, pool, progress) {
  const { settings } = project;
  const excludeSelf = new Set([project.repo.owner.toLowerCase()]);

  let ranked = [...pool.values()]
    .filter((entry) => !excludeSelf.has(entry.login.toLowerCase()))
    .sort((a, b) => evidenceWeight(b.evidence) - evidenceWeight(a.evidence));

  if (settings.skipAlreadyContacted !== false) {
    const before = ranked.length;
    ranked = ranked.filter((entry) => !db.ledgerHas(`github:${entry.login.toLowerCase()}`));
    const skipped = before - ranked.length;
    if (skipped) progress.note(`Skipped ${skipped} people you have already contacted`, 'warn');
  }

  ranked = ranked.slice(0, settings.candidatePool || 120);
  const cutoff = Date.now() - (settings.activeWithinDays || 365) * 86400000;
  const kept = [];
  let filtered = 0;

  for (const [index, entry] of ranked.entries()) {
    checkCancelled(run);
    progress.step(index + 1, ranked.length, `Profiling @${entry.login}`);

    const person = await github.userProfile(entry.login).catch(() => null);
    if (!person) continue;
    if (settings.excludeOrganizations !== false && person.type !== 'User') {
      filtered += 1;
      continue;
    }
    if ((settings.minFollowers || 0) > person.followers) {
      filtered += 1;
      continue;
    }

    const repos = await github.userRepos(entry.login, { limit: 8 });
    const lastPush = repos[0]?.pushedAt ? Date.parse(repos[0].pushedAt) : 0;
    if (lastPush && lastPush < cutoff) {
      filtered += 1;
      continue;
    }
    if (settings.requireContactChannel && !(person.email || person.blog || person.twitter)) {
      filtered += 1;
      continue;
    }

    kept.push({ profile: person, repos, evidence: entry.evidence, lastPush });
    progress.count({ profiled: kept.length });
  }

  if (filtered) progress.note(`${filtered} filtered out on activity, type or contact rules`);
  return kept;
}

async function assess(run, project, candidates, progress) {
  const { settings } = project;
  const shortlist = candidates.slice(0, Math.min(settings.scoreLimit || 40, candidates.length));
  const passed = [];

  progress.begin('assess', `Assessing ${shortlist.length} people one by one`);

  for (const [index, candidate] of shortlist.entries()) {
    checkCancelled(run);
    progress.step(index + 1, shortlist.length, `Assessing @${candidate.profile.login}`);

    let scoring;
    try {
      scoring = await ai.scoreCandidate(project, candidate);
    } catch (error) {
      progress.note(`Could not assess @${candidate.profile.login}: ${error.message}`, 'warn');
      continue;
    }

    progress.count({ assessed: index + 1 });

    if (scoring.score < (settings.minScore ?? 55)) continue;
    passed.push({ candidate, scoring });
    progress.count({ kept: passed.length });
  }

  return passed;
}

async function draft(run, project, passed, progress) {
  progress.begin('draft', `Writing ${passed.length} drafts`);
  const targets = [];

  for (const [index, { candidate, scoring }] of passed.entries()) {
    checkCancelled(run);
    progress.step(index + 1, passed.length, `Drafting for @${candidate.profile.login}`);

    let message = { text: '', source: 'none' };
    try {
      message = await ai.draftMessage(project, candidate, scoring);
    } catch (error) {
      progress.note(`Draft failed for @${candidate.profile.login}: ${error.message}`, 'warn');
    }

    // The model is allowed to refuse when there is no honest reason to write.
    if (message.refused) {
      progress.note(`Dropped @${candidate.profile.login} — no honest angle to write about`, 'warn');
      continue;
    }

    targets.push({
      id: `github:${candidate.profile.login.toLowerCase()}`,
      login: candidate.profile.login,
      name: candidate.profile.name,
      avatar: candidate.profile.avatar,
      profileUrl: candidate.profile.url,
      bio: candidate.profile.bio,
      company: candidate.profile.company,
      location: candidate.profile.location,
      followers: candidate.profile.followers,
      email: candidate.profile.email,
      blog: candidate.profile.blog,
      twitter: candidate.profile.twitter,
      repos: candidate.repos.slice(0, 5),
      evidence: candidate.evidence,
      lastPush: candidate.lastPush,
      score: scoring.score,
      rationale: scoring.rationale,
      angle: scoring.angle,
      channel: scoring.channel,
      channelNote: scoring.channelNote,
      caution: scoring.caution,
      draft: message.text,
      draftSource: message.source,
      status: 'new',
      notes: ''
    });
  }

  return targets.sort((a, b) => b.score - a.score);
}

async function start({ repo, pitch, audience }, emit) {
  if (current && !current.finished) throw new Error('A research run is already in progress.');

  const parsed = github.parseRepo(repo);
  if (!parsed) throw new Error('Enter a repository as owner/name or a github.com URL.');

  const store = getStore();
  const settings = structuredClone(store.config.research);
  settings.skipAlreadyContacted = store.config.outreach.skipAlreadyContacted;

  const run = { cancelled: false, finished: false };
  current = run;

  const campaign = db.createCampaign({ repo: `${parsed.owner}/${parsed.repo}`, pitch, audience, settings });
  const progress = new Progress((payload) => emit({ campaignId: campaign.id, ...payload }));

  (async () => {
    try {
      progress.begin('repo', `Reading ${parsed.owner}/${parsed.repo}`);
      const info = await github.repoInfo(parsed.owner, parsed.repo);
      progress.step(1, 2, `${info.fullName} — ${info.stars}★, ${info.language || 'no language set'}`);
      const readmeText = await github.readme(parsed.owner, parsed.repo);
      progress.step(2, 2, readmeText ? `README read (${readmeText.length} chars)` : 'No README found');

      progress.begin('analyse', 'Working out who this project is actually for');
      const project = { repo: info, readme: readmeText, pitch, audience, settings };
      project.analysis = await ai.analyseProject(project);
      progress.step(1, 1, `Audience: ${(project.analysis.whoCares || []).slice(0, 3).join(' · ')}`);
      db.updateCampaign(campaign.id, { analysis: project.analysis, repoInfo: info });

      progress.begin('discover', 'Searching GitHub for people in this space');
      const { pool, neighbourRepos } = await discover(run, project, progress);
      progress.note(`${pool.size} people surfaced across all sources`);
      db.updateCampaign(campaign.id, { neighbourRepos: neighbourRepos.slice(0, 25) });

      progress.begin('discussions', 'Looking for where this is already discussed');
      let discussions = [];
      if (settings.sources?.hackernews !== false) {
        const queries = (project.analysis.hnQueries || project.analysis.keywords || []).slice(0, 3);
        discussions = queries.length ? await hn.relevantThreads(queries, { limit: 10 }).catch(() => []) : [];
        db.updateCampaign(campaign.id, { discussions });
      }
      progress.step(1, 1, `${discussions.length} related discussions found`);

      progress.begin('profile', 'Reading public profiles and recent work');
      const candidates = await profile(run, project, pool, progress);
      progress.note(`${candidates.length} passed the activity and profile filters`);

      const passed = await assess(run, project, candidates, progress);
      const targets = await draft(run, project, passed, progress);

      db.setTargets(campaign.id, targets);
      db.updateCampaign(campaign.id, {
        status: 'done',
        log: progress.log,
        stats: {
          discovered: pool.size,
          profiled: candidates.length,
          assessed: Math.min(settings.scoreLimit || 40, candidates.length),
          kept: targets.length
        }
      });

      progress.finish(
        'done',
        `Finished — ${targets.length} people worth writing to, drafts ready for your review.`
      );
    } catch (error) {
      const cancelled = Boolean(error.cancelled);
      db.updateCampaign(campaign.id, {
        status: cancelled ? 'cancelled' : 'failed',
        log: progress.log,
        error: error.message
      });
      progress.finish(cancelled ? 'cancelled' : 'error', cancelled ? 'Research cancelled.' : `Stopped: ${error.message}`);
    } finally {
      run.finished = true;
    }
  })();

  return { campaignId: campaign.id };
}

// Assess one person on demand — used by the watchlist, where candidates arrive
// from the browser extension rather than from a search.
async function assessOne({ login, campaignId }) {
  const campaign = campaignId ? db.getCampaign(campaignId) : db.listCampaigns()[0] && db.getCampaign(db.listCampaigns()[0].id);
  if (!campaign?.analysis || !campaign?.repoInfo) {
    throw new Error('Run a research campaign first — assessing someone needs the project context it produces.');
  }

  const project = {
    repo: campaign.repoInfo,
    analysis: campaign.analysis,
    pitch: campaign.pitch,
    audience: campaign.audience,
    settings: campaign.settings || {}
  };

  const person = await github.userProfile(login);
  const repos = await github.userRepos(login, { limit: 8 });
  const candidate = {
    profile: person,
    repos,
    evidence: [{ type: 'manual', label: 'added from the browser extension', url: person.url }],
    lastPush: repos[0]?.pushedAt ? Date.parse(repos[0].pushedAt) : 0
  };

  const scoring = await ai.scoreCandidate(project, candidate);
  const message = await ai.draftMessage(project, candidate, scoring);

  return {
    campaignId: campaign.id,
    id: `github:${person.login.toLowerCase()}`,
    login: person.login,
    name: person.name,
    avatar: person.avatar,
    profileUrl: person.url,
    bio: person.bio,
    followers: person.followers,
    email: person.email,
    blog: person.blog,
    twitter: person.twitter,
    repos: repos.slice(0, 5),
    evidence: candidate.evidence,
    lastPush: candidate.lastPush,
    ...scoring,
    draft: message.refused ? '' : message.text,
    refused: Boolean(message.refused),
    status: 'new'
  };
}

function cancel() {
  if (current && !current.finished) {
    current.cancelled = true;
    return true;
  }
  return false;
}

function isRunning() {
  return Boolean(current && !current.finished);
}

module.exports = { start, cancel, isRunning, assessOne };
