/**
 * Peek — background service worker.
 *
 * Three jobs:
 *   1. tell each content script whether its tab is a peek context,
 *   2. make sites embeddable, narrowly and briefly, while a peek is open,
 *   3. own the actions that need browser APIs (promote, split, context menu).
 */

const DEFAULTS = {
  enabled: true,
  onPinnedTabs: true,
  modifier: "shift",
  peekNewTabLinks: true,
  prefetch: true,
  allowlist: [],
  blocklist: [],
  holdToPeek: true,
  holdDelay: 450,
  reducedEffects: false,
  dismissOnSwipe: true,
  swipeDirection: "right",
  naturalScrolling: true,
  swipeSensitivity: 1,
  splitMode: "sidePanel", // 'sidePanel' | 'window'
};

/* ─── Settings ────────────────────────────────────────────────────────── */

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

// The blocklist lives entirely in the content script: it only governs the
// automatic triggers, and every one of those is decided there. Nothing the
// worker initiates — the context menu, the ⌥⇧ commands — is automatic.

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await chrome.storage.sync.set({ settings: s });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "peek-link",
      title: "Peek Link",
      contexts: ["link"],
    });
  });
});

/* ─── Embeddability ───────────────────────────────────────────────────── */
/*
 * X-Frame-Options and CSP frame-ancestors exist to stop clickjacking, so we
 * suspend them as narrowly as the API allows: session-scoped rules, one tab,
 * sub_frame requests only, added when a peek is about to open and removed the
 * moment it closes. DNR can't rewrite a header value, only drop it, so the
 * whole CSP goes — which is why the rule's lifetime is kept this short.
 */

const armed = new Set();

// Session rules outlive the worker; a restart means any peek that owned them
// is long gone.
chrome.declarativeNetRequest.getSessionRules().then((rules) => {
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
  }
});

async function arm(tabId) {
  if (!tabId || armed.has(tabId)) return;
  armed.add(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: [
        {
          id: tabId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "x-frame-options", operation: "remove" },
              { header: "content-security-policy", operation: "remove" },
              { header: "content-security-policy-report-only", operation: "remove" },
            ],
          },
          condition: { tabIds: [tabId], resourceTypes: ["sub_frame"] },
        },
      ],
    });
  } catch (e) {
    armed.delete(tabId);
  }
}

async function disarm(tabId) {
  if (!tabId) return;
  armed.delete(tabId);
  // Unconditional: the worker can be torn down between arming and disarming,
  // and the rule outliving the peek is exactly what must never happen. The
  // in-memory set is an optimisation for arm(), not the source of truth.
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  } catch {}
}

