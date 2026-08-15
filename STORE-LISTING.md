# Chrome Web Store submission — copy & paste sheet

Everything the submission form asks for, pre-written. Upload
`dist-extension/chorus-companion-0.1.0.zip` and paste these in.

Dashboard: <https://chrome.google.com/webstore/devconsole>
(One-time $5 developer registration fee. Review usually takes a few days.)

---

## Item name

```
Chorus Companion
```

## Short description (132 characters max — this is 118)

```
Queue GitHub developers into the Chorus desktop app while you browse. One click, nothing automated, nothing uploaded.
```

## Category

```
Developer Tools
```

## Language

```
English (United States)
```

---

## Detailed description

```
Chorus Companion is the browser half of Chorus, a desktop research tool for open-source maintainers.

Chorus answers a question every maintainer has: who would actually care about the thing I built? It reads your repository, works out who it is genuinely for, finds those people through their public work on GitHub, explains the connection in writing, and drafts a message for each one. You read the drafts, edit them, and send them yourself.

This extension is the part that rides along while you browse. When you land on a GitHub profile or repository that looks relevant, press "Send to Chorus" and that developer is queued in the desktop app's watchlist. Later, one click assesses them against your project and writes a draft.

WHAT IT DOES
• Adds a "Send to Chorus" button to GitHub profile and repository pages
• Queues that developer into the Chorus desktop app running on your own computer
• Shows how many people are waiting in your watchlist
• Tells you when the desktop app is not running, and where to get it

WHAT IT DOES NOT DO
• It does not act on its own. The button does nothing until you click it.
• It does not send messages, follow, star, or post anything, anywhere.
• It does not automate the browser or simulate a human.
• It does not upload anything to us. Its only network destination is 127.0.0.1 — the app on your own machine. There is no Chorus server.
• It does not read anything beyond the username and public description already visible on the GitHub page you opened.

REQUIRES THE DESKTOP APP
This extension is a companion and does nothing on its own. The free, open-source Chorus desktop app for Windows is here:
https://github.com/BofStudios/chorus

HOW IT CONNECTS
The desktop app listens on 127.0.0.1 only — never on your network. The extension must present a pairing code you copy out of the app, and you can rotate that code at any time. The extension can hand over a username; it cannot read your research, start a run, or make the app send anything.

OPEN SOURCE
Every line of both the extension and the desktop app is MIT licensed and readable at https://github.com/BofStudios/chorus
```

---

## Single purpose description

```
This extension has one purpose: to let the user send a GitHub username from the page they are currently viewing to the Chorus desktop application running on their own computer.
```

## Permission justifications

**`storage`**

```
Stores the pairing code that authenticates this extension to the user's local Chorus desktop app, plus a short list of recently sent usernames shown in the popup. All of it stays in chrome.storage.local on the user's machine.
```

**`host_permissions` for `http://127.0.0.1:7801-7805/*`**

```
The Chorus desktop application runs a small HTTP server bound to 127.0.0.1 (the user's own computer) on one of these five ports. The extension must reach it to hand over a username and to check whether the app is running. These addresses are loopback only and never leave the machine. The extension contacts no remote server of any kind.
```

**Content script on `https://github.com/*`**

```
The extension adds a "Send to Chorus" button to GitHub profile and repository pages and, when the user clicks it, reads the username and public repository description already displayed on that page. It runs on no other site and reads nothing else.
```

## Are you using remote code?

```
No
```

## Data usage disclosures — tick these

- Does this item collect or use **personally identifiable information**? → **No**
- **Health information**? → No
- **Financial information**? → No
- **Authentication information**? → No
- **Personal communications**? → No
- **Location**? → No
- **Web history**? → No
- **User activity**? → No
- **Website content**? → **Yes** — a public GitHub username and public repository description, sent only to the user's own computer, only on an explicit click

Then certify all three:
- I do not sell or transfer user data to third parties outside of approved use cases → **Yes**
- I do not use or transfer user data for purposes unrelated to my item's single purpose → **Yes**
- I do not use or transfer user data to determine creditworthiness or for lending purposes → **Yes**

## Privacy policy URL

```
https://github.com/BofStudios/chorus/blob/main/PRIVACY.md
```

## Homepage URL

```
https://github.com/BofStudios/chorus
```

## Support URL

```
https://github.com/BofStudios/chorus/issues
```

---

## Graphics

| Asset | Size | Required? | Status |
|---|---|---|---|
| Store icon | 128×128 | Yes | Ready — `extension/icons/icon128.png` |
| Screenshot | 1280×800 | Yes, at least 1 | Ready — `docs/store/screenshot-1280x800.png` |
| Small promo tile | 440×280 | Optional | Not made — only needed to be featured |
| Marquee promo tile | 1400×560 | Optional | Not made — only needed to be featured |

Both required graphics are in the repo, so the submission needs no design work.
The screenshot shows the real popup and the real in-page button over a stand-in
profile; the person and repositories in it are invented so the listing does not
imply anyone endorses the extension.

---

## After it is published

Update the README install section to link the Web Store page instead of the
"load unpacked" instructions, and add the store link to the desktop app's
Settings → Extension panel.
