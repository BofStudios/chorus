// Is this repository ready to be promoted?
//
// Not a judgement about code. A judgement about whether a stranger who lands on
// the page can tell what the thing is and why they should care — which is the
// only thing that decides whether promoting it is worth anyone's time.
//
// Shared by two callers: the OAuth-connected GitHub provider, and the path the
// browser extension uses, which needs no OAuth app at all because listing
// someone's public repositories needs no permission.

const CHECKS = [
  {
    id: 'description',
    weight: 30,
    passes: (repo) => Boolean(repo.description && repo.description.trim()),
    blocker: 'No description — nobody can tell what it is without reading the code.',
    strength: 'Has a description'
  },
  {
    id: 'topics',
    weight: 20,
    passes: (repo) => (repo.topics || []).length > 0,
    blocker: 'No topics — it will not surface when people browse GitHub by subject.',
    strength: (repo) => `${repo.topics.length} topics`
  },
  {
    id: 'licence',
    weight: 15,
    passes: (repo) => Boolean(repo.licence),
    blocker: 'No licence — companies and cautious developers will not touch it.',
    strength: (repo) => `${repo.licence} licensed`
  },
  {
    id: 'readme',
    weight: 15,
    // Size is a crude proxy, but a README under a few hundred bytes is a title
    // and nothing else, which is the case worth catching.
    passes: (repo) => repo.readmeBytes === null || repo.readmeBytes >= 400,
    blocker: 'README is barely there — a title is not an explanation.',
    strength: 'README explains the project'
  },
  {
    id: 'activity',
    weight: 20,
    passes: (repo) => daysSince(repo.pushedAt) <= 180,
    blocker: (repo) =>
      `No commits in ${Math.floor(daysSince(repo.pushedAt) / 30)} months — it reads as abandoned.`,
    strength: 'Actively worked on'
  }
];

function daysSince(iso) {
  if (!iso) return 9999;
  const time = Date.parse(iso);
  if (!time || Number.isNaN(time)) return 9999;
  return Math.floor((Date.now() - time) / 86400000);
}

function resolve(value, repo) {
  return typeof value === 'function' ? value(repo) : value;
}

/**
 * @param {object} repo  { name, fullName, description, topics, licence, pushedAt,
 *                         stars, url, language, homepage, readmeBytes }
 */
function score(repo) {
  let points = 0;
  const blockers = [];
  const strengths = [];

  for (const check of CHECKS) {
    if (check.passes(repo)) {
      points += check.weight;
      strengths.push(resolve(check.strength, repo));
    } else {
      blockers.push(resolve(check.blocker, repo));
    }
  }

  return {
    ...repo,
    readiness: points,
    readyToPromote: points >= 70,
    blockers,
    strengths
  };
}

/** Score a list and sort the most promotable first. */
function rank(repos) {
  return repos.map(score).sort((a, b) => b.readiness - a.readiness || (b.stars || 0) - (a.stars || 0));
}

/**
 * The offer Chorus makes once it can see someone's repositories: what is ready,
 * what is nearly ready and what to fix first, said plainly.
 */
function suggest(repos) {
  const ranked = rank(repos);
  const ready = ranked.filter((repo) => repo.readyToPromote);
  const nearly = ranked.filter((repo) => !repo.readyToPromote && repo.readiness >= 40);
  const notYet = ranked.filter((repo) => repo.readiness < 40);

  let summary;
  if (!ranked.length) {
    summary = 'No public repositories found on this account.';
  } else if (ready.length) {
    summary =
      `${ready.length} of ${ranked.length} repositories are ready to promote. ` +
      `Chorus can research who would care about ${ready[0].name} and draft the messages.`;
  } else if (nearly.length) {
    summary =
      `None are quite ready, but ${nearly.length} are close. ${nearly[0].name} needs ` +
      `${nearly[0].blockers.length} small fixes first — usually minutes of work that decide ` +
      'whether promotion is worth doing at all.';
  } else {
    summary =
      'None of these are ready to promote yet. A description and a few topics are what turn a ' +
      'repository into something a stranger can evaluate.';
  }

  return {
    total: ranked.length,
    summary,
    ready: ready.map((repo) => ({ ...repo, pitch: `${repo.name} — ${repo.description}` })),
    nearlyReady: nearly.map((repo) => ({ ...repo, fixFirst: repo.blockers.slice(0, 2) })),
    notReady: notYet.map((repo) => ({ name: repo.name, fullName: repo.fullName, blockers: repo.blockers }))
  };
}

module.exports = { score, rank, suggest, CHECKS, daysSince };
