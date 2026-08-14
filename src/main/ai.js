const { getStore } = require('./store');

const PROVIDERS = {
  offline: { label: 'Built-in heuristics (no API key)', keyName: null, defaultModel: '' },
  gemini: {
    label: 'Google Gemini — free tier',
    keyName: 'geminiKey',
    defaultModel: 'gemini-2.5-flash',
    signup: 'https://aistudio.google.com/apikey'
  },
  groq: {
    label: 'Groq — free tier',
    keyName: 'groqKey',
    defaultModel: 'llama-3.3-70b-versatile',
    signup: 'https://console.groq.com/keys'
  },
  openrouter: {
    label: 'OpenRouter — free models',
    keyName: 'openrouterKey',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    signup: 'https://openrouter.ai/keys'
  },
  anthropic: {
    label: 'Anthropic Claude — paid',
    keyName: 'anthropicKey',
    defaultModel: 'claude-sonnet-5',
    signup: 'https://console.anthropic.com/settings/keys'
  }
};

const TONES = {
  peer: 'one developer writing to another — plain, specific, no marketing voice',
  brief: 'as short as possible while still being personal; three sentences maximum',
  warm: 'friendly and appreciative, but concrete about why you are writing',
  formal: 'professional and reserved, suitable for someone you have never interacted with'
};

function activeProvider() {
  const cfg = getStore().config.ai;
  return PROVIDERS[cfg.provider] ? cfg.provider : 'offline';
}

async function complete(system, user, { temperature = 0.7, maxTokens = 1600 } = {}) {
  const store = getStore();
  const cfg = store.config.ai;
  const provider = activeProvider();
  if (provider === 'offline') throw new Error('OFFLINE');

  const meta = PROVIDERS[provider];
  const key = store.getSecret(meta.keyName);
  if (!key) throw new Error(`No API key saved for ${meta.label}. Add one in Settings.`);
  const model = cfg.model || meta.defaultModel;

  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens }
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Gemini error (${res.status}).`);
    return (json.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Anthropic error (${res.status}).`);
    return (json.content || []).map((block) => block.text || '').join('');
  }

  const endpoints = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions'
  };
  const res = await fetch(endpoints[provider], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...(provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/BofStudios/chorus', 'X-Title': 'Chorus' }
        : {})
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `${meta.label} error (${res.status}).`);
  return json.choices?.[0]?.message?.content || '';
}

