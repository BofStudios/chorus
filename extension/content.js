// Adds buttons to GitHub profile and repo pages. They do nothing until you
// click one, and all they ever send is the username on the page you opened.
//
// Two actions, because there are two questions a maintainer has on GitHub:
//   · Send to Chorus   — this person is worth writing to
//   · Analyse repos    — are *these* repositories even ready to promote?
//
// The second needs no GitHub OAuth app. Listing someone's public repositories
// requires no permission, so Chorus does the reading with the research token it
// already has; the extension only has to say whose profile you are looking at.

(() => {
  const BUTTON_ID = 'chorus-send-button';
  const ANALYSE_ID = 'chorus-analyse-button';

  function pageContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;

    const owner = parts[0];
    if (['orgs', 'settings', 'notifications', 'explore', 'topics', 'search', 'marketplace'].includes(owner)) {
      return null;
    }

    // Profile page: github.com/<user>
    if (parts.length === 1) {
      const isOrg = document.querySelector('meta[name="octolytics-dimension-user_login"]') === null
        && document.querySelector('.orghead') !== null;
      if (isOrg) return null;
      const bio = document.querySelector('[data-bio-text]')?.textContent?.trim() || '';
      return { login: owner, context: bio ? `profile: ${bio}` : 'profile page', url: `https://github.com/${owner}` };
    }

    // Repo page: github.com/<owner>/<repo>
    const repo = parts[1];
    const description = document.querySelector('meta[name="description"]')?.content || '';
    return {
      login: owner,
      context: `repo ${owner}/${repo}${description ? ` — ${description.slice(0, 160)}` : ''}`,
      url: `https://github.com/${owner}/${repo}`
    };
  }

  function mount(context) {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'chorus-btn';
    button.type = 'button';
    button.innerHTML = '<span class="chorus-dot"></span>Send to Chorus';
    button.title = `Hand @${context.login} to the Chorus desktop app`;

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Sending…';

      chrome.runtime.sendMessage({ type: 'send', payload: context }, (response) => {
        button.disabled = false;
        if (!response?.ok) {
          button.className = 'chorus-btn chorus-err';
          button.textContent = response?.error?.slice(0, 60) || 'Failed';
          setTimeout(() => reset(button), 4000);
          return;
        }
        button.className = 'chorus-btn chorus-ok';
        button.textContent = response.data.duplicate ? 'Already on the list' : 'Added to Chorus';
        setTimeout(() => reset(button), 3000);
      });
    });

    document.body.appendChild(button);
  }

  /**
   * "Analyse repos" — offered on profile pages, where the question is whether
   * this account has anything worth promoting. The verdict is rendered in a
   * small panel rather than a toast, because the useful part is the list of
   * what to fix, not a single number.
   */
  function mountAnalyse(context) {
    if (document.getElementById(ANALYSE_ID)) return;

    const button = document.createElement('button');
    button.id = ANALYSE_ID;
    button.className = 'chorus-btn chorus-secondary';
    button.type = 'button';
    button.textContent = 'Analyse repos';
    button.title = `Ask Chorus which of @${context.login}'s repositories are ready to promote`;

    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Reading repositories…';

      chrome.runtime.sendMessage({ type: 'analyse', login: context.login }, (response) => {
        button.disabled = false;
        button.textContent = 'Analyse repos';

        if (!response?.ok) {
          button.className = 'chorus-btn chorus-secondary chorus-err';
          button.textContent = (response?.error || 'Failed').slice(0, 60);
          setTimeout(() => {
            button.className = 'chorus-btn chorus-secondary';
            button.textContent = 'Analyse repos';
          }, 4000);
          return;
        }
        renderVerdict(response.data);
      });
    });

    document.body.appendChild(button);
  }

  function renderVerdict(data) {
    document.getElementById('chorus-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'chorus-panel';
    panel.className = 'chorus-panel';

    const close = document.createElement('button');
    close.className = 'chorus-panel-close';
    close.textContent = '×';
    close.addEventListener('click', () => panel.remove());

    const title = document.createElement('div');
    title.className = 'chorus-panel-title';
    title.textContent = `${data.login} · ${data.total} repositories`;

    const summary = document.createElement('div');
    summary.className = 'chorus-panel-summary';
    summary.textContent = data.summary;

    panel.append(close, title, summary);

    const row = (repo, tone) => {
      const item = document.createElement('div');
      item.className = `chorus-repo ${tone}`;

      const head = document.createElement('div');
      head.className = 'chorus-repo-head';
      const score = document.createElement('span');
      score.className = 'chorus-score';
      score.textContent = repo.readiness ?? '';
      const name = document.createElement('span');
      name.textContent = repo.name;
      head.append(score, name);
      item.appendChild(head);

      for (const blocker of (repo.fixFirst || repo.blockers || []).slice(0, 2)) {
        const line = document.createElement('div');
        line.className = 'chorus-blocker';
        line.textContent = blocker;
        item.appendChild(line);
      }
      return item;
    };

    for (const repo of (data.ready || []).slice(0, 4)) panel.appendChild(row(repo, 'ok'));
    for (const repo of (data.nearlyReady || []).slice(0, 3)) panel.appendChild(row(repo, 'warn'));
    for (const repo of (data.notReady || []).slice(0, 2)) panel.appendChild(row(repo, 'bad'));

    if (data.ready?.length) {
      const cta = document.createElement('div');
      cta.className = 'chorus-panel-cta';
      cta.textContent = `Open Chorus and run research on ${data.ready[0].name} to find who would care.`;
      panel.appendChild(cta);
    }

    document.body.appendChild(panel);
  }

  function reset(button) {
    button.className = 'chorus-btn';
    button.innerHTML = '<span class="chorus-dot"></span>Send to Chorus';
  }

  function sync() {
    const context = pageContext();
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(ANALYSE_ID)?.remove();
    if (!context) {
      document.getElementById('chorus-panel')?.remove();
      return;
    }
    mount(context);
    // Only on a profile — on a single repo page the question does not apply.
    if (location.pathname.split('/').filter(Boolean).length === 1) mountAnalyse(context);
  }

  sync();

  // GitHub is a single-page app, so re-check when the URL changes.
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      setTimeout(sync, 400);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
