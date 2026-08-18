// GitHub — connected as an account, not just a research source.
//
// Chorus already reads GitHub anonymously to find people. Connecting an account
// turns that around: it can now see *your* repositories and work out which ones
// are worth promoting, which is the question most maintainers actually have.
//
// The promotion suggestion is the point. A repo with no README, no description
// and no topics is not ready to be promoted — telling someone that is more
// useful than dutifully generating outreach for a project nobody could
// understand if they arrived at it.
//
// OAuth via the device-independent authorization code flow with PKCE.
// Docs: https://docs.github.com/en/apps/oauth-apps

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional, unsupported } = require('../core/capabilities');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const API = 'https://api.github.com';

class GitHubProvider extends SocialProvider {
  constructor() {
    super({
      id: 'github',
      label: 'GitHub',
      docs: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps',
      sdk: 'https://github.com/octokit/octokit.js',
      notes:
        'Connect your GitHub account and Chorus can read your own repositories, judge which are ready to promote, and open discussions or issues where a conversation is genuinely welcome. It does not have a direct-message API — GitHub has no such thing — so outreach here means participating in public threads, which is how the platform works anyway.',
      credentials: {
        required: ['GITHUB_CLIENT_ID'],
        optional: ['GITHUB_CLIENT_SECRET'],
        clientId: 'GITHUB_CLIENT_ID',
        clientSecret: 'GITHUB_CLIENT_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: ['read:user', 'public_repo'],
        scopeSeparator: ' '
      },
      limits: {
        perMinute: 60,
        burst: 10,
        perAction: { comments: { perMinute: 3, burst: 2 }, post: { perMinute: 2, burst: 1 } }
      },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['read:user'] }),
        [CAPABILITY.SEARCH]: supported({ scopes: ['read:user'] }),

        // GitHub has no DM. Saying so plainly is better than a capability that
        // exists on paper and fails at send time.
        [CAPABILITY.SEND_MESSAGES]: unsupported(
          'GitHub has no private messaging API. Reaching someone here means commenting where the conversation already is.'
        ),
        [CAPABILITY.READ_MESSAGES]: unsupported('GitHub has no private messaging API.'),

        [CAPABILITY.COMMENTS]: conditional(
          'Comments on issues and discussions in repositories you can write to. Off-topic promotion in someone else’s issue tracker is the fastest way to be blocked — Chorus rate limits this heavily.',
          { scopes: ['public_repo'], docs: 'https://docs.github.com/en/rest/issues/comments' }
        ),
        [CAPABILITY.POST]: conditional(
          'Opens an issue or discussion. Only where the project invites it.',
          { scopes: ['public_repo'], docs: 'https://docs.github.com/en/rest/issues/issues' }
        )
      }
    });
  }

  async #call(accessToken, path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Chorus/0.1'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new IntegrationError(CODES.NETWORK_ERROR, { provider: this.id, cause: error });
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = fromResponse(this.id, res.status, payload, res.headers);
      if (error.code === CODES.RATE_LIMITED) this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    return payload;
  }

  async getAccount({ accessToken }) {
    const me = await this.#call(accessToken, '/user');
    return {
      id: String(me.id),
      username: me.login ? `@${me.login}` : '',
      displayName: me.name || me.login || '',
      avatar: me.avatar_url || '',
      metadata: { login: me.login, publicRepos: me.public_repos, followers: me.followers }
    };
  }

  async _getProfile(account) {
    const { accessToken } = await require('../index').authorise(account.id);
    const me = await this.#call(accessToken, '/user');
    return {
      platformUserId: String(me.id),
      username: `@${me.login}`,
      displayName: me.name || me.login,
      bio: me.bio || '',
      avatar: me.avatar_url || '',
      profileUrl: me.html_url,
      followers: me.followers
    };
  }

  /**
   * Your own repositories, with a readiness verdict on each.
   *
   * The score is not about code quality — Chorus cannot judge that. It measures
   * whether a stranger arriving at the repo could tell what it is and why they
   * should care, which is the only thing that determines whether promoting it
   * is worth anyone's time.
   */
  async listOwnRepos(account, { limit = 30 } = {}) {
    const { accessToken } = await require('../index').authorise(account.id);
    const repos = await this.#call(accessToken, '/user/repos', {
      query: { sort: 'pushed', direction: 'desc', per_page: Math.min(limit, 100), affiliation: 'owner' }
    });

    if (!Array.isArray(repos)) return [];

    return repos
      .filter((repo) => !repo.fork && !repo.archived && !repo.private)
      .map((repo) => {
        const blockers = [];
        const strengths = [];

        if (!repo.description) blockers.push('no description — a stranger cannot tell what it is');
        else strengths.push('has a description');

        if (!repo.topics || repo.topics.length === 0) {
          blockers.push('no topics — nobody will find it by browsing');
        } else {
          strengths.push(`${repo.topics.length} topics`);
        }

        if (!repo.license) blockers.push('no licence — people will not build on it');
        else strengths.push(`${repo.license.spdx_id} licensed`);

        if (!repo.homepage) blockers.push('no homepage or demo link');

        const daysSincePush = repo.pushed_at
          ? Math.floor((Date.now() - Date.parse(repo.pushed_at)) / 86400000)
          : 9999;
        if (daysSincePush > 180) {
          blockers.push(`no commits in ${Math.floor(daysSincePush / 30)} months — it will read as abandoned`);
        } else {
          strengths.push('actively worked on');
        }

        // Weighted so that "nobody can tell what this is" outranks cosmetics.
        const readiness = Math.max(
          0,
          100 -
            (repo.description ? 0 : 30) -
            (repo.topics?.length ? 0 : 20) -
            (repo.license ? 0 : 15) -
            (repo.homepage ? 0 : 10) -
            (daysSincePush > 180 ? 25 : 0)
        );

        return {
          fullName: repo.full_name,
          name: repo.name,
          description: repo.description || '',
          url: repo.html_url,
          language: repo.language || '',
          topics: repo.topics || [],
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          openIssues: repo.open_issues_count,
          pushedAt: repo.pushed_at,
          licence: repo.license?.spdx_id || '',
          homepage: repo.homepage || '',
          readiness,
          readyToPromote: readiness >= 70,
          blockers,
          strengths
        };
      })
      .sort((a, b) => b.readiness - a.readiness || b.stars - a.stars);
  }

  /**
   * The suggestion Chorus offers once GitHub is connected: here is what you
   * have, here is what is ready, here is what to fix first on the rest.
   */
  async promotionSuggestions(account, { limit = 30 } = {}) {
    const repos = await this.listOwnRepos(account, { limit });
    const ready = repos.filter((repo) => repo.readyToPromote);
    const nearly = repos.filter((repo) => !repo.readyToPromote && repo.readiness >= 40);

    return {
      total: repos.length,
      ready: ready.map((repo) => ({
        ...repo,
        pitch: `${repo.name} — ${repo.description}`,
        why: repo.strengths.join(', ')
      })),
      nearlyReady: nearly.map((repo) => ({
        ...repo,
        fixFirst: repo.blockers.slice(0, 2)
      })),
      // Honest summary rather than an encouraging one.
      summary: ready.length
        ? `${ready.length} of your ${repos.length} repositories are ready to promote.`
        : repos.length
          ? `None of your ${repos.length} repositories are ready yet. The usual blocker is a missing description or topics — a few minutes of work that decides whether promotion is worth doing at all.`
          : 'No public repositories found on this account.'
    };
  }

  async _search(account, { query, limit = 10 }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const data = await this.#call(accessToken, '/search/issues', {
      query: { q: query, per_page: Math.min(limit, 50), sort: 'updated' }
    });
    return (data.items || []).map((item) => ({
      platform: 'github',
      platformUserId: String(item.user?.id || ''),
      username: item.user?.login ? `@${item.user.login}` : '',
      displayName: item.user?.login || '',
      profileUrl: item.user?.html_url || '',
      evidence: { type: 'issue', text: item.title, url: item.html_url }
    }));
  }

  /** Comment on an issue or discussion. Public and attributable, by design. */
  async _comment(account, { owner, repo, issueNumber, text }) {
    const { accessToken } = await require('../index').authorise(account.id);
    if (!owner || !repo || !issueNumber) {
      throw new IntegrationError(CODES.INVALID_RECIPIENT, {
        provider: this.id,
        message: 'Commenting needs the owner, repository and issue number.'
      });
    }
    const result = await this.#call(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { method: 'POST', body: { body: text } }
    );
    return { providerMessageId: String(result.id || ''), url: result.html_url || '' };
  }

  async _post(account, { owner, repo, title, body }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const result = await this.#call(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      { method: 'POST', body: { title, body } }
    );
    return { providerMessageId: String(result.id || ''), url: result.html_url || '' };
  }
}

module.exports = registry.register(new GitHubProvider());
