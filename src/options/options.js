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
  splitMode: "sidePanel",
};

const fields = [...document.querySelectorAll("[data-key]")];
const statusEl = document.getElementById("status");
let saveTimer = null;

function toUI(el, value) {
  if (el.type === "checkbox") el.checked = !!value;
  else if (el.tagName === "TEXTAREA") el.value = (value || []).join("\n");
  else el.value = value;
}

function fromUI(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range") return Number(el.value);
  if (el.tagName === "TEXTAREA") {
    return el.value
      .split("\n")
      .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
  }
  return el.value;
}

/* ─── Slider readouts ─────────────────────────────────────────────────── */
/*
 * A slider that only shows its own number tells you nothing you can feel, so
 * each one is rendered in the unit the gesture actually has: how far you have
 * to swipe, how long you have to wait.
 *
 * The swipe figures mirror peek-host.js — the panel travels pow(x, 0.86) * 1.6
 * for x pixels of swipe, and commits past 118px of panel travel divided by the
 * sensitivity.
 */
function travelFor(sensitivity) {
  const commitPx = 118 / sensitivity;
  return Math.round(Math.pow(commitPx / 1.6, 1 / 0.86));
}

// Keyed by setting rather than by element type: two ranges sharing one
// painter would have had the hold slider writing the swipe readout.
const READOUTS = {
  swipeSensitivity: (v) => {
    const n = Number(v) || 1;
    return { el: "sensOut", text: `${n.toFixed(1)}× · ${travelFor(n)} px` };
  },
  holdDelay: (v) => {
    const n = Number(v) || 450;
    return { el: "holdOut", text: `${(n / 1000).toFixed(2)}s` };
  },
};

function paintReadout(key, value) {
  const r = READOUTS[key]?.(value);
  if (!r) return;
  const node = document.getElementById(r.el);
  if (node) node.textContent = r.text;
}

/* ─── Load / save ─────────────────────────────────────────────────────── */

async function load() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const el of fields) toUI(el, s[el.dataset.key]);
  for (const key of Object.keys(READOUTS)) paintReadout(key, s[key]);
}

function flash(text) {
  statusEl.textContent = text;
  statusEl.dataset.on = "1";
  clearTimeout(flash._t);
  flash._t = setTimeout(() => (statusEl.dataset.on = "0"), 2600);
}

async function save() {
  const { settings } = await chrome.storage.sync.get("settings");
  const next = { ...DEFAULTS, ...(settings || {}) };
  for (const el of fields) next[el.dataset.key] = fromUI(el);
  await chrome.storage.sync.set({ settings: next });
  // Content scripts listen on storage.onChanged, so every live tab already has
  // this. The only thing that waits is anything built at Peek construction.
  flash("Saved — applies to your next Peek");
  checkStale();
}

for (const el of fields) {
  const evt = el.tagName === "TEXTAREA" || el.type === "range" ? "input" : "change";
  el.addEventListener(evt, () => {
    if (el.type === "range") paintReadout(el.dataset.key, el.value);
    clearTimeout(saveTimer);
    // Typing in the allowlist, or dragging the slider, shouldn't write on
    // every single event.
    saveTimer = setTimeout(save, el.tagName === "TEXTAREA" || el.type === "range" ? 300 : 0);
  });
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  await load();
  flash("Reset to defaults");
  checkStale();
});

/* ─── Tabs that predate the extension ─────────────────────────────────── */
/*
 * Settings themselves need no reload — content scripts pick them up through
 * storage.onChanged the instant they are written. What does need one is a tab
 * that was already open when Peek was installed or reloaded: it never got a
 * content script, so nothing in it will respond however the settings change.
 *
 * Rather than tell everyone to reload everything, ask each tab whether it is
 * listening and name only the ones that aren't.
 */

const staleBar = document.getElementById("stale");
const staleText = document.getElementById("staleText");
let staleIds = [];

async function findStale() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return [];
  }
  const results = await Promise.all(
    tabs.map(async (t) => {
      // A discarded tab has no script because it isn't running at all; it will
      // get one when it wakes, so it isn't stale in any sense worth reporting.
      if (t.discarded || t.status === "unloaded") return null;
      try {
        const r = await chrome.tabs.sendMessage(t.id, { type: "peek:ping" });
        return r?.ok ? null : t.id;
      } catch {
        return t.id;
      }
    })
  );
  return results.filter((id) => id !== null);
}

async function checkStale() {
  staleIds = await findStale();
  if (!staleIds.length) {
    staleBar.hidden = true;
    return;
  }
  const n = staleIds.length;
  staleBar.hidden = false;
  staleText.innerHTML =
    `<strong>${n} open ${n === 1 ? "tab was" : "tabs were"} loaded before Peek</strong>, ` +
    `so ${n === 1 ? "it has" : "they have"} no Peek in ${n === 1 ? "it" : "them"} at all — ` +
    `settings won't reach ${n === 1 ? "it" : "them"} until reloaded. ` +
    `Every other tab picks up changes immediately.`;
}

document.getElementById("reloadStale").addEventListener("click", async () => {
  const ids = staleIds.slice();
  for (const id of ids) {
    try {
      await chrome.tabs.reload(id);
    } catch {}
  }
  flash(`Reloaded ${ids.length} ${ids.length === 1 ? "tab" : "tabs"}`);
  setTimeout(checkStale, 1200);
});

/* ─── Shortcuts note ──────────────────────────────────────────────────── */

// The shortcuts page URL carries the browser's own scheme, which is not
// "chrome://" in every Chromium build.
(() => {
  const note = document.getElementById("shortcutNote");
  const scheme = (chrome.runtime.getURL("").match(/^(\w+)-extension:/) || [])[1];
  const base = location.protocol.startsWith("http") ? "chrome" : scheme || "chrome";
  note.textContent =
    `The three ⌥⇧ chords are browser-level commands — rebind them at ` +
    `${base}://extensions/shortcuts. Each does nothing, silently, until its ` +
    `condition is met: a link under the cursor, or a Peek already open. ` +
    `Everything above them is handled inside the Peek and is fixed.`;

  document.getElementById("ver").textContent = chrome.runtime.getManifest().version;
})();

load();
checkStale();
