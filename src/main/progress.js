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

// The research graph. Each card is a real piece of the pipeline — nothing here
// is decorative, and a card only fills in when that work actually happened.
const CARDS = [
  { id: 'overview', stage: 'repo', title: 'Project overview', blurb: 'What your repository actually does.' },
  { id: 'audience', stage: 'analyse', title: 'Your audience', blurb: 'Who genuinely benefits — and who does not.' },
  { id: 'neighbours', stage: 'discover', title: 'Neighbouring projects', blurb: 'The repositories sitting next to yours.' },
  { id: 'builders', stage: 'discover', title: 'Who builds there', blurb: 'People writing code in your space.' },
  { id: 'problems', stage: 'discover', title: 'Problem reports', blurb: 'Developers who hit this exact problem.' },
  { id: 'profiles', stage: 'discover', title: 'Matching profiles', blurb: 'Bios that name what you built.' },
  { id: 'discussions', stage: 'discussions', title: 'Where it is discussed', blurb: 'Threads your project belongs in.' },
  { id: 'people', stage: 'profile', title: 'Candidate profiles', blurb: 'Recent work, activity, reachability.' },
  { id: 'scoring', stage: 'assess', title: 'Match scoring', blurb: 'Who is worth writing to, with reasons.' },
  { id: 'channels', stage: 'assess', title: 'Where to reach them', blurb: 'The right channel for each person.' },
  { id: 'drafts', stage: 'draft', title: 'Your drafts', blurb: 'A personal message, one per person.' }
];

class Progress {
  constructor(emit) {
    this.emit = emit;
    this.startedAt = Date.now();
    this.index = -1;
    this.fraction = 0;
    this.counters = { discovered: 0, profiled: 0, assessed: 0, kept: 0 };
    this.log = [];
    this.findings = [];
    this.activeCard = null;
  }

  // Attach a real result to a graph card. Cards without findings stay empty —
  // an empty card is honest, a fabricated one is not.
  finding(cardId, text, detail) {
    if (!text) return;
    const entry = { cardId, text: String(text).slice(0, 200), detail: detail || '', at: Date.now() };
    this.findings.push(entry);
    if (this.findings.length > 400) this.findings.shift();
    this.activeCard = cardId;
    this.#send({ finding: entry });
  }

  // Mark which card the pipeline is working on without adding a finding.
  focus(cardId) {
    this.activeCard = cardId;
    this.#send({});
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
      cards: CARDS.map((card) => ({
        ...card,
        state:
          card.id === this.activeCard
            ? 'active'
            : this.findings.some((f) => f.cardId === card.id)
              ? 'done'
              : STAGES.findIndex((s) => s.id === card.stage) < this.index
                ? 'done'
                : 'pending',
        count: this.findings.filter((f) => f.cardId === card.id).length
      })),
      findingCount: this.findings.length,
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
    this.activeCard = null;
    this.#record(message, type === 'done' ? 'success' : type === 'cancelled' ? 'warn' : 'error');
    this.emit({
      type,
      message,
      overall: type === 'done' ? 100 : this.#overall(),
      elapsedMs: Date.now() - this.startedAt,
      etaMs: 0,
      counters: { ...this.counters },
      findingCount: this.findings.length,
      cards: CARDS.map((card) => ({
        ...card,
        state: this.findings.some((f) => f.cardId === card.id) ? 'done' : type === 'done' ? 'empty' : 'pending',
        count: this.findings.filter((f) => f.cardId === card.id).length
      })),
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
