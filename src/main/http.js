// Polite HTTP layer. Everything that talks to a third party goes through here so
// rate limits are respected in one place rather than scattered across callers.

const USER_AGENT = 'Chorus/0.1 (+https://github.com/BofStudios/chorus)';

class Bucket {
  constructor(minIntervalMs) {
    this.minInterval = minIntervalMs;
    this.chain = Promise.resolve();
    this.last = 0;
  }

  // Serialises calls through this bucket and spaces them out.
  run(fn) {
    const task = this.chain.then(async () => {
      const gap = Date.now() - this.last;
      if (gap < this.minInterval) await sleep(this.minInterval - gap);
      this.last = Date.now();
      return fn();
    });
    // Keep the chain alive even when a call rejects.
    this.chain = task.then(
      () => {},
      () => {}
    );
    return task;
  }
}

const buckets = {
  // 5,000/hour is the authenticated ceiling; 150ms spacing stays far under it
  // and also under the 900-points-per-minute secondary limit.
  core: new Bucket(150),
  // Search is 30 requests/minute authenticated. 2.1s keeps a safety margin.
  search: new Bucket(2100),
  hn: new Bucket(350)
};

const state = {
  core: { remaining: null, limit: null, resetAt: null },
  search: { remaining: null, limit: null, resetAt: null }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRateHeaders(res, bucketName) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limit = res.headers.get('x-ratelimit-limit');
  const reset = res.headers.get('x-ratelimit-reset');
  const slot = state[bucketName];
  if (!slot) return;
  if (remaining !== null) slot.remaining = Number(remaining);
  if (limit !== null) slot.limit = Number(limit);
  if (reset !== null) slot.resetAt = Number(reset) * 1000;
}

class HttpError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

async function request(url, { headers = {}, method = 'GET', body = null, bucket = 'core', retries = 2 } = {}) {
  const chosen = buckets[bucket] || buckets.core;

  return chosen.run(async () => {
    let attempt = 0;

    for (;;) {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body: body ? JSON.stringify(body) : undefined
      });

      readRateHeaders(res, bucket);

      if (res.ok) {
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError('Received a response that was not valid JSON.', { status: res.status });
        }
      }

      const payload = await res.json().catch(() => ({}));
      const message = payload.message || payload.error?.message || `Request failed (${res.status}).`;

      // Primary rate limit exhausted, or GitHub's secondary abuse limiter.
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse/i.test(message)));

      if (rateLimited && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        let waitMs = retryAfter ? retryAfter * 1000 : resetAt ? resetAt - Date.now() : 0;
        if (!waitMs || waitMs < 0) waitMs = 2 ** attempt * 2000;
        // Anything beyond a minute is not worth blocking the pipeline for.
        if (waitMs > 60_000) {
          throw new HttpError(
            `Rate limit hit and it does not reset for ${Math.round(waitMs / 60000)} minutes. Add a GitHub token in Settings to raise the ceiling.`,
            { status: res.status, body: payload }
          );
        }
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (res.status >= 500 && attempt < retries) {
        await sleep(2 ** attempt * 1000);
        attempt += 1;
        continue;
      }

      throw new HttpError(message, { status: res.status, body: payload });
    }
  });
}

function rateStatus() {
  return {
    core: { ...state.core },
    search: { ...state.search }
  };
}

module.exports = { request, rateStatus, HttpError, sleep };
