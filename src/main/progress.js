// Weighted stage tracker. Weights are rough shares of wall-clock time for a
// typical run, so the bar moves at a believable pace instead of jumping.

const STAGES = [
  { id: 'repo', label: 'Reading repository', weight: 4 },
  { id: 'analyse', label: 'Understanding the audience', weight: 8 },
  { id: 'discover', label: 'Searching for people', weight: 18 },
  { id: 'discussions', label: 'Finding discussions', weight: 4 },
  { id: 'profile', label: 'Profiling candidates', weight: 26 },
  { id: 'assess', label: 'Assessing each match', weight: 24 },
  { id: 'draft', label: 'Writing drafts', weight: 16 }
];

const TOTAL_WEIGHT = STAGES.reduce((sum, stage) => sum + stage.weight, 0);

class Progress {
  constructor(emit) {
    this.emit = emit;
    this.startedAt = Date.now();
    this.index = -1;
    this.fraction = 0;
    this.counters = { discovered: 0, profiled: 0, assessed: 0, kept: 0 };
    this.log = [];
  }

  get stage() {
    return STAGES[this.index] || null;
  }

  #overall() {
    let done = 0;
    for (let i = 0; i < this.index; i += 1) done += STAGES[i].weight;
    if (this.stage) done += this.stage.weight * this.fraction;
    return Math.min(99, Math.round((done / TOTAL_WEIGHT) * 100));
  }

  #eta(overall) {
    const elapsed = Date.now() - this.startedAt;
    // Below 5% the estimate is noise, so don't show one.
    if (overall < 5) return null;
    return Math.max(0, Math.round((elapsed / overall) * (100 - overall)));
  }

  #send(extra = {}) {
    const overall = this.#overall();
    const payload = {
      type: 'progress',
      stages: STAGES.map((stage, i) => ({
        id: stage.id,
        label: stage.label,
        state: i < this.index ? 'done' : i === this.index ? 'active' : 'pending'
      })),
      stage: this.stage ? { id: this.stage.id, label: this.stage.label, index: this.index } : null,
      stageFraction: this.fraction,
      overall,
      elapsedMs: Date.now() - this.startedAt,
      etaMs: this.#eta(overall),
      counters: { ...this.counters },
      ...extra
    };
    this.emit(payload);
    return payload;
  }

  begin(stageId, message) {
    const index = STAGES.findIndex((stage) => stage.id === stageId);
    if (index !== -1) {
      this.index = index;
      this.fraction = 0;
    }
    this.#record(message, 'info');
    this.#send({ message, level: 'info' });
  }

  step(current, total, message) {
    this.fraction = total > 0 ? Math.min(1, current / total) : 0;
    if (message) this.#record(message, 'info');
    this.#send({ message, level: 'info', current, total });
  }

  note(message, level = 'info') {
    this.#record(message, level);
    this.#send({ message, level });
  }

  count(patch) {
    Object.assign(this.counters, patch);
    this.#send({});
  }

  finish(type, message) {
    this.index = STAGES.length;
    this.fraction = 1;
    this.#record(message, type === 'done' ? 'success' : type === 'cancelled' ? 'warn' : 'error');
    this.emit({
      type,
      message,
      overall: type === 'done' ? 100 : this.#overall(),
      elapsedMs: Date.now() - this.startedAt,
      etaMs: 0,
      counters: { ...this.counters },
      stages: STAGES.map((stage, i) => ({
        id: stage.id,
        label: stage.label,
        state: type === 'done' ? 'done' : i < this.index ? 'done' : 'pending'
      }))
    });
  }

  #record(message, level) {
    if (!message) return;
    this.log.push({ at: Date.now(), stage: this.stage?.id || '', message, level });
    if (this.log.length > 500) this.log.shift();
  }
}

module.exports = { Progress, STAGES };
