/* Chorus — renderer. Plain DOM, no framework. */

const api = window.chorus;

const DEPTHS = {
  quick: {
    label: 'Quick',
    blurb: 'A first look. Good for checking the audience makes sense.',
    candidatePool: 40,
    scoreLimit: 15,
    contributorRepos: 5,
    minutes: '2–3'
  },
  standard: {
    label: 'Standard',
    blurb: 'The usual run. Enough people to fill a week of outreach.',
    candidatePool: 120,
    scoreLimit: 40,
    contributorRepos: 10,
    minutes: '6–9'
  },
  deep: {
    label: 'Deep',
    blurb: 'Exhaustive. Widest net, most model calls, slowest.',
    candidatePool: 250,
    scoreLimit: 80,
    contributorRepos: 16,
    minutes: '15–22'
  },
  custom: {
    label: 'Custom',
    blurb: 'Your numbers. No ceiling — set it as high as you want.',
    candidatePool: 400,
    scoreLimit: 150,
    contributorRepos: 20,
    minutes: 'you decide'
  }
};

const state = {
  view: 'new',
  info: null,
  settings: null,
  campaignId: null,
  campaign: null,
  running: false,
  progress: null,
  logLines: [],
  watchlist: [],
  findings: [],
  openCard: null,
  assessed: {},
  wizardStep: 0,
  user: null,
  authMinPassword: 8
};

const content = document.getElementById('content');

// --- helpers --------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

async function call(promise, { silent = false } = {}) {
  const result = await promise;
  if (!result.ok) {
    if (!silent) toast(result.error);
    return null;
  }
  return result.data;
}

function relative(value) {
  if (!value) return 'unknown';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!time || Number.isNaN(time)) return 'unknown';
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function scoreClass(score) {
  if (score >= 75) return 'high';
  if (score >= 55) return 'mid';
  return 'low';
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-external]');
  if (!link) return;
  event.preventDefault();
  api.openExternal(link.getAttribute('href'));
});

// --- chrome ---------------------------------------------------------------

function setView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  render();
}

document.getElementById('nav').addEventListener('click', (event) => {
  const button = event.target.closest('.nav-item');
  if (button) setView(button.dataset.view);
});

async function refreshSidebar() {
  const [ledger, rate, bridge] = await Promise.all([
    call(api.ledger.stats(), { silent: true }),
    call(api.rateStatus(), { silent: true }),
    call(api.bridge.status(), { silent: true })
  ]);

  if (ledger) {
    document.getElementById('stat-total').textContent = ledger.total;
    // A cap of 0 means unlimited, so show a plain count rather than "4 / 0".
    document.getElementById('stat-today').textContent = ledger.cap
      ? `${ledger.today} / ${ledger.cap}`
      : ledger.today;
  }
  if (rate?.core?.remaining !== null && rate?.core?.remaining !== undefined) {
    document.getElementById('stat-rate').textContent = `${rate.core.remaining}/${rate.core.limit ?? '?'}`;
  }

  const badge = document.getElementById('watch-badge');
  if (badge) {
    const count = bridge?.watchlist || 0;
    badge.textContent = count || '';
    badge.hidden = !count;
  }

  const provider = state.settings?.config.ai.provider || 'offline';
  const label = state.info?.providers[provider]?.label || provider;
  document.getElementById('stat-provider').textContent =
    `${label}${state.settings?.githubToken ? '' : ' · no GitHub token (60 req/h)'}`;
}

// --- view: setup wizard ---------------------------------------------------

function viewSetup() {
  const providers = state.info.providers;
  const step = state.wizardStep;

  const steps = [
    {
      title: 'Give Chorus a GitHub token',
      body: `
        <p class="lede">
          Chorus reads public data through GitHub's API. Without a token you get 60 requests an
          hour — barely one small run. With one you get 5,000.
        </p>
        <div class="notice">
          <b>No scopes required.</b> On the token page, tick nothing at all. Chorus only reads
          things that are already public.
        </div>
        <div class="btn-row mb-18">
          <button class="btn ghost small" id="openTokens">Open the token page →</button>
        </div>
        <label class="field">
          <span>Paste the token</span>
          <input type="password" id="wizToken" placeholder="ghp_… or github_pat_…" />
        </label>
        <div class="btn-row">
          <button class="btn" id="wizNext">Save and continue</button>
          <button class="btn ghost" id="wizSkip">Skip</button>
          <span id="wizStatus" class="status-text"></span>
        </div>`
    },
    {
      title: 'Connect an AI model',
      body: `
        <p class="lede">
          This is what reads your README, judges each person, and writes the drafts. Every option
          below has a free tier. Chorus also runs without one — the results are just rougher.
        </p>
        <label class="field">
          <span>Provider</span>
          <select id="wizProvider">
            ${Object.entries(providers)
              .filter(([id]) => id !== 'offline')
              .map(
                ([id, meta]) =>
                  `<option value="${esc(id)}" ${id === 'gemini' ? 'selected' : ''}>${esc(meta.label)}</option>`
              )
              .join('')}
          </select>
        </label>
        <div class="btn-row mb-18">
          <button class="btn ghost small" id="openSignup">Get a free key →</button>
          <span class="status-text">opens in your browser</span>
        </div>
        <label class="field">
          <span>Paste the key</span>
          <input type="password" id="wizKey" placeholder="paste it here" />
        </label>
        <div class="btn-row">
          <button class="btn" id="wizTest">Test and finish</button>
          <button class="btn ghost" id="wizSkip">Use offline mode</button>
          <span id="wizStatus" class="status-text"></span>
        </div>`
    },
    {
      title: 'Ready',
      body: `
        <p class="lede">Everything is set. Point Chorus at a repository and it will do the rest.</p>
        <div class="card">
          <h2>How a run goes</h2>
          <div class="body-text loose">
            1. It reads your repo and works out who would genuinely benefit.<br />
            2. It searches GitHub for those people through their public work.<br />
            3. It profiles each one and drops the inactive and irrelevant.<br />
            4. It assesses the rest individually and writes you a draft per person.<br />
            5. You read, edit, copy, and send them yourself.
          </div>
        </div>
        <div class="btn-row">
          <button class="btn" id="wizDone">Start my first run</button>
        </div>`
    }
  ];

  const active = steps[step];
  content.innerHTML = `
    <div class="view">
      <div class="wizard-dots">
        ${steps.map((_, index) => `<span class="${index === step ? 'on' : index < step ? 'done' : ''}"></span>`).join('')}
      </div>
      <h1>${esc(active.title)}</h1>
      ${active.body}
    </div>
  `;

  const status = document.getElementById('wizStatus');

  document.getElementById('openTokens')?.addEventListener('click', () => {
    api.openExternal('https://github.com/settings/tokens/new?description=Chorus&scopes=');
  });

  document.getElementById('openSignup')?.addEventListener('click', () => {
    const provider = document.getElementById('wizProvider').value;
    const url = providers[provider]?.signup;
    if (url) api.openExternal(url);
  });

  document.getElementById('wizNext')?.addEventListener('click', async () => {
    const token = document.getElementById('wizToken').value.trim();
    if (token) {
      await call(api.settings.setGithubToken(token));
      status.textContent = 'checking…';
      const result = await call(api.github.status(), { silent: true });
      if (result?.authenticated) {
        status.textContent = `✓ ${result.login} — ${result.limit}/hour`;
      } else {
        status.textContent = '✗ token rejected';
        return;
      }
      state.settings = await call(api.settings.get());
    }
    state.wizardStep = 1;
    render();
  });

  document.getElementById('wizTest')?.addEventListener('click', async () => {
    const provider = document.getElementById('wizProvider').value;
    const key = document.getElementById('wizKey').value.trim();
    if (!key) {
      status.textContent = 'paste a key first';
      return;
    }
    status.textContent = 'testing…';
    const result = await call(api.settings.testKey(provider, key), { silent: true });
    if (!result?.ok) {
      status.textContent = '✗ rejected — check the key';
      return;
    }
    await call(api.settings.setKey(provider, key));
    await call(api.settings.save({ ai: { provider } }));
    state.settings = await call(api.settings.get());
    status.textContent = `✓ working (${result.model})`;
    state.wizardStep = 2;
    setTimeout(render, 600);
    refreshSidebar();
  });

  for (const button of document.querySelectorAll('#wizSkip')) {
    button.addEventListener('click', () => {
      state.wizardStep = step === 0 ? 1 : 2;
      render();
    });
  }

  document.getElementById('wizDone')?.addEventListener('click', async () => {
    await call(api.settings.save({ setupDone: true }));
    state.settings = await call(api.settings.get());
    setView('new');
  });
}

