const { request } = require('../http');

// Algolia's HN index is public and needs no key. It is the cheapest way to find
// the discussions your project belongs in — and the people already in them.

const API = 'https://hn.algolia.com/api/v1';

async function search(query, { tags = 'story', limit = 20, minPoints = 5 } = {}) {
  const url = new URL(`${API}/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', tags);
  url.searchParams.set('hitsPerPage', String(Math.min(limit, 50)));
  if (minPoints && tags === 'story') url.searchParams.set('numericFilters', `points>=${minPoints}`);

  const data = await request(url.toString(), { bucket: 'hn' });
  return (data.hits || [])
    .filter((hit) => hit.author)
    .map((hit) => ({
      author: hit.author,
      title: hit.title || hit.story_title || '',
      points: hit.points || 0,
      comments: hit.num_comments || 0,
      createdAt: hit.created_at,
      objectId: hit.objectID,
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      externalUrl: hit.url || ''
    }));
}

// Discussions worth reading before you write to anyone — what the community
// already said about this problem space.
async function relevantThreads(keywords, { limit = 12 } = {}) {
  const results = [];
  for (const keyword of keywords.slice(0, 3)) {
    const hits = await search(keyword, { tags: 'story', limit: 10, minPoints: 20 }).catch(() => []);
    results.push(...hits);
  }
  const seen = new Set();
  return results
    .filter((hit) => {
      if (seen.has(hit.objectId)) return false;
      seen.add(hit.objectId);
      return true;
    })
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

// People who submitted or wrote substantially about this topic on HN.
// Their HN handle is a lead, not a contact detail — Chorus shows the thread,
// you decide whether replying there makes sense.
async function activeAuthors(keywords, { limit = 20 } = {}) {
  const tally = new Map();
  for (const keyword of keywords.slice(0, 3)) {
    const hits = await search(keyword, { tags: 'story', limit: 20, minPoints: 10 }).catch(() => []);
    for (const hit of hits) {
      const existing = tally.get(hit.author) || { author: hit.author, posts: 0, points: 0, examples: [] };
      existing.posts += 1;
      existing.points += hit.points;
      if (existing.examples.length < 3) {
        existing.examples.push({ title: hit.title, url: hit.url, points: hit.points });
      }
      tally.set(hit.author, existing);
    }
  }
  return [...tally.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

module.exports = { search, relevantThreads, activeAuthors };