/* ─── Messages ────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "peek:hello":
      getSettings().then((settings) => {
        reply({ settings, pinned: !!tab?.pinned, tabId: tab?.id ?? null });
      });
      return true;

    case "peek:arm":
      // Replied to only once the rule is live, so the caller can wait before
      // issuing the frame request it depends on.
      arm(tab?.id).then(() => reply({ armed: true }));
      return true;

    case "peek:disarm":
      disarm(tab?.id);
      return false;

    case "peek:promote":
      if (tab && msg.url) {
        chrome.tabs.create({
          url: msg.url,
          index: tab.index + 1,
          active: true,
          windowId: tab.windowId,
          openerTabId: tab.id,
        });
        disarm(tab.id);
      }
      return false;

    case "peek:open-tab":
      if (tab && msg.url) {
        chrome.tabs.create({
          url: msg.url,
          index: tab.index + 1,
          active: !!msg.active,
          windowId: tab.windowId,
          openerTabId: tab.id,
        });
      }
      return false;

    case "peek:split":
      if (tab && msg.url) {
        splitWith(tab, msg.url).then(() =>
          reply({ ok: true, sidePanelError: lastSidePanelError })
        );
        return true;
      }
      return false;

    case "peek:current":
      // Peek is showing this URL; stage the panel so a later split is instant.
      if (tab?.id && msg.url) stageSidePanel(tab.id, msg.url);
      return false;

    case "peek:panel-arm":
      // The panel waits on this before requesting its frame, the same way the
      // peek waits on peek:arm — the rule has to exist first or the site's
      // framing headers win the race.
      armSidePanel().then((ok) => reply({ armed: ok }));
      return true;

    case "peek:split-confirm":
      // Sent by the rail frame straight after it called sidePanel.open(). The
      // frame has no tab of its own, so it passes the id it was given.
      if (msg.url) stageSidePanel(msg.tabId ?? tab?.id, msg.url);
      return false;

    case "peek:diagnose":
      reply({
        nativeSplit: nativeSplitAvailable(),
        hasSidePanel: !!chrome.sidePanel,
        lastSidePanelError,
      });
      return true;
  }
});

/* ─── Split ───────────────────────────────────────────────────────────── */
/*
 * Aside has a real split view — it ships upstream Chromium's side-by-side
 * feature — but it is not reachable from an extension. The tabs API exposes
 * `splitViewId` read-only, and the only functions that create or manipulate a
 * split (`isActiveTabInSplit`, `swapWindowsInSplitView`) live in *Private
 * namespaces restricted to allowlisted internal extensions.
 *
 * So the default is the closest thing an extension can actually build: the
 * side panel — a resizable pane beside the page, inside the same window.
 * `splitMode: 'window'` restores the old tile-two-windows behaviour.
 *
 * sidePanel.open() needs live user activation, which exists in exactly two
 * places: inside the rail's extension frame (src/rail/split-button.js) and
 * inside a commands.onCommand handler. Both call open() themselves. Anything
 * that reaches splitWith() below has already missed that window, so it does
 * not try — it would only stall and then fail. It opens a tab beside instead.
 *
 * The feature detection below is deliberate: if a future Aside exposes a
 * split API, this starts using it with no other change.
 */

const SIDEPANEL_RULE_ID = 2147483640;

function nativeSplitAvailable() {
  return (
    typeof chrome.tabs?.split === "function" ||
    typeof globalThis.chrome?.splitView?.create === "function"
  );
}

async function splitWith(tab, url) {
  const { splitMode } = await getSettings();

  if (nativeSplitAvailable()) {
    try {
      const created = await chrome.tabs.create({
        url,
        index: tab.index + 1,
        active: true,
        windowId: tab.windowId,
        openerTabId: tab.id,
      });
      if (typeof chrome.tabs.split === "function") {
        await chrome.tabs.split({ tabIds: [tab.id, created.id] });
      } else {
        await chrome.splitView.create({ tabIds: [tab.id, created.id] });
      }
      return;
    } catch {
      /* fall through */
    }
  }

  if (splitMode === "window") return tileWindows(tab, url);

  // No activation to spend here — see the note above. Never rearrange the
  // user's windows unless they asked for that mode explicitly; just put the
  // page next to the tab it came from.
  await chrome.tabs.create({
    url,
    index: tab.index + 1,
    active: true,
    windowId: tab.windowId,
    openerTabId: tab.id,
  });
}

let lastSidePanelError = null;
const staged = new Map(); // tabId → url currently set as the panel's path

/**
 * Keep the panel's target URL current for every tab holding a peek, so that
 * opening it later costs nothing. This is the half that needs no gesture —
 * and it has to run ahead of the click, because the click itself has only
 * enough activation for open().
 *
 * Re-setting the same path would reload a panel that is already showing it,
 * so identical stages are dropped.
 */
async function stageSidePanel(tabId, url) {
  if (!chrome.sidePanel || !tabId || !url) return;
  if (staged.get(tabId) === url) return;
  staged.set(tabId, url);
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "src/sidepanel/panel.html?u=" + encodeURIComponent(url),
      enabled: true,
    });
  } catch (e) {
    staged.delete(tabId);
    lastSidePanelError = String(e?.message || e);
  }
}

