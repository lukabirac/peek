# Peek

Arc's Peek, rebuilt as a Chromium extension. Click a link in a pinned tab and it
opens in a preview layer over the page instead of navigating your tab away.
Dismiss it and nothing changed. Promote it and it becomes a real tab.

![A Peek open over a page](docs/peek.png)

Built and verified against **Aside** (Chromium 150). Works in any Chromium
browser on Manifest V3.

---

## Contents

- [Install](#install)
- [Using it](#using-it)
  - [Opening a Peek](#opening-a-peek)
  - [The three buttons](#the-three-buttons)
  - [Split](#split)
  - [Keyboard](#keyboard)
- [Settings](#settings)
- [How it works](#how-it-works)
- [The security trade-off](#the-security-trade-off)
- [Where it departs from Arc, and why](#where-it-departs-from-arc-and-why)
- [Verified behaviour](#verified-behaviour)
- [Project layout](#project-layout)
- [Development](#development)

---

## Install

There is no build step. Clone the repo and load the folder.

```bash
git clone https://github.com/<you>/peek.git
cd peek
```

### Aside

```bash
open -a Aside "aside://extensions"
```

Turn on **Developer mode**, choose **Load unpacked**, and select this folder.

Aside runs with remote debugging on `:9222` by default, so you can also load it
without touching the UI:

```bash
node tools/install.mjs
```

That calls `Extensions.loadUnpacked` over the DevTools Protocol and prints the
extension id. Run it again after an edit to hot-reload — content scripts
re-inject on the next page load. It needs the browser-level debugging socket, so
it will not work while another client (an agent session, an attached debugger)
is holding it; use the **Reload** button on the extensions page in that case.

### Chrome, Edge, Brave, Dia, Comet

`chrome://extensions` → Developer mode → Load unpacked → this folder.

---

## Using it

Peek exists to make one thing cheap: looking at a link without committing to it.
The transient case is the default; persistence is the deliberate act.

### Opening a Peek

| Trigger | Default |
|---|---|
| Click a link in a **pinned tab** | on |
| **Shift-click** any link, anywhere | on |
| `target="_blank"` or `window.open()` from a pinned tab | on |
| Right-click → **Peek Link** | always |
| <kbd>⌥</kbd><kbd>⇧</kbd><kbd>P</kbd> — peek the link under the cursor | always |
| Any link on a site in your allowlist | off until you add one |

⌘-click, middle-click and sized popups keep their normal meaning. Same-page
anchors and download links are never peeked.

One Peek at a time, as in Arc. Opening another replaces it. Navigating inside a
Peek stays inside the Peek and never touches the tab's history.

While a page is still loading, the pane shows a single quiet ring — no progress
bar, no title, no chrome:

<img src="docs/peek-loading.png" alt="A Peek still loading" width="420">

### The three buttons

The only chrome in a Peek is a rail of three round buttons on the scrim, just
outside the pane's top-right corner.

<img src="docs/controls.png" alt="Close, Open as Tab, and Split with This Tab" width="320">

| | |
|---|---|
| **✕** | Close. Nothing about your session changed. |
| **⛶** | Open as Tab — promotes the Peek to a real tab, inserted right after the current one. |
| **▯▯** | Split with This Tab — puts the peeked page beside the tab it came from, in the same window. |

Clicking the scrim, pressing <kbd>Esc</kbd>, or swiping right also dismisses.
Back at the first page of a Peek's own history dismisses too, rather than
dead-ending on a disabled button.

### Split

Split sends the peeked page into Chromium's side panel — a resizable pane beside
the page, inside the same window — and closes the Peek.

<img src="docs/split-panel.png" alt="A peeked page in the side panel" width="380">

Aside and recent Chromium both ship a real side-by-side split, but **no extension
can start one**: `tabs.splitViewId` is exposed read-only, and the calls that
create or manipulate a split (`isActiveTabInSplit`, `swapWindowsInSplitView`)
live in `*Private` namespaces reserved for the browser's own components. The
side panel is the closest surface an extension is actually allowed to drive.

The button is the one control that is not part of the extension's shadow DOM.
`chrome.sidePanel.open()` may only be called in response to a user gesture, and a
gesture does not survive the hop from a content script to the service worker — by
the time the worker runs, the activation is spent. So the split button is a 30×30
`chrome-extension://` document layered into the rail: the click lands in a context
that genuinely holds activation, and `open()` is called directly in the handler.
See [`src/rail/split-button.js`](src/rail/split-button.js).

If the panel can't render a site, it says so rather than showing Chromium's
error page:

<img src="docs/split-blocked.png" alt="A site that refuses to be embedded" width="380">

`splitMode: "window"` in settings restores the older behaviour: halve the current
window and open the page in a new one beside it.

### Keyboard

Inside a Peek:

| | |
|---|---|
| <kbd>Esc</kbd> | Dismiss |
| <kbd>⌘</kbd><kbd>↩</kbd> | Open as a tab |
| <kbd>⌘</kbd><kbd>[</kbd> / <kbd>⌘</kbd><kbd>]</kbd> | Back / forward within the Peek's own history |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>C</kbd> | Copy the link |
| <kbd>⌘</kbd>-click a link inside the Peek | Escape it into a real tab |

Browser-level commands, rebindable at `chrome://extensions/shortcuts`:

| | |
|---|---|
| <kbd>⌥</kbd><kbd>⇧</kbd><kbd>P</kbd> | Peek the link under the cursor |
| <kbd>⌥</kbd><kbd>⇧</kbd><kbd>O</kbd> | Open the current Peek as a tab |
| <kbd>⌥</kbd><kbd>⇧</kbd><kbd>S</kbd> | Split the current Peek beside this tab |

Split is a browser-level command rather than an in-Peek chord for the same reason
the button is an extension frame: a `commands.onCommand` handler carries user
activation, and a keystroke the page handled does not.

---

## Settings

Click the toolbar icon, or `chrome://extensions` → Peek → Details → Extension
options.

![Peek settings, light and dark](docs/settings.png)

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Master switch. Off means links behave exactly as Chromium ships them. |
| `onPinnedTabs` | on | Clicks in a pinned tab peek instead of navigating. |
| `peekNewTabLinks` | on | Route `target="_blank"` and `window.open()` into a Peek. Sized popups — sign-in, payment — are left alone. |
| `modifier` | `shift` | Modifier that peeks any link on any page. `shift` \| `alt` \| `none`. |
| `allowlist` | `[]` | Hostnames treated like a pinned tab. Subdomains included. |
| `splitMode` | `sidePanel` | `sidePanel` (one window) or `window` (two tiled windows). |
| `prefetch` | on | Start loading on pointer-down rather than click. |
| `dismissOnSwipe` | on | Two-finger swipe right to dismiss, with rubber-banding and a fling threshold. |
| `reducedEffects` | off | Drop the backdrop blur. Worth it on integrated graphics. |

---

## How it works

```
src/content/peek-host.js        top frame: triggers, overlay, animation, history
src/content/peek-child.js       every frame: reports state up, runs commands down
src/content/peek-main-world.js  window.open() shim
src/content/peek-styles.js      the whole visual layer, as one stylesheet
src/rail/split-button.*         the split button, in its own extension document
src/sidepanel/panel.*           the split target
src/background/service-worker.js  tab context, header rules, promote / split
```

Five details carry most of the weight.

**Top layer, not z-index.** The overlay is a `<dialog>` opened with `showModal()`
inside a *closed* shadow root on a `<peek-root>` element appended to
`documentElement`. That puts it above anything the page can construct, makes the
page behind genuinely inert, and gives a real `::backdrop` to blur. No z-index
war, no style leakage in either direction. It hangs off `documentElement` rather
than `body` because pages transform `<body>` often enough that a fixed child
would get trapped in the wrong containing block.

**A child bridge, because cross-origin frames are opaque.** The host can't read
the peeked page's URL, title or history, and can't call `history.back()` on it.
So `peek-child.js` runs in every frame, stays completely silent until the host
addresses it by a per-Peek token, and then reports state upward and executes
navigation downward. The host rebuilds the Peek's session history from those
reports — which is what makes *back-at-root dismisses* possible, and what tells
the side panel whether a page actually rendered or whether it's looking at
Chromium's "refused to connect" document.

**Warming on pointer-down.** The Peek is built and the document starts loading on
mouse *down*, into a dialog that is `show()`n non-modally, fully transparent and
`inert`. By mouse *up* — roughly 100 ms later, plus the open animation — the page
has usually already painted, so revealing it is a compositor swap rather than a
first paint. The subtree has to opt out of hit-testing while priming, or the
invisible pane swallows the very mouseup that is supposed to trigger the Peek.

**Motion is a real spring.** Stiffness 260, damping 26, mass 1, solved offline and
baked into a CSS `linear()` easing with ~1.4% overshoot — enough to feel physical,
never enough to look bouncy. Opening grows from the point you clicked; closing is
the exact inverse and faster, because a cheap exit is what makes people willing to
open Peeks liberally.

**Activation is the whole story of the split button.** Covered
[above](#split) — it is the reason one 30×30 button lives in its own document.

---

## The security trade-off

Most sites send `X-Frame-Options` or a CSP `frame-ancestors` rule specifically to
stop being framed. Peek has to suspend those to show a preview at all.

It is scoped as tightly as the API allows: a **session** `declarativeNetRequest`
rule, conditioned on a **single tab id**, matching **`sub_frame` requests only**,
added when you press a peekable link and removed the moment the Peek closes.
Nothing is relaxed globally or persistently, the rule set is swept on
service-worker startup, and removal is unconditional so a worker restart between
arming and dismissal can't leave a rule live.

The side panel needs a second rule, because a side panel's sub-frame request is
attributed to tab id `-1` rather than to the tab it sits beside — the Peek's own
per-tab rule does not cover it. That rule is scoped by initiator to this
extension's own origin, is installed only while a panel is open, and is withdrawn
when the panel's port disconnects. The panel does not request its frame until the
rule is confirmed live, or the site's headers win the race.

The honest caveat: `declarativeNetRequest` can remove a header but not rewrite
one, so the site's **entire** `Content-Security-Policy` is dropped for that
window, not just its framing clause. That is a real reduction in the peeked
page's own XSS protections for the seconds it is on screen, and it is the reason
the arming window is kept as short as it is. If that trade isn't acceptable for
your threat model, this feature cannot be built as an extension.

Sites also behave differently framed than they do at the top level: third-party
cookie policy can log you out inside a Peek, and some apps detect framing in JS
and refuse to run. When a page can't be previewed, Peek says so and offers to open
it as a tab.

---

## Where it departs from Arc, and why

Arc's Peek leans on Arc-only furniture. Four things had to be re-grounded:

- **Favorites → pinned tabs + an allowlist.** Chromium has no Favorites, but it
  has pinned tabs, which carry the same "this tab is a place, don't navigate it"
  meaning. The allowlist covers sites you treat as pinned without pinning.
- **Library / archived tabs → context menu and keyboard command.** There is no
  Library to peek out of, so the entry points that remain are the ones a Chromium
  user actually has.
- **Space colour → nothing.** Arc tints Peek with the current Space's colour.
  There are no Spaces, and the redesigned Peek has no chrome left to tint, so the
  layer is monochrome by intent — it exists to show somebody else's page without
  editorialising.
- **Split View → the side panel.** Chromium's real split is closed to extensions,
  so the side panel is the substitute. Same window, resizable, side by side.

Deliberately not built: Little Arc and Instant Links, as scoped.

---

## Verified behaviour

Exercised end-to-end in Aside (Chrome/150.0.7871.183) over the DevTools Protocol
and the Aside REPL, against `tools/harness.html`:

- peek from a pinned tab, with the host tab left untouched
- a site sending `x-frame-options: deny` embeds correctly — the header rule works
- title and favicon cross the origin boundary; `about:blank` is never recorded as
  a history entry
- <kbd>Esc</kbd> from inside the peeked page dismisses it
- promote inserts the tab immediately after the host tab and activates it
- `target="_blank"` and `window.open()` both route into a Peek
- navigating inside the Peek advances its own stack; back returns; back at the
  root dismisses
- same-page anchors and download links are not peeked
- **split**: the rail frame reports `ready`, and a click opens the side panel with
  the peeked URL in **~600–750 ms**, in the same window, with the Peek closing
  behind it
- both a frameable site (Wikipedia) and a framing-denied one (GitHub) render in
  the panel; with the panel rule removed, the framing-denied site falls back to
  the "won't load here / Open as Tab" state rather than an error page
- the session rule set is **empty at rest**, holds exactly one tab-scoped rule
  while a Peek is open, and exactly one initiator-scoped rule while the panel is
  open

Measured, not assumed: `sidePanel.open({tabId})` **resolves without opening**
when the target tab is not its window's active tab. That is correct for real use
— the Peek is always in the active tab — but it will silently no-op any test
harness that brings a tab to front without activating it.

---

## Project layout

```
manifest.json                 MV3 manifest
src/background/               service worker
src/content/                  content scripts (host, child, main-world shim, styles, icons)
src/rail/                     the split button's extension document
src/sidepanel/                the split target
src/options/                  settings page
src/icons/                    toolbar icons
tools/install.mjs             CDP hot-reload installer
tools/make-icons.py           regenerates src/icons/*.png
tools/harness.html            test fixture
docs/                         screenshots used by this README
```

## Development

```bash
node --check src/content/peek-host.js   # no build step; syntax-check directly
node tools/install.mjs                  # hot-reload into Aside
python3 -m http.server 7391 --bind 127.0.0.1 --directory tools   # test fixture
python3 tools/make-icons.py             # regenerate icons
```

The stylesheet lives inside a JS template literal in `peek-styles.js` so it can be
injected into a closed shadow root with no extra fetch. Backticks inside CSS
comments will break the file — `node --check` catches it.