// --- view: new research ---------------------------------------------------

function viewNew() {
  const project = state.settings?.config.project || {};
  // Fall back to the Standard preset for any field an older config is missing,
  // otherwise number inputs get `undefined` and silently refuse the value.
  const research = { ...DEPTHS.standard, minScore: 50, activeWithinDays: 365, ...state.settings?.config.research };
  const depth = research.depth || 'standard';

  content.innerHTML = `
    <div class="view">
      <h1>New research</h1>
      <p class="lede">
        Chorus reads your repository, works out who would genuinely benefit from it, then finds
        those people through their public work. It drafts a message for each one. You decide what
        to send, and you send it yourself.
      </p>

      ${
        state.settings?.githubToken
          ? ''
          : `<div class="notice"><b>No GitHub token.</b> You are limited to 60 API requests an hour,
             which will cut a run short. Add one in Settings.</div>`
      }

      <div class="card">
        <label class="field">
          <span>Your repository</span>
          <input type="text" id="repo" placeholder="BofStudios/parley-agent" value="${esc(project.repo)}" />
          <span class="hint">owner/name, or paste the github.com URL</span>
        </label>

        <label class="field">
          <span>What is it, in your own words?</span>
          <textarea id="pitch" placeholder="A desktop messenger for AI coworkers — you write who a bot is, it shows up in your chats.">${esc(project.pitch)}</textarea>
          <span class="hint">Optional, but it sharpens the research noticeably.</span>
        </label>

        <label class="field">
          <span>Who do you think it is for?</span>
          <input type="text" id="audience" placeholder="Developers building agent tooling" value="${esc(project.audience)}" />
          <span class="hint">Optional. Chorus will push back if the evidence disagrees.</span>
        </label>
      </div>

      <div class="card">
        <h2>How deep should it go?</h2>
        <div class="depths">
          ${Object.entries(DEPTHS)
            .map(
              ([id, preset]) => `
            <button class="depth ${depth === id ? 'on' : ''}" data-depth="${esc(id)}">
              <div class="depth-name">${esc(preset.label)}</div>
              <div class="depth-blurb">${esc(preset.blurb)}</div>
              <div class="depth-meta">
                <span>${preset.candidatePool} profiled</span>
                <span>${preset.scoreLimit} assessed</span>
                <span>${preset.minutes} min</span>
              </div>
            </button>`
            )
            .join('')}
        </div>
        <div id="customBox" hidden>
          <div class="divider"></div>
          <div class="row">
            <label class="field">
              <span>People to profile</span>
              <input type="number" id="cPool" min="10" value="${research.candidatePool}" />
              <span class="hint">No maximum. Higher costs GitHub requests and time.</span>
            </label>
            <label class="field">
              <span>People to assess with AI</span>
              <input type="number" id="cScore" min="1" value="${research.scoreLimit}" />
              <span class="hint">No maximum. Each one costs two model calls.</span>
            </label>
          </div>
          <label class="field">
            <span>Neighbouring repos to pull contributors from</span>
            <input type="number" id="cRepos" min="1" value="${research.contributorRepos}" />
          </label>
        </div>

        <div class="cost-line" id="costLine"></div>
      </div>

      <details class="card">
        <summary>Fine tuning</summary>
        <div class="row mt-16">
          <label class="field">
            <span>Minimum score to keep</span>
            <input type="number" id="minScore" min="0" max="100" value="${research.minScore}" />
            <span class="hint">Below 55 the connection is usually too thin</span>
          </label>
          <label class="field">
            <span>Active within (days)</span>
            <input type="number" id="activeWithinDays" min="0" value="${research.activeWithinDays}" />
            <span class="hint">Skips people who stopped pushing code</span>
          </label>
        </div>
        <label class="checkline">
          <input type="checkbox" id="requireContactChannel" ${research.requireContactChannel ? 'checked' : ''} />
          Only keep people with a public contact channel
        </label>
      </details>

      <div class="btn-row">
        <button class="btn" id="start">Start research</button>
        <span class="pill">nothing is sent — drafts only</span>
      </div>
    </div>
  `;

  let selected = depth;

  const currentNumbers = () => {
    if (selected !== 'custom') return DEPTHS[selected];
    return {
      candidatePool: Math.max(1, Number(document.getElementById('cPool').value) || 400),
      scoreLimit: Math.max(1, Number(document.getElementById('cScore').value) || 150),
      contributorRepos: Math.max(1, Number(document.getElementById('cRepos').value) || 20)
    };
  };

  const paintCost = () => {
    const numbers = currentNumbers();
    const minutes = Math.round((numbers.scoreLimit * 2 * 4.5 + numbers.candidatePool * 0.4) / 60);
    document.getElementById('costLine').innerHTML = `
      Roughly <b>${numbers.candidatePool * 2 + 40}</b> GitHub requests and
      <b>${numbers.scoreLimit * 2 + 1}</b> model calls${selected === 'custom' ? ` — about <b>${minutes}</b> minutes` : ''}.
      ${
        state.settings?.config.ai.provider === 'offline'
          ? 'Offline mode uses no model calls.'
          : 'Free tiers are rate limited, so the model calls set the pace.'
      }`;
  };

  const syncCustomBox = () => {
    document.getElementById('customBox').hidden = selected !== 'custom';
  };

  syncCustomBox();
  paintCost();

  for (const button of document.querySelectorAll('.depth')) {
    button.addEventListener('click', () => {
      selected = button.dataset.depth;
      for (const other of document.querySelectorAll('.depth')) other.classList.toggle('on', other === button);
      syncCustomBox();
      paintCost();
    });
  }

  for (const id of ['cPool', 'cScore', 'cRepos']) {
    document.getElementById(id).addEventListener('input', paintCost);
  }

  document.getElementById('start').addEventListener('click', () =>
    startResearch(() => ({ depth: selected, ...currentNumbers() }))
  );
}