/*
 * The panel's frame needs its own header rule: measured in Aside 150, a side
 * panel's sub_frame request is attributed to tab id -1, so the peek's own
 * per-tab rule does not cover it. Scoping by initiator is narrower and works
 * — the initiator origin is chrome-extension://<id>, and DNR accepts the
 * extension id as the domain — so that shape is preferred, with tabIds:[-1]
 * as the fallback for builds that reject it.
 */
async function armSidePanel() {
  const base = {
    id: SIDEPANEL_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
  };
  const shapes = [
    { ...base, condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ["sub_frame"] } },
    { ...base, condition: { tabIds: [-1], resourceTypes: ["sub_frame"] } },
  ];
  for (const rule of shapes) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SIDEPANEL_RULE_ID],
        addRules: [rule],
      });
      // updateSessionRules resolves even for a shape the engine ignores, so
      // confirm the rule is actually in the set before trusting it.
      const live = await chrome.declarativeNetRequest.getSessionRules();
      if (live.some((r) => r.id === SIDEPANEL_RULE_ID)) return true;
    } catch {
      /* try the next shape */
    }
  }
  return false;
}

async function disarmSidePanel() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SIDEPANEL_RULE_ID],
    });
  } catch {}
}

// The panel holds a port open for as long as it is on screen; the rule lives
// exactly as long as that port does.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "peek-sidepanel") return;
  port.onDisconnect.addListener(() => disarmSidePanel());
});

/** Legacy behaviour: halve this window and put the page in a new one beside it. */
async function tileWindows(tab, url) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    const left = win.left ?? 0;
    const top = win.top ?? 0;
    const width = win.width ?? 1440;
    const height = win.height ?? 900;
    const half = Math.floor(width / 2);

    if (win.state === "maximized" || win.state === "fullscreen") {
      await chrome.windows.update(tab.windowId, { state: "normal" });
    }
    await chrome.windows.update(tab.windowId, { left, top, width: half, height });
    await chrome.windows.create({
      url,
      left: left + half,
      top,
      width: width - half,
      height,
      focused: true,
    });
  } catch {
    chrome.tabs.create({ url, index: tab.index + 1, active: true });
  }
}

/* ─── Context menu ────────────────────────────────────────────────────── */

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "peek-link" || !tab?.id || !info.linkUrl) return;
  await arm(tab.id);
  chrome.tabs.sendMessage(tab.id, { type: "peek:open", url: info.linkUrl }).catch(() => {});
});

/* ─── Keyboard commands ───────────────────────────────────────────────── */

chrome.commands.onCommand.addListener(async (command, cmdTab) => {
  // A command listener carries user activation, but only for as long as the
  // synchronous run. sidePanel.open() therefore has to be the very first
  // thing we do — the panel's URL was staged when the peek opened.
  if (command === "split-peek") {
    const tabId = cmdTab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!tabId) return;
    try {
      await chrome.sidePanel.open({ tabId });
      chrome.tabs.sendMessage(tabId, { type: "peek:close" }).catch(() => {});
    } catch (e) {
      lastSidePanelError = String(e?.message || e);
    }
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "promote-peek") {
    chrome.tabs.sendMessage(tab.id, { type: "peek:promote-current" }).catch(() => {});
    return;
  }

  if (command === "peek-link") {
    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "peek:hovered" });
    } catch {}
    if (res?.url) {
      await arm(tab.id);
      chrome.tabs.sendMessage(tab.id, { type: "peek:open", url: res.url }).catch(() => {});
    }
  }
});

/* ─── Tab bookkeeping ─────────────────────────────────────────────────── */

chrome.tabs.onRemoved.addListener((tabId) => {
  disarm(tabId);
  staged.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Pinning is the trigger condition, so the content script needs to know
  // the moment it changes rather than on next load.
  if (changeInfo.pinned !== undefined) {
    chrome.tabs
      .sendMessage(tabId, { type: "peek:context", pinned: changeInfo.pinned })
      .catch(() => {});
  }
  // A top-level navigation always destroys any peek that was open.
  if (changeInfo.status === "loading" && changeInfo.url) disarm(tabId);
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
