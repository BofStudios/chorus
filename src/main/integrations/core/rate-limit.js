// Per-provider rate limiting.
//
// Two layers: a steady-rate token bucket that keeps us inside each provider's
// published budget, and a cooldown that a 429 (or a Retry-After header) can
// impose on the whole provider until it lifts. Nothing retries blindly — the
// caller asks `take()` and is told to wait, rather than firing and hoping.

const { IntegrationError, CODES } = require('./errors');

class TokenBucket {
  constructor({ capacity, refillPerMinute }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMinute / 60000;
    this.last = Date.now();
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  // Milliseconds until a token is available; 0 means take it now.
  waitMs() {
    this.#refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  consume() {
    this.#refill();
    this.tokens -= 1;
  }
}

class ProviderLimiter {
  constructor(provider, limits = {}) {
    this.provider = provider;
    // Deliberately conservative defaults: a provider adapter overrides these
    // with its own published numbers.
    this.buckets = {
      global: new TokenBucket({
        capacity: limits.burst ?? 5,
        refillPerMinute: limits.perMinute ?? 30
      })
    };
    this.perAction = limits.perAction || {};
    for (const [action, cfg] of Object.entries(this.perAction)) {
      this.buckets[action] = new TokenBucket({
        capacity: cfg.burst ?? 1,
        refillPerMinute: cfg.perMinute ?? 1
      });
    }
    this.cooldownUntil = 0;
    this.chain = Promise.resolve();
  }

  cooldownRemaining() {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  // A 429 or explicit Retry-After parks the whole provider.
  penalise(retryAfterMs) {
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 60000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wait);
    return wait;
  }

  // How long before this action could run. Callers that cannot wait (an
  // interactive request) use this to fail fast with an honest message.
  waitFor(action) {
    const waits = [this.cooldownRemaining(), this.buckets.global.waitMs()];
    if (this.buckets[action]) waits.push(this.buckets[action].waitMs());
    return Math.max(...waits);
  }

  // Serialised so two concurrent sends cannot both see a free token.
  run(action, fn, { maxWaitMs = 0 } = {}) {
    const task = this.chain.then(async () => {
      const wait = this.waitFor(action);
      if (wait > 0) {
        if (wait > maxWaitMs) {
          throw new IntegrationError(CODES.RATE_LIMITED, {
            provider: this.provider,
            retryAfterMs: wait,
            message: `This provider is rate limited for another ${Math.ceil(wait / 1000)}s. The queue will retry.`
          });
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.buckets.global.consume();
      if (this.buckets[action]) this.buckets[action].consume();
      return fn();
    });

    this.chain = task.then(
      () => {},
      () => {}
    );
    return task;
  }
}

const limiters = new Map();

function limiterFor(provider, limits) {
  if (!limiters.has(provider)) limiters.set(provider, new ProviderLimiter(provider, limits));
  return limiters.get(provider);
}

// Exponential backoff with jitter, used by the sending worker between attempts.
function backoffMs(attempt, { base = 2000, max = 15 * 60000 } = {}) {
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}

module.exports = { ProviderLimiter, TokenBucket, limiterFor, backoffMs };