async function startResearch(getConfig) {
  const repo = document.getElementById('repo').value.trim();
  if (!repo) return toast('Enter a repository first.');

  const chosen = getConfig();

  await call(
    api.settings.save({
      project: {
        repo,
        pitch: document.getElementById('pitch').value.trim(),
        audience: document.getElementById('audience').value.trim()
      },
      research: {
        depth: chosen.depth,
        candidatePool: chosen.candidatePool,
        scoreLimit: chosen.scoreLimit,
        contributorRepos: chosen.contributorRepos,
        minScore: Number(document.getElementById('minScore').value) || 50,
        activeWithinDays: Number(document.getElementById('activeWithinDays').value) || 365,
        requireContactChannel: document.getElementById('requireContactChannel').checked
      }
    })
  );
  state.settings = await call(api.settings.get());

  const started = await call(
    api.research.start({
      repo,
      pitch: document.getElementById('pitch').value.trim(),
      audience: document.getElementById('audience').value.trim()
    })
  );
  if (!started) return;

  state.campaignId = started.campaignId;
  state.running = true;
  state.logLines = [];
  state.progress = null;
  state.findings = [];
  state.openCard = null;
  setView('targets');
}

// --- view: live research --------------------------------------------------

// Where each card sits on the canvas, as percentages. Hand-placed rather than
// evenly spaced on a circle — a perfect ring reads as a diagram, a slightly
// irregular constellation reads as a workspace.
const CARD_SPOTS = {
  overview: { x: 50, y: 9 },
  audience: { x: 28, y: 15 },
  neighbours: { x: 13, y: 33 },
  builders: { x: 11, y: 57 },
  problems: { x: 19, y: 80 },
  profiles: { x: 41, y: 91 },
  discussions: { x: 63, y: 91 },
  people: { x: 82, y: 77 },
  scoring: { x: 87, y: 52 },
  channels: { x: 84, y: 28 },
  drafts: { x: 71, y: 12 }
};

function viewRunning() {
  const progress = state.progress;
  const repo = state.settings?.config.project.repo || '';

  content.innerHTML = `
    <div class="graph-view">
      <div class="graph-stage" id="graphStage">
        <svg class="graph-links" id="graphLinks" aria-hidden="true"></svg>
        <div class="graph-core" id="graphCore">
          <span class="core-glyph"></span>
          <span class="core-name">${esc(repo || 'your project')}</span>
          <span class="core-spin"></span>
        </div>
        <div class="graph-cards" id="graphCards"></div>
      </div>

      <div class="graph-foot">
        <div class="graph-note" id="graphNote">Starting the research…</div>
        <div class="graph-bar-row">
          <span class="graph-bar-label">Research in progress</span>
          <div class="graph-bar"><div id="graphBar"></div></div>
          <span class="graph-time" id="graphTime"></span>
          <button class="btn ghost small" id="cancel">Cancel</button>
        </div>
      </div>

      <div class="graph-drawer" id="graphDrawer" hidden>
        <div class="drawer-head">
          <div>
            <div class="drawer-title" id="drawerTitle"></div>
            <div class="drawer-sub" id="drawerSub"></div>
          </div>
          <button class="drawer-close" id="drawerClose" aria-label="Close">×</button>
        </div>
        <div class="drawer-body" id="drawerBody"></div>
      </div>
    </div>
  `;

  buildGraph(progress?.cards || []);
  if (progress) updateRunning(progress);

  document.getElementById('cancel').addEventListener('click', () => call(api.research.cancel()));
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
}

