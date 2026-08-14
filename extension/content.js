// Adds a single button to GitHub profile and repo pages. It does nothing until
// you click it, and all it ever does is hand the username to the desktop app.

(() => {
  const BUTTON_ID = 'chorus-send-button';

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

  function reset(button) {
    button.className = 'chorus-btn';
    button.innerHTML = '<span class="chorus-dot"></span>Send to Chorus';
  }

  function sync() {
    const context = pageContext();
    const existing = document.getElementById(BUTTON_ID);
    if (!context) {
      existing?.remove();
      return;
    }
    if (existing) existing.remove();
    mount(context);
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
