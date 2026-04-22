# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a visual dashboard of all your open tabs. Each tab is rendered as a mini browser window with a live screenshot preview, grouped by domain. Close tabs with a satisfying swoosh + confetti.

No server. No account. No external API calls. Just a Chrome extension.

---

## Install

**1. Clone the repo**

```bash
git clone https://github.com/yaonyan/v-tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## Features

- **Visual tab windows** — each tab is a mini browser window with a live screenshot preview
- **Window stack** — tabs from the same domain stack with a slight offset; hover to fan them out
- **Screenshot previews** — background tabs are captured via Chrome DevTools Protocol so you can see what each tab contains without switching to it
- **Homepages group** — Gmail, X, YouTube, LinkedIn, GitHub homepages pulled into one card
- **Close tabs with style** — swoosh sound + confetti burst
- **Duplicate detection** — flags when you have the same page open twice, with one-click cleanup
- **Click any window to jump to it** — across windows, no new tab opened
- **Save for later** — bookmark tabs to a checklist before closing them
- **Localhost grouping** — shows port numbers next to each tab so you can tell your projects apart
- **Expandable groups** — show the first 8 tabs with a clickable "+N more"
- **100% local** — your data never leaves your machine
- **Pure Chrome extension** — no server, no Node.js, no npm, no setup beyond loading the extension

---

## How it works

```
You open a new tab
  -> Tab Out captures screenshots of all your open tabs (via chrome.debugger)
  -> Shows them as stacked browser windows, grouped by domain
  -> Hover a stack to fan out all windows
  -> Click any window to jump to that tab
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere. Saved tabs are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Screenshots | Chrome DevTools Protocol (chrome.debugger) |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui), forked by [yaonyan](https://github.com/yaonyan)