function parseJson(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// --- 1. Project analysis --------------------------------------------------

const ANALYSIS_SYSTEM = `You help an open-source maintainer work out who would genuinely benefit from their project.

You are not writing marketing copy. You are doing research. Be honest: if a project is niche, say so, and describe the small audience precisely rather than inventing a large vague one.

Return ONLY a JSON object with these keys:
{
  "summary": "two sentences on what this project actually does",
  "problem": "the specific problem it solves, in one sentence",
  "whoCares": ["3-5 concrete descriptions of people who would find this useful, e.g. 'maintainers of Electron apps who ship auto-updates'"],
  "keywords": ["5-8 search keywords, lowercase, no punctuation"],
  "githubTopics": ["4-6 GitHub topic slugs that neighbouring projects would use"],
  "repoQueries": ["3-4 GitHub repository search queries, e.g. 'topic:electron topic:updater stars:>50'"],
  "issueQueries": ["2-3 GitHub issue search queries that surface people hitting this exact problem, e.g. 'electron auto update fails in:title state:open'"],
  "hnQueries": ["2-3 short Hacker News search phrases"],
  "notFor": ["2-3 groups this is NOT for, so they can be filtered out"]
}`;

function offlineAnalysis(project) {
  const topics = project.repo.topics || [];
  const language = project.repo.language || '';
  const name = project.repo.name;
  const keywords = [...new Set([...topics, language.toLowerCase(), name.toLowerCase()].filter(Boolean))].slice(0, 8);
  return {
    summary: project.repo.description || `${name} — no description set on the repository.`,
    problem: project.pitch || 'Not described. Add a pitch in the campaign for better results.',
    whoCares: [
      `Developers working with ${language || 'this stack'}`,
      ...topics.slice(0, 3).map((topic) => `People maintaining ${topic} projects`)
    ].filter(Boolean),
    keywords,
    githubTopics: topics.slice(0, 6),
    repoQueries: [
      topics.length ? `topic:${topics[0]} stars:>50` : `${name} in:name stars:>50`,
      language ? `language:${language} ${topics[0] || name} stars:>100` : `${name} stars:>100`
    ].filter(Boolean),
    issueQueries: [`${topics[0] || name} in:title state:open`],
    hnQueries: [topics[0] || name].filter(Boolean),
    notFor: []
  };
}

async function analyseProject(project) {
  if (activeProvider() === 'offline') return { ...offlineAnalysis(project), source: 'heuristics' };

  const user = [
    `Repository: ${project.repo.fullName}`,
    `Description: ${project.repo.description || '(none)'}`,
    `Language: ${project.repo.language || '(unknown)'}`,
    `Topics: ${(project.repo.topics || []).join(', ') || '(none)'}`,
    `Stars: ${project.repo.stars}`,
    project.pitch ? `Maintainer's own pitch: ${project.pitch}` : '',
    project.audience ? `Maintainer thinks the audience is: ${project.audience}` : '',
    project.readme ? `README (truncated):\n${project.readme.slice(0, 5000)}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete(ANALYSIS_SYSTEM, user, { temperature: 0.4 });
  const parsed = parseJson(raw);
  if (!parsed) throw new Error('The model did not return usable analysis JSON. Try a different model.');
  return { ...offlineAnalysis(project), ...parsed, source: 'model' };
}

// --- 2. Candidate scoring -------------------------------------------------

const SCORING_SYSTEM = `You judge whether a specific developer would genuinely care about a specific open-source project.

Be sceptical. Most people are a bad match, and saying so is the useful answer. A high score requires concrete evidence in this person's own public work — not a vague topic overlap.

Scoring guide:
- 80-100: their own public work directly involves this exact problem
- 60-79: adjacent work; a message would be relevant but not obviously welcome
- 40-59: same broad ecosystem, no specific link
- 0-39: no real connection; do not contact

Return ONLY a JSON object:
{
  "score": 0-100,
  "rationale": "one or two sentences citing the specific repo, issue or bio detail that justifies the score",
  "angle": "the single most honest reason to write to THIS person, or empty string if there isn't one",
  "channel": "one of: github-issue, github-discussion, email, twitter, blog-contact, none",
  "channelNote": "where exactly, e.g. 'open a discussion on their repo foo/bar' or 'email listed on profile'",
  "caution": "anything that should stop you writing, e.g. 'inactive for two years' — empty string if none"
}`;

function offlineScore(project, candidate) {
  const projectTopics = new Set([
    ...(project.analysis.githubTopics || []),
    ...(project.analysis.keywords || [])
  ].map((topic) => String(topic).toLowerCase()));

  let score = 25;
  const reasons = [];

  const theirTopics = new Set(
    candidate.repos.flatMap((repo) => [...(repo.topics || []), repo.language || ''].filter(Boolean).map((t) => t.toLowerCase()))
  );
  const overlap = [...theirTopics].filter((topic) => projectTopics.has(topic));
  if (overlap.length) {
    score += Math.min(30, overlap.length * 10);
    reasons.push(`shared topics: ${overlap.slice(0, 3).join(', ')}`);
  }

  if (candidate.evidence.some((item) => item.type === 'contributor')) {
    score += 20;
    reasons.push('contributes to a neighbouring project');
  }
  if (candidate.evidence.some((item) => item.type === 'issue')) {
    score += 15;
    reasons.push('opened an issue in this problem space');
  }

  const lastPush = candidate.repos[0]?.pushedAt ? Date.parse(candidate.repos[0].pushedAt) : 0;
  const daysSince = lastPush ? (Date.now() - lastPush) / 86400000 : 9999;
  if (daysSince < 90) score += 10;
  else if (daysSince > 730) score -= 20;

  const channel = candidate.profile.email
    ? 'email'
    : candidate.profile.blog
      ? 'blog-contact'
      : candidate.profile.twitter
        ? 'twitter'
        : 'github-issue';

  return {
    score: Math.max(0, Math.min(100, score)),
    rationale: reasons.length ? `Heuristic match — ${reasons.join('; ')}.` : 'No strong signal found.',
    angle: overlap.length ? `Both work on ${overlap[0]}.` : '',
    channel,
    channelNote: candidate.profile.email
      ? `Email listed publicly on their GitHub profile: ${candidate.profile.email}`
      : candidate.profile.blog
        ? `Contact details on ${candidate.profile.blog}`
        : 'Open a discussion or issue on one of their repositories',
    caution: daysSince > 730 ? 'No public activity in over two years.' : ''
  };
}

async function scoreCandidate(project, candidate) {
  if (activeProvider() === 'offline') return { ...offlineScore(project, candidate), source: 'heuristics' };

  const user = [
    `PROJECT: ${project.repo.fullName}`,
    `What it does: ${project.analysis.summary}`,
    `Problem it solves: ${project.analysis.problem}`,
    `Ideal audience: ${(project.analysis.whoCares || []).join(' / ')}`,
    project.analysis.notFor?.length ? `Explicitly NOT for: ${project.analysis.notFor.join(' / ')}` : '',
    '',
    `PERSON: @${candidate.profile.login}${candidate.profile.name ? ` (${candidate.profile.name})` : ''}`,
    candidate.profile.bio ? `Bio: ${candidate.profile.bio}` : '',
    candidate.profile.company ? `Company: ${candidate.profile.company}` : '',
    `Followers: ${candidate.profile.followers}, public repos: ${candidate.profile.publicRepos}`,
    candidate.profile.blog ? `Website: ${candidate.profile.blog}` : '',
    candidate.profile.email ? `Public email on profile: ${candidate.profile.email}` : 'No public email on profile',
    candidate.profile.twitter ? `Twitter/X: @${candidate.profile.twitter}` : '',
    '',
    'How they surfaced in research:',
    ...candidate.evidence.map((item) => `- ${item.type}: ${item.label}${item.url ? ` (${item.url})` : ''}`),
    '',
    'Their most recently pushed repositories:',
    ...candidate.repos
      .slice(0, 6)
      .map(
        (repo) =>
          `- ${repo.fullName} [${repo.language || 'n/a'}, ${repo.stars}★, pushed ${(repo.pushedAt || '').slice(0, 10)}] ${repo.description.slice(0, 120)}`
      )
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete(SCORING_SYSTEM, user, { temperature: 0.3, maxTokens: 700 });
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed.score !== 'number') return { ...offlineScore(project, candidate), source: 'fallback' };
  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    rationale: parsed.rationale || '',
    angle: parsed.angle || '',
    channel: parsed.channel || 'github-issue',
    channelNote: parsed.channelNote || '',
    caution: parsed.caution || '',
    source: 'model'
  };
}

// --- 3. Message drafting --------------------------------------------------

function draftSystem(cfg) {
  const tone = TONES[cfg.tone] || TONES.peer;
  return `You draft a single outreach message from an open-source maintainer to another developer. A human reads and sends it manually — never assume it will be sent automatically.

Tone: ${tone}.
Hard limit: ${cfg.maxChars} characters.
${cfg.language === 'auto' ? 'Write in English unless the recipient clearly works in another language.' : `Write in ${cfg.language}.`}

Rules:
- Open with the specific thing about THEIR work that made you write. Name the repo, issue or post.
- State plainly what your project does and why it connects to what they are doing.
- Ask one genuine question, or offer something concrete. Do not ask for a star.
- No flattery that could apply to anyone. No "I hope this finds you well". No growth-hacking voice.
- Do not claim to have used their project unless the research says so.
- If the research shows no honest reason to write to this person, reply with exactly: NO_HONEST_ANGLE
${cfg.extraInstructions ? `- Maintainer's instructions: ${cfg.extraInstructions}` : ''}

Return only the message text. No subject line, no signature, no quotes around it.`;
}

function offlineDraft(project, candidate, scoring) {
  const repo = candidate.repos[0];
  const opener = repo
    ? `I came across ${repo.fullName} while looking at ${project.analysis.keywords?.[0] || 'this space'}.`
    : `I came across your work on GitHub while looking at ${project.analysis.keywords?.[0] || 'this space'}.`;
  return [
    `Hi ${candidate.profile.name || candidate.profile.login},`,
    '',
    opener,
    '',
    `I maintain ${project.repo.fullName} — ${project.analysis.summary}`,
    scoring.angle ? `\n${scoring.angle}` : '',
    '',
    'Would it be useful to you? Happy to hear if it misses the mark.',
    '',
    `— ${project.repo.owner}`
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

async function draftMessage(project, candidate, scoring) {
  const cfg = getStore().config.ai;
  if (activeProvider() === 'offline') {
    return { text: offlineDraft(project, candidate, scoring).slice(0, cfg.maxChars), source: 'heuristics' };
  }

  const user = [
    `YOUR PROJECT: ${project.repo.fullName} (${project.repo.url})`,
    `What it does: ${project.analysis.summary}`,
    `Problem solved: ${project.analysis.problem}`,
    project.pitch ? `Maintainer's own words: ${project.pitch}` : '',
    '',
    `RECIPIENT: @${candidate.profile.login}${candidate.profile.name ? ` (${candidate.profile.name})` : ''}`,
    candidate.profile.bio ? `Bio: ${candidate.profile.bio}` : '',
    `Why they are relevant: ${scoring.rationale}`,
    scoring.angle ? `The honest angle: ${scoring.angle}` : '',
    `Intended channel: ${scoring.channel} — ${scoring.channelNote}`,
    '',
    'Their recent work:',
    ...candidate.repos
      .slice(0, 4)
      .map((repo) => `- ${repo.fullName}: ${repo.description.slice(0, 120)} [${repo.language || 'n/a'}, ${repo.stars}★]`),
    ...candidate.evidence.map((item) => `- ${item.type}: ${item.label}`)
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete(draftSystem(cfg), user, { temperature: 0.8, maxTokens: 900 });
  const text = (raw || '').trim();
  if (!text || text === 'NO_HONEST_ANGLE') {
    return { text: '', source: 'model', refused: true };
  }
  return { text: text.slice(0, cfg.maxChars), source: 'model' };
}

// Cheapest possible round trip to confirm a key is valid and the model name exists.
async function testKey(provider, key) {
  const meta = PROVIDERS[provider];
  if (!meta?.keyName) throw new Error('That provider needs no key.');
  const model = getStore().config.ai.model || meta.defaultModel;

  const probe = 'Reply with the single word: ok';
  let text = '';

  if (provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: probe }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Gemini rejected the key (${res.status}).`);
    text = (json.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
  } else if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: probe }] })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Anthropic rejected the key (${res.status}).`);
    text = (json.content || []).map((block) => block.text || '').join('');
  } else {
    const endpoints = {
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions'
    };
    const res = await fetch(endpoints[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: probe }] })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `${meta.label} rejected the key (${res.status}).`);
    text = json.choices?.[0]?.message?.content || '';
  }

  return { ok: true, model, sample: text.trim().slice(0, 40) };
}

module.exports = {
  PROVIDERS,
  TONES,
  activeProvider,
  testKey,
  analyseProject,
  scoreCandidate,
  draftMessage
};