function buildGraph(cards) {
  const host = document.getElementById('graphCards');
  const links = document.getElementById('graphLinks');
  if (!host || !links) return;

  host.textContent = '';
  links.textContent = '';
  links.setAttribute('viewBox', '0 0 100 100');
  links.setAttribute('preserveAspectRatio', 'none');

  cards.forEach((card, index) => {
    const spot = CARD_SPOTS[card.id] || { x: 50, y: 50 };

    // A faint line from the centre out to each card.
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '50');
    line.setAttribute('y1', '50');
    line.setAttribute('x2', String(spot.x));
    line.setAttribute('y2', String(spot.y));
    line.setAttribute('class', 'graph-link');
    line.dataset.card = card.id;
    line.style.animationDelay = `${index * 60}ms`;
    links.appendChild(line);

    const el = document.createElement('button');
    el.className = 'gcard';
    el.dataset.card = card.id;
    el.style.left = `${spot.x}%`;
    el.style.top = `${spot.y}%`;
    el.style.animationDelay = `${index * 55}ms`;
    el.innerHTML = `
      <span class="gcard-top">
        <span class="gcard-title">${esc(card.title)}</span>
        <span class="gcard-badge" data-badge></span>
      </span>
      <span class="gcard-blurb">${esc(card.blurb)}</span>
      <span class="gcard-status" data-status>Waiting</span>`;
    el.addEventListener('click', () => openDrawer(card.id));
    host.appendChild(el);
  });
}

function updateRunning(payload) {
  const host = document.getElementById('graphCards');
  if (!host) return;

  if (payload.cards?.length && host.children.length !== payload.cards.length) {
    buildGraph(payload.cards);
  }

  for (const card of payload.cards || []) {
    const el = host.querySelector(`.gcard[data-card="${card.id}"]`);
    if (!el) continue;
    el.classList.toggle('is-active', card.state === 'active');
    el.classList.toggle('is-done', card.state === 'done');
    el.classList.toggle('is-empty', card.state === 'empty');

    const badge = el.querySelector('[data-badge]');
    badge.textContent = card.count > 0 ? card.count : '';
    badge.classList.toggle('on', card.count > 0);

    const status = el.querySelector('[data-status]');
    if (card.state === 'active') status.textContent = 'Researching…';
    else if (card.count > 0) status.textContent = `${card.count} finding${card.count === 1 ? '' : 's'} · open`;
    else if (card.state === 'empty') status.textContent = 'Nothing found';
    else if (card.state === 'done') status.textContent = 'Done';
    else status.textContent = 'Waiting';

    const link = document.querySelector(`.graph-link[data-card="${card.id}"]`);
    if (link) {
      link.classList.toggle('lit', card.state === 'active' || card.count > 0);
      link.classList.toggle('pulsing', card.state === 'active');
    }
  }

  document.getElementById('graphBar').style.width = `${payload.overall ?? 0}%`;
  document.getElementById('graphTime').textContent =
    `${duration(payload.elapsedMs)}${payload.etaMs ? ` · ~${duration(payload.etaMs)} left` : ''}`;

  const count = payload.findingCount ?? state.findings.length;
  document.getElementById('graphNote').textContent = count
    ? `${count} finding${count === 1 ? '' : 's'} so far. Open any card to explore it while the research runs.`
    : payload.message || 'Starting the research…';

  document.getElementById('graphCore').classList.toggle('done', payload.type !== 'progress');

  if (state.openCard) paintDrawer(state.openCard);
}

function openDrawer(cardId) {
  state.openCard = cardId;
  const drawer = document.getElementById('graphDrawer');
  if (drawer) drawer.hidden = false;
  paintDrawer(cardId);
}

function closeDrawer() {
  state.openCard = null;
  const drawer = document.getElementById('graphDrawer');
  if (drawer) drawer.hidden = true;
}

function paintDrawer(cardId) {
  const card = (state.progress?.cards || []).find((c) => c.id === cardId);
  if (!card) return;
  const rows = state.findings.filter((f) => f.cardId === cardId);

  document.getElementById('drawerTitle').textContent = card.title;
  document.getElementById('drawerSub').textContent = card.blurb;
  document.getElementById('drawerBody').innerHTML = rows.length
    ? rows
        .map(
          (row) => `
      <div class="drawer-row">
        <div class="drawer-row-text">${esc(row.text)}</div>
        ${row.detail ? `<div class="drawer-row-detail">${esc(row.detail)}</div>` : ''}
      </div>`
        )
        .join('')
    : `<div class="drawer-empty">${
        card.state === 'active' ? 'Working on this now…' : 'Nothing here yet.'
      }</div>`;
}


// --- view: results --------------------------------------------------------

function viewTargets() {
  if (state.running) return viewRunning();
  if (!state.campaign) {
    content.innerHTML = `<div class="view"><div class="empty">
      No research loaded. Start a new run, or open one from History.
    </div></div>`;
    return;
  }
  renderCampaign();
}

function renderCampaign() {
  const campaign = state.campaign;
  const targets = campaign.targets || [];
  const analysis = campaign.analysis || {};
  const remaining = targets.filter((t) => t.status !== 'sent').length;

  content.innerHTML = `
    <div class="view">
      <h1>${esc(campaign.repo)}</h1>
      <p class="lede">${esc(analysis.summary || '')}</p>

      <div class="card">
        <h2>Who this is for</h2>
        <div class="body-text">
          ${(analysis.whoCares || []).map((item) => `<div>· ${esc(item)}</div>`).join('') || '—'}
        </div>
        ${
          analysis.notFor?.length
            ? `<div class="status-text mt-10">
                 Filtered out: ${analysis.notFor.map((item) => esc(item)).join(' · ')}</div>`
            : ''
        }
        <div class="counters mt-16">
          <div class="counter"><b>${campaign.stats?.discovered ?? 0}</b><span>found</span></div>
          <div class="counter"><b>${campaign.stats?.profiled ?? 0}</b><span>profiled</span></div>
          <div class="counter"><b>${campaign.stats?.assessed ?? 0}</b><span>assessed</span></div>
          <div class="counter"><b>${targets.length}</b><span>worth writing to</span></div>
          <div class="counter"><b>${remaining}</b><span>not yet contacted</span></div>
        </div>
      </div>

      ${renderDiscussions(campaign)}
      <div class="divider"></div>

      ${
        targets.length
          ? targets.map(renderTarget).join('')
          : `<div class="empty">Nobody cleared the score threshold. That is a real answer — try a
             lower threshold, a sharper pitch, or a deeper run.</div>`
      }
    </div>
  `;
}

