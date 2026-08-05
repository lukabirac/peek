const DEFAULTS = {
  enabled: true,
  onPinnedTabs: true,
  modifier: "shift",
  peekNewTabLinks: true,
  prefetch: true,
  allowlist: [],
  reducedEffects: false,
  dismissOnSwipe: true,
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
  if (el.tagName === "TEXTAREA") {
    return el.value
      .split("\n")
      .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
  }
  return el.value;
}

async function load() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const el of fields) toUI(el, s[el.dataset.key]);
}

function flash(text) {
  statusEl.textContent = text;
  statusEl.dataset.on = "1";
  clearTimeout(flash._t);
  flash._t = setTimeout(() => (statusEl.dataset.on = "0"), 1400);
}

async function save() {
  const { settings } = await chrome.storage.sync.get("settings");
  const next = { ...DEFAULTS, ...(settings || {}) };
  for (const el of fields) next[el.dataset.key] = fromUI(el);
  await chrome.storage.sync.set({ settings: next });
  flash("Saved");
}

for (const el of fields) {
  const evt = el.tagName === "TEXTAREA" ? "input" : "change";
  el.addEventListener(evt, () => {
    clearTimeout(saveTimer);
    // Typing in the allowlist shouldn't write on every keystroke.
    saveTimer = setTimeout(save, el.tagName === "TEXTAREA" ? 400 : 0);
  });
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  await load();
  flash("Reset");
});

// The shortcuts page URL carries the browser's own scheme, which is not
// "chrome://" in every Chromium build.
(() => {
  const note = document.getElementById("shortcutNote");
  const scheme = (chrome.runtime.getURL("").match(/^(\w+)-extension:/) || [])[1];
  const base = location.protocol.startsWith("http") ? "chrome" : scheme || "chrome";
  note.textContent =
    `The three ⌥⇧ chords are browser-level commands — rebind them at ` +
    `${base}://extensions/shortcuts. Splitting is one of them because opening ` +
    `the side panel needs a keystroke the browser itself handed us; everything ` +
    `else is handled inside the Peek and is fixed.`;

  document.getElementById("ver").textContent = chrome.runtime.getManifest().version;
})();

load();
