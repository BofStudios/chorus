# Privacy Policy — Chorus Companion

**Last updated:** 14 August 2026
**Publisher:** BofStudios
**Applies to:** the Chorus Companion Chrome extension and the Chorus desktop application

<br>

## The short version

Chorus Companion sends one thing, to one place: the GitHub username of a page you are looking at, to the Chorus desktop application running on your own computer. Nothing is transmitted to us, and there is no server to transmit it to.

<br>

## What the extension collects

| Data | When | Where it goes |
|---|---|---|
| The GitHub username shown on the page you are viewing | Only when you click **Send to Chorus** | `http://127.0.0.1` — the Chorus app on your own machine |
| The page URL and its public description | Only when you click **Send to Chorus** | Same as above |
| Your pairing code | When you paste it | `chrome.storage.local` on your own machine |
| A short list of usernames you recently sent | On each send | `chrome.storage.local` on your own machine |

That is the complete list.

<br>

## What the extension does not do

- It does not run without your click. The button on GitHub pages does nothing until you press it.
- It does not read pages other than `github.com`, and only reads the username and public description already visible on the page.
- It does not collect browsing history, form input, passwords, cookies, or personal information.
- It does not contact any server on the internet. Its only network destination is `127.0.0.1`, which never leaves your computer.
- It does not use analytics, tracking pixels, advertising identifiers, or third-party SDKs.
- It does not sell, rent, share, or transfer data to anyone, because it never receives any.

<br>

## What the desktop application does

The Chorus desktop app is where the actual work happens. It runs entirely on your computer and stores everything locally in your operating system's application-data directory.

It makes network requests to services **you** configure:

| Service | Purpose | What is sent |
|---|---|---|
| `api.github.com` | Read public repositories, profiles and issues | Your search queries and, if you provide one, your GitHub token |
| `hn.algolia.com` | Find public Hacker News discussions | Search keywords |
| Your chosen AI provider (Google Gemini, Groq, OpenRouter or Anthropic) | Analyse your repository, assess matches, draft messages | Your project description and the public profile data of the people being assessed |

If you do not configure an AI provider, the app runs on built-in heuristics and contacts no model provider at all.

API keys are encrypted at rest using Electron's `safeStorage`, which on Windows binds the encrypted blob to your Windows user account via DPAPI.

<br>

## What neither the extension nor the app will do

Chorus never signs into any account, sends any message, follows anyone, posts anything, or automates a browser. Every message it produces is a draft that you read, edit, and send yourself through whatever channel you choose.

<br>

## Data retention and deletion

All data lives on your computer. To delete it:

- **Extension data:** remove the extension, or open its popup and press **Unpair**.
- **Desktop app data:** delete the application-data folder shown in the app under Settings.

There is nothing stored elsewhere for us to delete on your behalf.

<br>

## Children

Chorus is a developer tool and is not directed at children under 13.

<br>

## Changes

If this policy changes, the updated version will be published in this repository with a new date at the top.

<br>

## Contact

Open an issue at [github.com/BofStudios/chorus/issues](https://github.com/BofStudios/chorus/issues).
