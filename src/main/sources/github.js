const { request } = require('../http');
const { getStore } = require('../store');

const API = 'https://api.github.com';

// Note: /stargazers and /subscribers were restricted to repo admins in June 2026
// precisely because they were being harvested for spam. Chorus does not use them.
// Everything below is activity people chose to make public: code they wrote,
// issues they opened, profiles they filled in.

function headers() {
  const token = getStore().getSecret('githubToken');
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function get(pathname, { query = {}, bucket = 'core' } = {}) {
  const url = new URL(`${API}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return request(url.toString(), { headers: headers(), bucket });
}

function parseRepo(input) {
  const trimmed = (input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const direct = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2] };
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    /* not a URL */
  }
  return null;
}

async function repoInfo(owner, repo) {
  const data = await get(`/repos/${owner}/${repo}`);
  return {
    fullName: data.full_name,
    owner: data.owner.login,
    ownerType: data.owner.type,
    name: data.name,
    description: data.description || '',
    topics: data.topics || [],
    language: data.language || '',
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    homepage: data.homepage || '',
    license: data.license?.spdx_id || '',
    pushedAt: data.pushed_at,
    createdAt: data.created_at,
    url: data.html_url
  };
}

async function readme(owner, repo) {
  try {
    const data = await get(`/repos/${owner}/${repo}/readme`);
    if (!data?.content) return '';
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8')
      .toString('utf8')
      .slice(0, 8000);
  } catch {
    return '';
  }
}

async function searchRepos(query, { limit = 20, sort = 'stars' } = {}) {
  const data = await get('/search/repositories', {
    query: { q: query, sort, order: 'desc', per_page: Math.min(limit, 100) },
    bucket: 'search'
  });
  return (data.items || []).map((item) => ({
    fullName: item.full_name,
    owner: item.owner.login,
    ownerType: item.owner.type,
    name: item.name,
    description: item.description || '',
    topics: item.topics || [],
    language: item.language || '',
    stars: item.stargazers_count,
    pushedAt: item.pushed_at,
    url: item.html_url
  }));
}

async function contributors(owner, repo, { limit = 15 } = {}) {
  try {
    const data = await get(`/repos/${owner}/${repo}/contributors`, {
      query: { per_page: Math.min(limit, 100), anon: 'false' }
    });
    if (!Array.isArray(data)) return [];
    return data
      .filter((user) => user.type === 'User' && user.login)
      .map((user) => ({ login: user.login, contributions: user.contributions }));
  } catch {
    // Empty repos and a few org configurations 404 here; that is not fatal.
    return [];
  }
}

async function searchUsers(query, { limit = 30 } = {}) {
  const data = await get('/search/users', {
    query: { q: query, per_page: Math.min(limit, 100) },
    bucket: 'search'
  });
  return (data.items || []).filter((item) => item.type === 'User').map((item) => ({ login: item.login }));
}

async function searchIssueAuthors(query, { limit = 30 } = {}) {
  const data = await get('/search/issues', {
    query: { q: query, sort: 'updated', order: 'desc', per_page: Math.min(limit, 100) },
    bucket: 'search'
  });
  const seen = new Map();
  for (const item of data.items || []) {
    const login = item.user?.login;
    if (!login || item.user.type !== 'User') continue;
    if (!seen.has(login)) {
      seen.set(login, {
        login,
        evidence: {
          type: 'issue',
          label: item.title.slice(0, 120),
          url: item.html_url,
          repo: (item.repository_url || '').split('/repos/')[1] || ''
        }
      });
    }
  }
  return [...seen.values()].slice(0, limit);
}

async function userProfile(login) {
  const data = await get(`/users/${login}`);
  return {
    login: data.login,
    name: data.name || '',
    type: data.type,
    bio: data.bio || '',
    company: data.company || '',
    blog: data.blog || '',
    twitter: data.twitter_username || '',
    email: data.email || '',
    location: data.location || '',
    hireable: Boolean(data.hireable),
    followers: data.followers,
    following: data.following,
    publicRepos: data.public_repos,
    avatar: data.avatar_url,
    url: data.html_url,
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

async function userRepos(login, { limit = 8 } = {}) {
  try {
    const data = await get(`/users/${login}/repos`, {
      query: { sort: 'pushed', direction: 'desc', per_page: Math.min(limit, 100), type: 'owner' }
    });
    if (!Array.isArray(data)) return [];
    return data
      .filter((repo) => !repo.fork)
      .map((repo) => ({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || '',
        language: repo.language || '',
        topics: repo.topics || [],
        stars: repo.stargazers_count,
        pushedAt: repo.pushed_at,
        url: repo.html_url
      }));
  } catch {
    return [];
  }
}

async function tokenStatus() {
  const token = getStore().getSecret('githubToken');
  if (!token) return { authenticated: false, limit: 60 };
  try {
    const data = await get('/rate_limit');
    const viewer = await get('/user');
    return {
      authenticated: true,
      login: viewer.login,
      limit: data.resources?.core?.limit ?? null,
      remaining: data.resources?.core?.remaining ?? null,
      searchRemaining: data.resources?.search?.remaining ?? null,
      resetAt: data.resources?.core?.reset ? data.resources.core.reset * 1000 : null
    };
  } catch (error) {
    return { authenticated: false, error: error.message, limit: 60 };
  }
}

module.exports = {
  parseRepo,
  repoInfo,
  readme,
  searchRepos,
  contributors,
  searchUsers,
  searchIssueAuthors,
  userProfile,
  userRepos,
  tokenStatus
};