function renderDiscussions(campaign) {
  if (!campaign.discussions?.length) return '';
  return `
    <div class="card">
      <h2>Where this is already being discussed</h2>
      <div class="body-text mb-10">
        Reading these before writing to anyone is usually worth more than the messages themselves.
      </div>
      <div class="thread-list">
        ${campaign.discussions
          .slice(0, 6)
          .map(
            (thread) => `
          <a class="thread" href="${esc(thread.url)}" data-external>
            <span class="thread-score">${thread.points}</span>
            <span class="thread-body">
              <span class="thread-title">${esc(thread.title)}</span>
              <span class="thread-meta">${thread.comments} comments · ${relative(thread.createdAt)}</span>
            </span>
            <span class="thread-go">↗</span>
          </a>`
          )
          .join('')}
      </div>
    </div>`;
}

function renderTarget(target) {
  const contacted = target.status === 'sent' || target.status === 'replied';
  return `
    <div class="target ${contacted ? 'sent' : ''}" data-id="${esc(target.id)}">
      <div class="target-head">
        <img class="avatar" src="${esc(target.avatar)}" alt="" />
        <div class="target-id">
          <div class="target-name">
            <a href="${esc(target.profileUrl)}" data-external>${esc(target.name || target.login)}</a>
            <span class="handle">@${esc(target.login)}</span>
            ${contacted ? '<span class="pill good">contacted</span>' : ''}
          </div>
          <div class="target-bio">${esc(target.bio || '')}</div>
          <div class="meta-line mt-6">
            <span>${target.followers} followers</span>
            ${target.location ? `<span>${esc(target.location)}</span>` : ''}
            <span>last push ${relative(target.lastPush)}</span>
          </div>
        </div>
        <div class="score ${scoreClass(target.score)}"><b>${target.score}</b><span>MATCH</span></div>
      </div>

      <div class="target-body">
        <div class="why">
          <b>Why them:</b> ${esc(target.rationale)}
          ${target.angle ? `<div class="mt-6"><b>Angle:</b> ${esc(target.angle)}</div>` : ''}
        </div>
        ${target.caution ? `<div class="caution">⚠ ${esc(target.caution)}</div>` : ''}

        <div class="evidence">
          ${target.evidence
            .map(
              (item) =>
                `<div><span class="tag">${esc(item.type)}</span>${
                  item.url ? `<a href="${esc(item.url)}" data-external>${esc(item.label)}</a>` : esc(item.label)
                }</div>`
            )
            .join('')}
        </div>

        <div class="channel">
          <b>Reach them via:</b> ${esc(target.channel)} — ${esc(target.channelNote)}
          ${target.email ? ` · <span class="tag">${esc(target.email)}</span>` : ''}
        </div>

        <label class="field mb-8">
          <span>Draft — edit it before you send</span>
          <textarea class="draft-area" data-draft>${esc(target.draft)}</textarea>
        </label>
        <div class="btn-row">
          <button class="btn small" data-action="copy">Copy message</button>
          <button class="btn ghost small" data-action="save">Save edit</button>
          ${
            contacted
              ? '<button class="btn ghost small" data-action="unmark">Mark as not contacted</button>'
              : '<button class="btn ghost small" data-action="mark">I sent this</button>'
          }
          <button class="btn ghost small" data-action="skip">Skip</button>
        </div>
      </div>
    </div>`;
}

// --- view: watchlist ------------------------------------------------------

async function viewWatchlist() {
  state.watchlist = (await call(api.watchlist.list())) || [];
  const bridge = await call(api.bridge.status(), { silent: true });

  content.innerHTML = `
    <div class="view">
      <h1>Watchlist</h1>
      <p class="lede">
        People you sent over from the browser extension while reading GitHub. Assess one and Chorus
        judges the fit against your current project and writes a draft.
      </p>

      ${
        bridge?.running
          ? ''
          : `<div class="notice"><b>The extension bridge is not running.</b> Restart Chorus, or check
             Settings → Extension.</div>`
      }

      ${
        state.watchlist.length
          ? state.watchlist.map(renderWatchItem).join('')
          : `<div class="empty">
               Nothing here yet. Install the extension (Settings → Extension), browse GitHub, and
               press <b>Send to Chorus</b> on anyone interesting.
             </div>`
      }
    </div>`;
}

