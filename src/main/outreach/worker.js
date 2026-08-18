// The sending worker.
//
// One message at a time, paced by the provider's own rate limiter. Sequential
// on purpose: outreach that arrives in a burst reads as a burst, and every
// platform that matters treats a burst as spam.
//
// The worker cannot approve anything. It only ever picks up work a human already
// approved and a campaign already marked running, which is what keeps
// "automatic" from meaning "unsupervised".

const queue = require('./queue');
const campaigns = require('./campaigns');
const router = require('../integrations/core/router');
const audit = require('../integrations/core/audit');
const { backoffMs } = require('../integrations/core/rate-limit');
const { CODES } = require('../integrations/core/errors');

// Failures worth trying again, and failures that will never succeed no matter
// how patient we are.
const RETRYABLE = new Set([CODES.RATE_LIMITED, CODES.NETWORK_ERROR, CODES.PROVIDER_ERROR]);
const TERMINAL = new Set([
  CODES.CAPABILITY_UNSUPPORTED,
  CODES.INVALID_RECIPIENT,
  CODES.OWNERSHIP,
  CODES.PERMISSION_DENIED
]);

const MAX_ATTEMPTS = 5;

let running = false;
let timer = null;
let listeners = [];
let idleDelayMs = 4000;

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken listener must not stop the queue.
    }
  }
}

function onEvent(listener) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

async function processOne() {
  const states = campaigns.statusMap();
  const message = queue.claimNext({ campaignStates: states });
  if (!message) return false;

  emit({ type: 'sending', messageId: message.id, tool: message.tool, prospect: message.prospect });

  try {
    const outcome = await router.execute(message.tool, {
      connectedAccountId: message.connectedAccountId,
      arguments: message.args,
      context: { campaignId: message.campaignId, messageId: message.id }
    });

    queue.markSent(message.id, {
      providerMessageId: outcome.result?.providerMessageId || '',
      result: outcome.result
    });
    campaigns.recordResult(message.campaignId, 'sent');
    emit({ type: 'sent', messageId: message.id, prospect: message.prospect });
    return true;
  } catch (error) {
    const code = error.code || 'unknown';

    // Something that cannot work: stop trying and say why.
    if (TERMINAL.has(code)) {
      queue.markFailed(message.id, { code, message: error.message, retryAt: null });
      campaigns.recordResult(message.campaignId, 'failed');
      emit({ type: 'failed', messageId: message.id, code, message: error.message, retryable: false });
      return true;
    }

    const exhausted = message.attemptCount >= MAX_ATTEMPTS;
    if (!RETRYABLE.has(code) || exhausted) {
      queue.markFailed(message.id, {
        code,
        message: exhausted ? `${error.message} (gave up after ${message.attemptCount} attempts)` : error.message,
        retryAt: null
      });
      campaigns.recordResult(message.campaignId, 'failed');
      emit({ type: 'failed', messageId: message.id, code, message: error.message, retryable: false });
      return true;
    }

    // Honour an explicit Retry-After over our own guess.
    const wait = error.retryAfterMs || backoffMs(message.attemptCount);
    queue.markFailed(message.id, { code, message: error.message, retryAt: Date.now() + wait });
    queue.retry(message.id, wait);
    emit({
      type: 'retrying',
      messageId: message.id,
      code,
      message: error.message,
      inMs: wait,
      attempt: message.attemptCount
    });
    return true;
  }
}

async function loop() {
  if (!running) return;

  let did = false;
  try {
    did = await processOne();
  } catch (error) {
    // A fault in the loop itself must not kill the worker silently.
    audit.record(audit.EVENTS.MESSAGE_FAILED, { reason: 'worker-fault', message: error.message });
    emit({ type: 'error', message: error.message });
  }

  if (!running) return;
  // Busy when there is work, patient when there is not.
  timer = setTimeout(loop, did ? 600 : idleDelayMs);
}

function start({ idleMs } = {}) {
  if (running) return { running: true, alreadyRunning: true };
  if (idleMs) idleDelayMs = idleMs;
  running = true;
  emit({ type: 'started' });
  loop();
  return { running: true };
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  emit({ type: 'stopped' });
  return { running: false };
}

function status() {
  const counts = queue.counts();
  return {
    running,
    queued: counts.queued,
    sending: counts.sending,
    sent: counts.sent,
    failed: counts.failed,
    awaitingApproval: counts.draft
  };
}

/** Drain the queue once and return — used by tests and by "send now". */
async function drain({ max = 50 } = {}) {
  const processed = [];
  for (let index = 0; index < max; index += 1) {
    const before = queue.counts();
    const did = await processOne();
    if (!did) break;
    processed.push(before);
  }
  return { processed: processed.length };
}

module.exports = { start, stop, status, drain, processOne, onEvent, MAX_ATTEMPTS };