function renderWatchItem(item) {
  const result = state.assessed[item.id];
  return `
    <div class="target" data-watch="${esc(item.id)}">
      <div class="target-head">
        <img class="avatar" src="${esc(result?.avatar || `https://github.com/${item.login}.png?size=80`)}" alt="" />
        <div class="target-id">
          <div class="target-name">
            <a href="https://github.com/${esc(item.login)}" data-external>@${esc(item.login)}</a>
            ${result ? '' : '<span class="pill">not assessed</span>'}
          </div>
          <div class="target-bio">${esc(result?.bio || item.context || '')}</div>
          <div class="meta-line mt-6">
            <span>added ${relative(item.addedAt)}</span>
            ${item.url ? `<a href="${esc(item.url)}" data-external>source page</a>` : ''}
          </div>
        </div>
        ${result ? `<div class="score ${scoreClass(result.score)}"><b>${result.score}</b><span>MATCH</span></div>` : ''}
      </div>

      <div class="target-body">
        ${
          result
            ? `<div class="why"><b>Why them:</b> ${esc(result.rationale)}</div>
               ${
                 result.refused
                   ? '<div class="caution">The model found no honest reason to write to this person.</div>'
                   : `<label class="field mb-8">
                        <span>Draft</span>
                        <textarea class="draft-area" data-draft>${esc(result.draft)}</textarea>
                      </label>`
               }`
            : ''
        }
        <div class="btn-row">
          ${
            result
              ? result.refused
                ? ''
                : '<button class="btn small" data-watch-action="copy">Copy message</button>'
              : '<button class="btn small" data-watch-action="assess">Assess and draft</button>'
          }
          <button class="btn ghost small" data-watch-action="remove">Remove</button>
        </div>
      </div>
    </div>`;
}

// --- view: history --------------------------------------------------------

async function viewCampaigns() {
  const campaigns = (await call(api.campaigns.list())) || [];
  content.innerHTML = `
    <div class="view">
      <h1>History</h1>
      <p class="lede">Every research run is kept locally so you can come back to the drafts.</p>
      ${
        campaigns.length
          ? campaigns
              .map(
                (campaign) => `
        <div class="campaign-row" data-id="${esc(campaign.id)}">
          <div class="grow">
            <div class="strong">${esc(campaign.repo)}</div>
            <div class="meta-line mt-3">
              <span>${relative(campaign.createdAt)}</span>
              <span>${campaign.targetCount} targets</span>
              <span>${campaign.sentCount} contacted</span>
            </div>
          </div>
          <span class="pill ${campaign.status === 'done' ? 'good' : campaign.status === 'failed' ? 'warn' : ''}">${esc(campaign.status)}</span>
          <button class="btn ghost small" data-delete="${esc(campaign.id)}">Delete</button>
        </div>`
              )
              .join('')
          : '<div class="empty">No runs yet.</div>'
      }
    </div>`;
}

// --- view: settings -------------------------------------------------------

async function viewSettings() {
  const { config, keys, githubToken } = state.settings;
  const providers = state.info.providers;
  const bridge = (await call(api.bridge.status(), { silent: true })) || {};

  content.innerHTML = `
    <div class="view">
      <h1>Settings</h1>
      <p class="lede">
        Keys are encrypted against your Windows account${state.info.encryption ? '' : ' (encryption unavailable here — stored as plain text)'}.
        Nothing leaves this machine except calls to the APIs you configure.
      </p>

      <div class="card">
        <h2>GitHub</h2>
        <label class="field">
          <span>Personal access token</span>
          <input type="password" id="ghToken" placeholder="${githubToken ? '•••••••••• saved' : 'ghp_…'}" />
          <span class="hint">No scopes needed — public data only.
            <a href="https://github.com/settings/tokens/new?description=Chorus&scopes=" data-external>Create one</a></span>
        </label>
        <div class="btn-row">
          <button class="btn small" id="saveToken">Save token</button>
          <button class="btn ghost small" id="testToken">Test</button>
          <span id="ghStatus" class="status-text"></span>
        </div>
      </div>

      <div class="card">
        <h2>AI provider</h2>
        <label class="field">
          <span>Provider</span>
          <select id="provider">
            ${Object.entries(providers)
              .map(
                ([id, meta]) =>
                  `<option value="${esc(id)}" ${config.ai.provider === id ? 'selected' : ''}>${esc(meta.label)}</option>`
              )
              .join('')}
          </select>
          <span class="hint" id="providerHint"></span>
        </label>

        <label class="field" id="keyField">
          <span>API key</span>
          <input type="password" id="aiKey" placeholder="paste key" />
        </label>

        <label class="field">
          <span>Model</span>
          <input type="text" id="model" value="${esc(config.ai.model)}" placeholder="${esc(providers[config.ai.provider]?.defaultModel || '')}" />
          <span class="hint">Leave empty for the provider default.</span>
        </label>

        <div class="row">
          <label class="field">
            <span>Message tone</span>
            <select id="tone">
              ${state.info.tones
                .map(
                  (tone) =>
                    `<option value="${esc(tone.id)}" ${config.ai.tone === tone.id ? 'selected' : ''}>${esc(tone.id)} — ${esc(tone.description)}</option>`
                )
                .join('')}
            </select>
          </label>
          <label class="field">
            <span>Max message length</span>
            <input type="number" id="maxChars" min="100" value="${config.ai.maxChars}" />
          </label>
        </div>

        <label class="field">
          <span>Extra drafting instructions</span>
          <textarea id="extraInstructions" placeholder="Mention it is MIT licensed. Never use exclamation marks.">${esc(config.ai.extraInstructions)}</textarea>
        </label>

        <div class="btn-row">
          <button class="btn small" id="saveAi">Save</button>
          <button class="btn ghost small" id="testAi">Test key</button>
          <span id="aiStatus" class="status-text"></span>
        </div>
      </div>

      <div class="card">
        <h2>Browser extension</h2>
        <div class="body-text mb-14">
          The companion extension adds a <b>Send to Chorus</b> button to GitHub pages so you can
          queue up people while you browse. It talks to this app over
          <b>127.0.0.1</b> only — never over the network.
        </div>

        <div class="kv">
          <span>Bridge</span>
          <b class="${bridge.running ? 'ok' : 'bad'}">${bridge.running ? `running on port ${bridge.port}` : 'not running'}</b>
        </div>
        <div class="kv"><span>Waiting in watchlist</span><b>${bridge.watchlist ?? 0}</b></div>

        <label class="field mt-14">
          <span>Pairing code — paste this into the extension</span>
          <input type="text" id="pairCode" readonly value="${esc(bridge.token || '')}" />
        </label>
        <div class="btn-row">
          <button class="btn small" id="copyPair">Copy code</button>
          <button class="btn ghost small" id="rotatePair">Generate a new one</button>
        </div>

        <div class="divider"></div>
        <div class="body-text loose">
          <b>Installing it:</b><br />
          1. Open <span class="tag">chrome://extensions</span><br />
          2. Turn on <b>Developer mode</b> (top right)<br />
          3. Click <b>Load unpacked</b> and pick the <span class="tag">extension</span> folder in this project<br />
          4. Open the extension and paste the pairing code above
        </div>
      </div>

      <div class="card">
        <h2>Outreach</h2>
        <label class="checkline">
          <input type="checkbox" id="skipContacted" ${config.outreach.skipAlreadyContacted ? 'checked' : ''} />
          Never surface someone I have already contacted, in any campaign
        </label>
        <label class="field">
          <span>Daily counter</span>
          <input type="number" id="dailyCap" min="0" value="${config.outreach.dailyDraftCap}" />
          <span class="hint"><b>0 = no limit.</b> Set a number only if you want the sidebar to show
            progress against a target. Nothing is ever blocked.</span>
        </label>
        <button class="btn small" id="saveOutreach">Save</button>
      </div>

      <div class="card">
        <h2>What this app will not do</h2>
        <div class="body-text relaxed">
          It does not log into any account, send any message, follow anyone, or automate a browser.
          It reads public APIs, writes drafts, and hands them to you. Every message that reaches a
          person was sent by you — which is also why they get replies.
        </div>
      </div>
    </div>`;

  wireSettings(providers, keys);
}

function wireSettings(providers, keys) {
  const providerSelect = document.getElementById('provider');

  const updateHint = () => {
    const meta = providers[providerSelect.value];
    document.getElementById('keyField').style.display = meta.signup ? 'block' : 'none';
    document.getElementById('aiKey').placeholder = keys[providerSelect.value] ? '•••••••••• saved' : 'paste key';
    document.getElementById('providerHint').innerHTML = meta.signup
      ? `Free key at <a href="${esc(meta.signup)}" data-external>${esc(meta.signup)}</a>`
      : 'Runs with no API key using built-in heuristics. Results are rougher.';
  };
  providerSelect.addEventListener('change', updateHint);
  updateHint();

  document.getElementById('saveToken').addEventListener('click', async () => {
    const value = document.getElementById('ghToken').value.trim();
    if (!value) return toast('Paste a token first.');
    await call(api.settings.setGithubToken(value));
    state.settings = await call(api.settings.get());
    toast('Token saved.');
    refreshSidebar();
  });

  document.getElementById('testToken').addEventListener('click', async () => {
    const status = document.getElementById('ghStatus');
    status.textContent = 'checking…';
    const result = await call(api.github.status());
    status.textContent = result?.authenticated
      ? `✓ ${result.login} — ${result.remaining}/${result.limit} left this hour`
      : `not authenticated — ${result?.error || '60 requests/hour'}`;
  });

  document.getElementById('testAi').addEventListener('click', async () => {
    const status = document.getElementById('aiStatus');
    status.textContent = 'testing…';
    const result = await call(
      api.settings.testKey(providerSelect.value, document.getElementById('aiKey').value.trim()),
      { silent: true }
    );
    status.textContent = result?.ok ? `✓ working (${result.model})` : '✗ rejected';
  });

  document.getElementById('saveAi').addEventListener('click', async () => {
    const key = document.getElementById('aiKey').value.trim();
    if (key) await call(api.settings.setKey(providerSelect.value, key));
    await call(
      api.settings.save({
        ai: {
          provider: providerSelect.value,
          model: document.getElementById('model').value.trim(),
          tone: document.getElementById('tone').value,
          maxChars: Number(document.getElementById('maxChars').value) || 700,
          extraInstructions: document.getElementById('extraInstructions').value.trim()
        }
      })
    );
    state.settings = await call(api.settings.get());
    toast('Saved.');
    refreshSidebar();
  });

  document.getElementById('copyPair').addEventListener('click', async () => {
    await call(api.copy(document.getElementById('pairCode').value));
    toast('Pairing code copied.');
  });

  document.getElementById('rotatePair').addEventListener('click', async () => {
    const fresh = await call(api.bridge.rotate());
    if (fresh) {
      document.getElementById('pairCode').value = fresh;
      toast('New code generated — re-pair the extension.');
    }
  });

  document.getElementById('saveOutreach').addEventListener('click', async () => {
    await call(
      api.settings.save({
        outreach: {
          skipAlreadyContacted: document.getElementById('skipContacted').checked,
          dailyDraftCap: Math.max(0, Number(document.getElementById('dailyCap').value) || 0)
        }
      })
    );
    state.settings = await call(api.settings.get());
    toast('Saved.');
  });
}

// --- delegated events -----------------------------------------------------

content.addEventListener('click', async (event) => {
  const targetAction = event.target.closest('button[data-action]');
  if (targetAction) return handleTargetAction(targetAction);

  const watchAction = event.target.closest('button[data-watch-action]');
  if (watchAction) return handleWatchAction(watchAction);

  const del = event.target.closest('button[data-delete]');
  if (del) {
    event.stopPropagation();
    await call(api.campaigns.remove(del.dataset.delete));
    if (state.campaignId === del.dataset.delete) {
      state.campaignId = null;
      state.campaign = null;
    }
    viewCampaigns();
    return;
  }

  const row = event.target.closest('.campaign-row');
  if (row) {
    state.campaignId = row.dataset.id;
    state.campaign = await call(api.campaigns.get(row.dataset.id));
    setView('targets');
  }
});

async function handleTargetAction(button) {
  const card = button.closest('.target');
  if (!card) return;
  const targetId = card.dataset.id;
  const textarea = card.querySelector('[data-draft]');

  switch (button.dataset.action) {
    case 'copy':
      await call(api.copy(textarea.value));
      toast('Copied. Paste it wherever you are writing to them.');
      break;
    case 'save':
      await call(api.targets.update(state.campaignId, targetId, { draft: textarea.value }));
      toast('Draft saved.');
      break;
    case 'mark':
      await call(api.targets.markContacted(state.campaignId, targetId));
      await reloadCampaign();
      refreshSidebar();
      break;
    case 'unmark':
      await call(api.targets.unmarkContacted(state.campaignId, targetId));
      await reloadCampaign();
      refreshSidebar();
      break;
    case 'skip':
      await call(api.targets.update(state.campaignId, targetId, { status: 'skipped' }));
      card.remove();
      break;
  }
}

async function handleWatchAction(button) {
  const card = button.closest('[data-watch]');
  const id = card.dataset.watch;
  const login = id.replace(/^github:/, '');

  if (button.dataset.watchAction === 'assess') {
    button.disabled = true;
    button.textContent = 'Assessing…';
    const result = await call(api.watchlist.assess(login, state.campaignId));
    if (result) {
      state.assessed[id] = result;
      viewWatchlist();
    } else {
      button.disabled = false;
      button.textContent = 'Assess and draft';
    }
    return;
  }

  if (button.dataset.watchAction === 'copy') {
    await call(api.copy(card.querySelector('[data-draft]').value));
    toast('Copied.');
    return;
  }

  if (button.dataset.watchAction === 'remove') {
    await call(api.watchlist.remove(id));
    delete state.assessed[id];
    viewWatchlist();
    refreshSidebar();
  }
}

async function reloadCampaign() {
  if (!state.campaignId) return;
  state.campaign = await call(api.campaigns.get(state.campaignId));
  if (state.view === 'targets' && !state.running) renderCampaign();
}

// --- render ---------------------------------------------------------------

function render() {
  if (state.view === 'setup') return viewSetup();
  if (state.view === 'new') return viewNew();
  if (state.view === 'targets') return viewTargets();
  if (state.view === 'watchlist') return viewWatchlist();
  if (state.view === 'campaigns') return viewCampaigns();
  if (state.view === 'settings') return viewSettings();
}

// --- streams --------------------------------------------------------------

api.research.onProgress(async (payload) => {
  if (payload.message) {
    state.logLines.push({ stage: payload.stage?.id || '', message: payload.message, level: payload.level });
    if (state.logLines.length > 300) state.logLines.shift();
  }

  if (payload.finding) {
    state.findings.push(payload.finding);
    if (state.findings.length > 400) state.findings.shift();
  }

  if (payload.type === 'progress') {
    state.progress = payload;
    if (state.view === 'targets' && state.running) {
      // This handler is async, so a throw in here would become a silent
      // unhandled rejection and the graph would just stop updating.
      try {
        updateRunning(payload);
      } catch (error) {
        console.error('graph update failed:', error);
      }
    }
    return;
  }

  // done / error / cancelled
  state.running = false;
  state.progress = payload;
  state.campaignId = payload.campaignId || state.campaignId;
  await reloadCampaign();
  refreshSidebar();
  if (state.view === 'targets') render();
  toast(payload.message);
});

api.watchlist.onChange(() => {
  refreshSidebar();
  if (state.view === 'watchlist') viewWatchlist();
  else toast('Someone was added to your watchlist from the extension.');
});

// --- the sign-in gate -----------------------------------------------------
//
// Covers everything until answered. The password is sent straight to the main
// process and never held here: the field is read once on submit and cleared.

function renderGate({ mode, error = '', busy = false }) {
  const signUp = mode === 'signup';
  document.getElementById('gate')?.remove();

  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.id = 'gate';
  gate.innerHTML = `
    <form class="gate-card" id="gateForm" autocomplete="off">
      <img class="gate-mark" src="logo.svg" alt="" />
      <div class="gate-title">${signUp ? 'Create your account' : 'Welcome back'}</div>
      <div class="gate-sub">
        ${
          signUp
            ? 'A username and a password, kept on this computer. No email, no server, nothing to verify.'
            : 'Sign in to reach your research, drafts and connected accounts.'
        }
      </div>

      <label class="field">
        <span>Username</span>
        <input type="text" id="gateUser" autocomplete="username" spellcheck="false" required />
      </label>

      <label class="field">
        <span>Password</span>
        <input type="password" id="gatePass" autocomplete="${signUp ? 'new-password' : 'current-password'}" required />
        ${signUp ? `<span class="hint">At least ${state.authMinPassword || 8} characters.</span>` : ''}
      </label>

      ${
        signUp
          ? `<label class="field">
               <span>Confirm password</span>
               <input type="password" id="gatePass2" autocomplete="new-password" required />
             </label>`
          : ''
      }

      <div class="gate-error" id="gateError">${esc(error)}</div>

      <div class="gate-actions">
        <button class="btn" type="submit" id="gateSubmit" ${busy ? 'disabled' : ''}>
          ${busy ? 'Working…' : signUp ? 'Create account' : 'Sign in'}
        </button>
      </div>

      <div class="gate-switch">
        ${
          signUp
            ? 'Already have an account? <button type="button" id="gateSwitch">Sign in</button>'
            : 'No account yet? <button type="button" id="gateSwitch">Create one</button>'
        }
      </div>

      ${
        signUp
          ? `<div class="gate-note">
               Your password is never stored — only a slow hash of it, salted for this account.
               There is no recovery, because there is nowhere to send a reset to.
             </div>`
          : ''
      }
    </form>
  `;

  document.body.appendChild(gate);
  document.getElementById('gateUser').focus();

  document.getElementById('gateSwitch')?.addEventListener('click', () => {
    renderGate({ mode: signUp ? 'login' : 'signup' });
  });

  document.getElementById('gateForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('gateUser').value;
    const password = document.getElementById('gatePass').value;

    if (signUp) {
      const confirm = document.getElementById('gatePass2').value;
      if (password !== confirm) {
        renderGate({ mode, error: 'The two passwords are not the same.' });
        return;
      }
    }

    renderGate({ mode, busy: true });
    const result = signUp ? await api.auth.signUp(username, password) : await api.auth.logIn(username, password);

    if (!result.ok) {
      renderGate({ mode, error: result.error });
      return;
    }

    document.getElementById('gate')?.remove();
    state.user = result.data;
    await bootApp();
  });
}

function paintUser() {
  const foot = document.querySelector('.rail-foot');
  if (!foot || !state.user) return;
  document.getElementById('railUser')?.remove();

  const row = document.createElement('div');
  row.className = 'rail-user';
  row.id = 'railUser';

  const avatar = document.createElement('div');
  avatar.className = 'rail-user-avatar';
  avatar.textContent = (state.user.displayName || state.user.username).charAt(0).toUpperCase();

  const name = document.createElement('span');
  name.className = 'rail-label';
  name.textContent = state.user.displayName || state.user.username;

  const out = document.createElement('button');
  out.className = 'rail-signout rail-label';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    await call(api.auth.logOut());
    state.user = null;
    renderGate({ mode: 'login' });
  });

  row.append(avatar, name, out);
  foot.appendChild(row);
}

// --- boot -----------------------------------------------------------------

async function bootApp() {
  state.info = await call(api.info());
  state.settings = await call(api.settings.get());
  state.running = Boolean(await call(api.research.running(), { silent: true }));

  const campaigns = (await call(api.campaigns.list())) || [];
  if (campaigns.length) {
    state.campaignId = campaigns[0].id;
    state.campaign = await call(api.campaigns.get(campaigns[0].id));
  }

  const needsSetup =
    !state.settings.config.setupDone && !state.settings.githubToken && !campaigns.length;

  if (needsSetup) {
    state.view = 'setup';
    render();
  } else {
    setView(state.running ? 'targets' : 'new');
  }

  paintUser();
  refreshSidebar();
  if (!bootApp.polling) {
    bootApp.polling = setInterval(refreshSidebar, 20000);
  }
}

// Nothing is loaded until the gate is answered — not even the provider list.
(async () => {
  const auth = await call(api.auth.state(), { silent: true });
  state.authMinPassword = auth?.minPassword || 8;

  if (auth?.signedIn) {
    state.user = auth.user;
    await bootApp();
    return;
  }

  renderGate({ mode: auth?.firstRun ? 'signup' : 'login' });
})();
